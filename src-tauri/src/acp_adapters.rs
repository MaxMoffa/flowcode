//! Flowcode-managed installs of the ACP adapters chat mode runs (Claude's and
//! Codex's are npm packages). `npx -y <pkg>` costs ~1s per start even warm and
//! re-downloads the package (with its ~240 MB native dependency) whenever the
//! adapter publishes, which is nearly daily: right when the user opens a chat.
//! So each release pins its adapters, installs them under the app's data dir,
//! and starts them with `node <entry>`.
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
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const MAX_COMMAND_OUTPUT: usize = 1024 * 1024;

/// Versions verified with this release; updates require another reviewed pin.
pub(crate) fn package_spec(agent: &str) -> Option<&'static str> {
    match agent {
        "claude" => Some("@agentclientprotocol/claude-agent-acp@0.101.0"),
        "codex" => Some("@agentclientprotocol/codex-acp@2.5.0"),
        _ => None,
    }
}

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
    let (version, entry) = read_current(&root(app, agent)?)?;
    (version == pinned_version(package(agent)?).ok()? && entry.is_file()).then_some(entry)
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

/// Ensures the pinned adapter is installed on a thread of its own,
/// at most every 12 hours after success. Failures are only logged: the
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
    let latest = pinned_version(pkg)?.to_string();
    let current = read_current(root);
    let fresh = std::fs::metadata(&checked)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age < CHECK_EVERY);
    if fresh && current.as_ref().is_some_and(|(v, entry)| *v == latest && entry.is_file()) {
        return Ok(());
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    if current.as_ref().is_some_and(|(v, entry)| *v == latest && entry.is_file()) {
        std::fs::write(&checked, "").map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Into a `.tmp` folder first, so a half-done install is never used.
    let tmp = root.join(format!("{latest}.tmp"));
    let dir = root.join(&latest);
    // Published versions are immutable: a live chat can still import their files.
    if package_entry(&dir, pkg).is_err() {
        if dir.exists() {
            return Err(format!("{} is incomplete; refusing to replace a possibly active adapter", dir.display()));
        }
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        if let Err(e) = install(&tmp, pkg, &latest).and_then(|()| package_entry(&tmp, pkg).map(drop))
            .and_then(|()| std::fs::rename(&tmp, &dir).map_err(|e| e.to_string()))
        {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    }
    let entry = package_entry(&dir, pkg)?;

    let record = json!({ "version": latest, "entry": entry.to_string_lossy() });
    let pending = root.join("current.json.tmp");
    std::fs::write(&pending, record.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&pending, root.join("current.json")).map_err(|e| e.to_string())?;

    // A release pin bounds new installs; old versions stay available to live chats.
    std::fs::write(&checked, "").map_err(|e| e.to_string())?;
    Ok(())
}

fn pinned_version(pkg: &str) -> Result<&'static str, String> {
    ["claude", "codex"].into_iter().find(|agent| package(agent) == Some(pkg))
        .and_then(package_spec).and_then(|spec| spec.rsplit_once('@').map(|(_, version)| version))
        .ok_or_else(|| format!("unrecognized adapter package `{pkg}`"))
}

fn install(dir: &Path, pkg: &str, version: &str) -> Result<(), String> {
    let prefix = dir.to_string_lossy().into_owned();
    let spec = format!("{pkg}@{version}");
    run_npm(
        dir,
        &["install", "--prefix", &prefix, &spec, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", "--loglevel=error"],
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
    if Path::new(bin).is_absolute() || Path::new(bin).components().any(|component| !matches!(component, std::path::Component::Normal(_) | std::path::Component::CurDir)) {
        return Err(format!("{pkg} declares an unsafe bin path"));
    }
    let entry = package_dir.join(bin);
    if entry.is_file() {
        Ok(entry)
    } else {
        Err(format!("{} is missing", entry.display()))
    }
}

/// Runs `npm <args>` and returns its stdout; killed after `timeout`. Through
/// cmd on Windows so npm's `.cmd` shim resolves.
fn run_npm(dir: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.args(["/D", "/C", "npm"]).args(args);
        cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut cmd = Command::new("npm");
        cmd.args(args);
        cmd
    };
    cmd.current_dir(dir);
    run_with_timeout(cmd, &format!("npm {}", args.first().unwrap_or(&"")), timeout)
}

/// Owns this command's descendants even when taskkill is unavailable.
#[cfg(target_os = "windows")]
struct CommandJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(target_os = "windows")]
impl CommandJob {
    fn new(child: &std::process::Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
            JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return None; }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                CloseHandle(job);
                return None;
            }
            Some(Self(job))
        }
    }
}

#[cfg(target_os = "windows")]
impl Drop for CommandJob {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0); }
    }
}

