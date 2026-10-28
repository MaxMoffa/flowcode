//! Flowcode-managed installs of the ACP adapters chat mode runs (Claude's and
//! Codex's are npm packages). `npx -y <pkg>` costs ~1s per start even warm and
//! re-downloads the package (with its ~240 MB native dependency) whenever the
//! adapter publishes, which is nearly daily: right when the user opens a chat.
//! So each adapter is installed once under the app's data dir, started with
//! `node <entry>`, and updated in the background.
//!
//! Layout: `<root>/<version>/` (an `npm install --prefix`), `<root>/current.json`
//! (`{ "version", "entry" }`) and `<root>/checked` (its mtime throttles updates).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

/// How long a version check stays valid before another one runs.
const CHECK_EVERY: Duration = Duration::from_secs(12 * 60 * 60);
const VIEW_TIMEOUT: Duration = Duration::from_secs(30);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// The npm package behind an agent's adapter (`None`: it has its own binary).
pub(crate) fn package(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("@agentclientprotocol/claude-agent-acp"),
        "codex" => Some("@agentclientprotocol/codex-acp"),
        _ => None,
    }
}

fn root(app: &AppHandle, agent: &str) -> Option<PathBuf> {
    Some(app.path().app_local_data_dir().ok()?.join("acp-adapters").join(agent))
}

/// The installed adapter's script, if one is installed and still on disk.
pub(crate) fn installed_entry(app: &AppHandle, agent: &str) -> Option<PathBuf> {
    let (_, entry) = read_current(&root(app, agent)?)?;
    entry.is_file().then_some(entry)
}

fn read_current(root: &Path) -> Option<(String, PathBuf)> {
    let json: Value = serde_json::from_str(&std::fs::read_to_string(root.join("current.json")).ok()?).ok()?;
    Some((json.get("version")?.as_str()?.to_string(), PathBuf::from(json.get("entry")?.as_str()?)))
}

/// Which agents have a refresh running, so two never install into one folder.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

struct RunningGuard(String);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        crate::util::lock(running()).remove(&self.0);
    }
}

/// Looks for a newer adapter version on a thread of its own and installs it,
/// at most every 12 hours. Failures (no npm, offline...) are only logged: the
/// installed version, or the `npx` fallback, keeps working.
pub(crate) fn refresh_in_background(app: &AppHandle, agent: &str) {
    let Some(pkg) = package(agent) else { return };
    let Some(root) = root(app, agent) else { return };
    if !crate::util::lock(running()).insert(agent.to_string()) {
        return;
    }
    let guard = RunningGuard(agent.to_string());
    std::thread::spawn(move || {
        let _guard = guard;
        if let Err(e) = refresh(&root, pkg) {
            eprintln!("acp adapter {pkg}: {e}");
        }
    });
}

fn refresh(root: &Path, pkg: &str) -> Result<(), String> {
    let checked = root.join("checked");
    let fresh = std::fs::metadata(&checked)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < CHECK_EVERY);
    if fresh {
        return Ok(());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    std::fs::write(&checked, "").map_err(|e| e.to_string())?;

    let latest = run_npm(&["view", pkg, "version"], VIEW_TIMEOUT)?.trim().to_string();
    // The version names a folder: refuse anything that isn't a plain version.
    if latest.is_empty() || !latest.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')) {
        return Err(format!("unexpected version `{latest}`"));
    }
    let current = read_current(root);
    if current.as_ref().is_some_and(|(v, entry)| *v == latest && entry.is_file()) {
        return Ok(());
    }

    // Into a `.tmp` folder first, so a half-done install is never used.
    let tmp = root.join(format!("{latest}.tmp"));
    let dir = root.join(&latest);
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let installed = install(&tmp, pkg, &latest).and_then(|()| {
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&tmp, &dir).map_err(|e| e.to_string())
    });
    if let Err(e) = installed {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    let entry = package_entry(&dir, pkg)?;

    let record = json!({ "version": latest, "entry": entry.to_string_lossy() });
    let pending = root.join("current.json.tmp");
    std::fs::write(&pending, record.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&pending, root.join("current.json")).map_err(|e| e.to_string())?;

    // Keep the new version and the previous one (a running chat may still use it).
    let keep = [Some(latest), current.map(|(v, _)| v)];
    if let Ok(entries) = std::fs::read_dir(root) {
        for path in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if !keep.iter().flatten().any(|k| k == name) {
                let _ = std::fs::remove_dir_all(&path);
            }
        }
    }
    Ok(())
}

fn install(dir: &Path, pkg: &str, version: &str) -> Result<(), String> {
    let prefix = dir.to_string_lossy().into_owned();
    let spec = format!("{pkg}@{version}");
    run_npm(
        &["install", "--prefix", &prefix, &spec, "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error"],
        INSTALL_TIMEOUT,
    )
    .map(drop)
}

/// The package's script, from the `bin` of its package.json (a path, or a map
/// of names to paths: the first one).
fn package_entry(dir: &Path, pkg: &str) -> Result<PathBuf, String> {
    let package_dir = dir.join("node_modules").join(pkg);
    let json: Value = serde_json::from_str(&std::fs::read_to_string(package_dir.join("package.json")).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let bin = match json.get("bin") {
        Some(Value::String(s)) => Some(s.as_str()),
        Some(Value::Object(map)) => map.values().find_map(Value::as_str),
        _ => None,
    }
    .ok_or_else(|| format!("{pkg} declares no bin"))?;
    let entry = package_dir.join(bin);
    if entry.is_file() {
        Ok(entry)
    } else {
        Err(format!("{} is missing", entry.display()))
    }
}

/// Runs `npm <args>` and returns its stdout; killed after `timeout`. Through
/// cmd on Windows so npm's `.cmd` shim resolves.
fn run_npm(args: &[&str], timeout: Duration) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg("npm").args(args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(args);
        cmd
    };
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start npm: {e}"))?;
    // Drained on threads so a chatty npm never blocks on a full pipe.
    fn drain(pipe: Option<impl std::io::Read + Send + 'static>) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    }
    let out_thread = drain(child.stdout.take());
    let err_thread = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                // The readers are left behind: a grandchild may hold the pipes open.
                let _ = child.kill();
                return Err(format!("npm {} timed out", args.first().unwrap_or(&"")));
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let stdout = out_thread.join().unwrap_or_default();
    let stderr = err_thread.join().unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        Err(format!("npm {} failed: {}", args.first().unwrap_or(&""), stderr.trim()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_npm_adapters_have_a_package() {
        assert_eq!(package("claude"), Some("@agentclientprotocol/claude-agent-acp"));
        assert!(package("vibe").is_none());
    }

    #[test]
    fn resolves_the_bin_entry() {
        let dir = std::env::temp_dir().join(format!("flowcode-adapter-test-{}", std::process::id()));
        let pkg_dir = dir.join("node_modules/@scope/pkg");
        std::fs::create_dir_all(pkg_dir.join("dist")).unwrap();
        std::fs::write(pkg_dir.join("dist/index.js"), "").unwrap();
        std::fs::write(pkg_dir.join("package.json"), r#"{"bin":{"pkg":"dist/index.js"}}"#).unwrap();
        assert_eq!(package_entry(&dir, "@scope/pkg").unwrap(), pkg_dir.join("dist/index.js"));
        std::fs::write(pkg_dir.join("package.json"), r#"{"bin":"dist/index.js"}"#).unwrap();
        assert!(package_entry(&dir, "@scope/pkg").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