/// Runs `cmd` (stdin closed) and returns its stdout; killed after `timeout`.
/// `label` names it in errors.
fn run_with_timeout(mut cmd: Command, label: &str, timeout: Duration) -> Result<String, String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {label}: {e}"))?;
    #[cfg(target_os = "windows")]
    let job = CommandJob::new(&child);
    // Drained on threads so a chatty npm never blocks on a full pipe.
    fn drain(pipe: Option<impl std::io::Read + Send + 'static>) -> std::sync::mpsc::Receiver<String> {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            bytes.extend_from_slice(&chunk[..n]);
                            if bytes.len() > MAX_COMMAND_OUTPUT {
                                bytes.drain(..bytes.len() - MAX_COMMAND_OUTPUT);
                            }
                        }
                    }
                }
            }
            let _ = tx.send(String::from_utf8_lossy(&bytes).into_owned());
        });
        rx
    }
    let out_thread = drain(child.stdout.take());
    let err_thread = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            Ok(None) => {
                #[cfg(target_os = "windows")]
                drop(job);
                crate::chat::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{label} timed out"));
            }
            Err(e) => {
                #[cfg(target_os = "windows")]
                drop(job);
                crate::chat::kill_tree(child.id());
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    };
    // A detached descendant can inherit a pipe; never join an unbounded reader.
    let readers_deadline = Instant::now() + Duration::from_millis(500);
    let stdout = out_thread.recv_timeout(readers_deadline.saturating_duration_since(Instant::now())).unwrap_or_default();
    let stderr = err_thread.recv_timeout(readers_deadline.saturating_duration_since(Instant::now())).unwrap_or_default();
    if status.success() {
        Ok(stdout)
    } else {
        Err(format!("{label} failed: {}", stderr.trim()))
    }
}

/// The refresh of a managed adapter inside a WSL distro, run by `bash -lc`
/// (the Windows-side `refresh` ported to shell, with the same layout under
/// `~/.local/share/flowcode/acp-adapters/<agent>`; `current` holds the entry's
/// path). `{agent}` and `{pkg}` are filled in by `wsl_refresh_script`.
const WSL_REFRESH_SCRIPT: &str = r#"set -e
d="$HOME/.local/share/flowcode/acp-adapters/{agent}"
mkdir -p "$d"
cd "$d"
v="{version}"
case "$v" in ''|*[!A-Za-z0-9.+-]*) echo "unexpected version $v" >&2; exit 1;; esac
cur=$(cat "$d/current" 2>/dev/null || true)
case "$cur" in "$d/$v/"*) if [ -f "$cur" ]; then touch "$d/checked"; exit 0; fi;; esac
rm -rf "$d/$v.tmp"
if [ ! -d "$d/$v" ]; then
  npm install --prefix "$d/$v.tmp" "{pkg}@$v" --ignore-scripts --no-audit --no-fund --omit=dev --loglevel=error || { rm -rf "$d/$v.tmp"; exit 1; }
  mv "$d/$v.tmp" "$d/$v"
fi
p="$d/$v/node_modules/{pkg}"
b=$(node -e 'const p=require("node:path"),b=require(process.argv[1]).bin,s=typeof b==="string"?b:Object.values(b||{})[0];if(!s||p.isAbsolute(s)||s.split(/[\\/]/).includes(".."))process.exit(1);process.stdout.write(s)' "$p/package.json")
[ -f "$p/$b" ]
printf '%s' "$p/$b" > "$d/current.tmp"
mv "$d/current.tmp" "$d/current"
touch "$d/checked"
"#;

fn wsl_refresh_script(agent: &str, pkg: &str) -> String {
    WSL_REFRESH_SCRIPT.replace("{agent}", agent).replace("{pkg}", pkg).replace("{version}", pinned_version(pkg).expect("known adapter package"))
}

/// `refresh_in_background` for a chat running inside WSL: the adapter is
/// installed in the distro itself (a Windows install can't run there). Same
/// 12-hour throttle, kept in the distro. No-op off Windows.
pub(crate) fn refresh_wsl_in_background(distro: Option<String>, agent: &str) {
    #[cfg(target_os = "windows")]
    {
        let Some(pkg) = package(agent) else { return };
        let key = format!("wsl:{}:{agent}", distro.as_deref().unwrap_or(""));
        // Starting `wsl.exe` costs a bash login: throttle successful checks only.
        static LAST: OnceLock<Mutex<std::collections::HashMap<String, Instant>>> = OnceLock::new();
        {
            let last = crate::util::lock(LAST.get_or_init(Default::default));
            if last.get(&key).is_some_and(|at| at.elapsed() < Duration::from_secs(3600)) {
                return;
            }
        }
        if !crate::util::lock(running()).insert(key.clone()) {
            return;
        }
        let guard = RunningGuard(key.clone());
        let script = wsl_refresh_script(agent, pkg);
        std::thread::spawn(move || {
            let _guard = guard;
            let mut cmd = Command::new("wsl.exe");
            if let Some(distro) = &distro {
                cmd.arg("-d").arg(distro);
            }
            // Linux timeout owns the process group and fires before the Windows timeout.
            cmd.args(["--exec", "timeout", "--kill-after=3s", "880s", "bash", "-lc"]).arg(script).creation_flags(CREATE_NO_WINDOW);
            if let Err(e) = run_with_timeout(cmd, "wsl adapter refresh", INSTALL_TIMEOUT) {
                eprintln!("acp adapter {pkg} (wsl): {e}");
            } else {
                crate::util::lock(LAST.get_or_init(Default::default)).insert(key, Instant::now());
            }
        });
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (distro, agent);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_npm_adapters_have_a_package() {
        assert_eq!(package("claude"), Some("@agentclientprotocol/claude-agent-acp"));
        assert!(package("vibe").is_none());
        assert_eq!(pinned_version(package("claude").unwrap()).unwrap(), "0.101.0");
        assert_eq!(pinned_version(package("codex").unwrap()).unwrap(), "2.5.0");
        assert!(package_spec("vibe").is_none());
        assert!(pinned_version("@unknown/pkg").is_err());
    }

    #[test]
    fn wsl_refresh_script_has_no_placeholders_left() {
        let script = wsl_refresh_script("claude", "@agentclientprotocol/claude-agent-acp");
        assert!(!script.contains("{agent}") && !script.contains("{pkg}") && !script.contains("{version}"));
        assert!(script.contains("acp-adapters/claude\"") && script.contains("@agentclientprotocol/claude-agent-acp@$v"));
        assert!(script.contains("--ignore-scripts") && script.contains("v=\"0.101.0\""));
        assert!(!script.contains("npm view") && !script.contains("rm -rf \"$d/$v\""));
    }

    #[test]
    fn resolves_the_bin_entry() {
        let dir = std::env::temp_dir().join(format!("flowcode-adapter-test-{}", uuid::Uuid::new_v4()));
        let pkg_dir = dir.join("node_modules/@scope/pkg");
        std::fs::create_dir_all(pkg_dir.join("dist")).unwrap();
        std::fs::write(pkg_dir.join("dist/index.js"), "").unwrap();
        std::fs::write(pkg_dir.join("package.json"), r#"{"bin":{"pkg":"dist/index.js"}}"#).unwrap();
        assert_eq!(package_entry(&dir, "@scope/pkg").unwrap(), pkg_dir.join("dist/index.js"));
        std::fs::write(pkg_dir.join("package.json"), r#"{"bin":"dist/index.js"}"#).unwrap();
        assert!(package_entry(&dir, "@scope/pkg").is_ok());
        std::fs::write(pkg_dir.join("package.json"), r#"{"bin":"../escape.js"}"#).unwrap();
        assert!(package_entry(&dir, "@scope/pkg").unwrap_err().contains("unsafe bin path"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reuses_an_existing_pin_and_preserves_other_versions() {
        let root = std::env::temp_dir().join(format!("flowcode-adapter-refresh-{}", uuid::Uuid::new_v4()));
        let pkg = package("claude").unwrap();
        let version = pinned_version(pkg).unwrap();
        let package_dir = root.join(version).join("node_modules").join(pkg);
        std::fs::create_dir_all(package_dir.join("dist")).unwrap();
        std::fs::write(package_dir.join("package.json"), r#"{"bin":"dist/index.js"}"#).unwrap();
        std::fs::write(package_dir.join("dist/index.js"), "").unwrap();
        let old = root.join("0.1.0/active.js");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, "still active").unwrap();
        refresh(&root, pkg).unwrap();
        assert!(root.join("checked").is_file());
        assert_eq!(read_current(&root).unwrap().0, version);
        assert!(old.is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_incomplete_version_is_not_overwritten_or_cached_as_success() {
        let root = std::env::temp_dir().join(format!("flowcode-adapter-incomplete-{}", uuid::Uuid::new_v4()));
        let pkg = package("claude").unwrap();
        let version = root.join(pinned_version(pkg).unwrap());
        std::fs::create_dir_all(&version).unwrap();
        std::fs::write(version.join("possibly-in-use"), "").unwrap();
        assert!(refresh(&root, pkg).is_err());
        assert!(!root.join("checked").exists());
        assert!(version.join("possibly-in-use").is_file());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn command_timeout_stops_descendants_before_they_can_write() {
        let marker = std::env::temp_dir().join(format!("flowcode-adapter-timeout-{}", uuid::Uuid::new_v4()));
        #[cfg(target_os = "windows")]
        let mut command = {
            let mut command = Command::new("cmd.exe");
            let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into())).join("System32/WindowsPowerShell/v1.0/powershell.exe");
            command.args(["/D", "/C"]).arg(powershell).args(["-NoProfile", "-Command", "Start-Sleep -Milliseconds 1000; [IO.File]::WriteAllText($env:FLOWCODE_TIMEOUT_TEST_FILE, 'orphan')"]);
            command.creation_flags(CREATE_NO_WINDOW);
            command
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "sleep 1; printf orphan > \"$FLOWCODE_TIMEOUT_TEST_FILE\""]);
            command
        };
        command.env("FLOWCODE_TIMEOUT_TEST_FILE", &marker);
        let result = run_with_timeout(command, "test descendant", Duration::from_millis(100));
        assert!(matches!(&result, Err(error) if error.contains("timed out")), "{result:?}");
        std::thread::sleep(Duration::from_millis(1200));
        let survived = marker.exists();
        let _ = std::fs::remove_file(marker);
        assert!(!survived, "a descendant kept running after the timeout");
    }
}
