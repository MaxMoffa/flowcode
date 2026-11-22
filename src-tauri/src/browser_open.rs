//! Browser opens that come from agent processes (a dev server's auto-open, `xdg-open`,
//! Python's `webbrowser`...) go through Flowcode, so the user's Browser settings decide
//! where a page opens instead of it landing in the system browser too.
//!
//! Three pieces:
//! - a hidden mode of the executable (`flowcode --flowcode-open <url|file> [ignored args]`,
//!   also when the executable is run under the name `flowcode-open`): it asks the running app
//!   to `open_in_browser`, through the MCP request-file protocol with the tab's or chat's own
//!   token, and opens with the system default when the app does not answer, so an open is
//!   never lost;
//! - the environment of the agent's process (`native_env`): `BROWSER`, `FLOWCODE_OPEN_EXE` and a
//!   PATH folder of shims;
//! - the shims (`open-shim/open-shim.sh`, written under the names of the usual openers). WSL
//!   tabs and chats get the same script in their own shim folder (`terminal_mcp.rs`).
//!
//! Known gaps, which no shim can reach: PowerShell `Start-Process`, cmd's builtin `start` and
//! `explorer.exe <url>` run outside any PATH lookup of ours (Git Bash's `start`/`open`/`xdg-open`
//! are covered).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub(crate) const ARGUMENT: &str = "--flowcode-open";
/// The executable's file name (without extension) that switches the hidden mode on by itself: a copy
/// of Flowcode that tools can run as `BROWSER` with nothing but the URL (Python's `webbrowser` starts
/// a `.cmd` through cmd.exe, which would cut a URL at its first `&`).
const COPY_STEM: &str = "flowcode-open";
/// How long to wait for the app before opening with the system default.
const ANSWER_WITHIN: Duration = Duration::from_millis(4000);
const SHIM_SCRIPT: &str = include_str!("open-shim/open-shim.sh");
/// Folders of ours a system opener lookup must not find (they hold the shims).
#[cfg(any(unix, test))]
const OWN_DIRS: [&str; 2] = ["open-shim", "provider-launch"];

/// The names the shim script is written under, per platform, in the shim folder of native tabs and chats.
#[cfg(windows)]
const NATIVE_NAMES: &[&str] = &["xdg-open", "open", "start"];
#[cfg(target_os = "macos")]
const NATIVE_NAMES: &[&str] = &["open"];
#[cfg(all(unix, not(target_os = "macos")))]
const NATIVE_NAMES: &[&str] = &["xdg-open", "sensible-browser", "www-browser", "x-www-browser"];

/// The names for WSL's shim folder (`terminal_mcp.rs`); `flowcode-open` is what BROWSER points to.
pub(crate) const WSL_NAMES: &[&str] = &["flowcode-open", "xdg-open", "open", "wslview", "sensible-browser", "www-browser", "x-www-browser"];

/// The shim script with LF endings (a Windows checkout may have made it CRLF; sh would choke).
pub(crate) fn shim_script() -> String {
    SHIM_SCRIPT.replace("\r\n", "\n")
}

fn is_http(text: &str) -> bool {
    let lower = text.get(..8).unwrap_or(text).to_ascii_lowercase();
    (lower.starts_with("http://") || lower.starts_with("https://")) && !text.chars().any(|c| c.is_control() || c.is_whitespace())
}

/// What to open among the arguments a tool passes its browser: the first one that is an http(s)
/// URL or an existing file. Flags and whatever else a tool appends are ignored, and the quotes
/// some launchers (Node's `open`, through PowerShell) leave around the URL are taken off.
pub(crate) fn pick_target(args: &[String], cwd: &Path) -> Option<String> {
    for arg in args {
        let text = arg.trim().trim_matches(['"', '\'']);
        if text.is_empty() || text.starts_with('-') {
            continue;
        }
        if is_http(text) {
            return Some(text.to_string());
        }
        if text.chars().any(char::is_control) {
            continue;
        }
        let path = Path::new(text);
        let full = if path.is_absolute() { path.to_path_buf() } else { cwd.join(path) };
        if full.is_file() {
            return Some(full.to_string_lossy().into_owned());
        }
    }
    None
}

/// Whether the hidden mode was asked for, and with which arguments.
fn requested(args: &[OsString], exe_stem: Option<&str>) -> Option<Vec<String>> {
    let rest: &[OsString] = if exe_stem.is_some_and(|stem| stem.eq_ignore_ascii_case(COPY_STEM)) {
        args
    } else if args.first().is_some_and(|a| a == ARGUMENT) {
        &args[1..]
    } else {
        return None;
    };
    Some(rest.iter().map(|a| a.to_string_lossy().into_owned()).collect())
}

/// Runs before Tauri starts, like `provider_launcher::run_if_requested`: it never reaches the
/// single-instance plugin, and a release build has no console to show.
pub fn run_if_requested() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let stem = std::env::current_exe().ok().and_then(|exe| exe.file_stem().map(|s| s.to_string_lossy().into_owned()));
    let Some(args) = requested(&args, stem.as_deref()) else { return };
    let cwd = std::env::current_dir().unwrap_or_default();
    let Some(target) = pick_target(&args, &cwd) else { std::process::exit(2) };
    let routed = match (std::env::var("FLOWCODE_MCP_DIR"), std::env::var("FLOWCODE_MCP_TOKEN")) {
        (Ok(dir), Ok(token)) if !dir.is_empty() && !token.is_empty() => ask_app(Path::new(&dir), &token, &target, &cwd, ANSWER_WITHIN),
        _ => false,
    };
    if routed || system_open(&target) {
        std::process::exit(0);
    }
    std::process::exit(1);
}

/// The request file `flowcode-mcp.cjs` would write for an `open_in_browser` call (same names, same
/// atomic rename), then waits for the answer file. `true` when the app opened or accepted the target.
fn ask_app(dir: &Path, token: &str, target: &str, cwd: &Path, within: Duration) -> bool {
    let id = uuid::Uuid::new_v4().to_string();
    let (request, response) = (dir.join(format!("req-{id}.json")), dir.join(format!("res-{id}.json")));
    let tmp = dir.join(format!("req-{id}.json.tmp"));
    let body = json!({
        "id": id, "token": token, "tool": "open_in_browser", "args": { "target": target },
        "timeout_ms": within.as_millis() as u64, "cwd": cwd.to_string_lossy(),
    });
    if std::fs::write(&tmp, body.to_string()).and_then(|()| std::fs::rename(&tmp, &request)).is_err() {
        let _ = std::fs::remove_file(&tmp);
        return false;
    }
    let started = Instant::now();
    while started.elapsed() < within {
        std::thread::sleep(Duration::from_millis(100));
        let Ok(text) = std::fs::read_to_string(&response) else { continue };
        let Ok(answer) = serde_json::from_str::<Value>(&text) else { continue };
        let _ = std::fs::remove_file(&response);
        return answer.get("ok").and_then(Value::as_bool) == Some(true);
    }
    let _ = std::fs::remove_file(&request);
    false
}

/// `dir` is one of ours (a shim folder), which a lookup of the real opener must skip.
#[cfg(any(unix, test))]
fn is_own_dir(dir: &Path) -> bool {
    dir.components().any(|part| OWN_DIRS.iter().any(|own| part.as_os_str() == *own))
}

/// Opens with the system's default handler, never through our own shims.
fn system_open(target: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Not `cmd /c start`: a `&` in the URL would end the command there.
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let rundll = PathBuf::from(root).join("System32").join("rundll32.exe");
        std::process::Command::new(rundll).arg("url.dll,FileProtocolHandler").arg(target).creation_flags(0x0800_0000).status().is_ok_and(|s| s.success())
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/bin/open").arg(target).status().is_ok_and(|s| s.success())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::var_os("PATH").unwrap_or_default();
        for (program, first) in [("xdg-open", None), ("gio", Some("open")), ("sensible-browser", None), ("x-www-browser", None), ("www-browser", None)] {
            let found = std::env::split_paths(&path)
                .filter(|dir| dir.is_absolute() && !is_own_dir(dir))
                .map(|dir| dir.join(program))
                .find(|candidate| candidate.metadata().is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0));
            let Some(found) = found else { continue };
            let mut command = std::process::Command::new(found);
            command.args(first).arg(target);
            if command.status().is_ok_and(|s| s.success()) {
                return true;
            }
        }
        false
    }
}

/// Writes `body` whole or not at all, with the execute bit on Unix; unchanged files are left alone
/// (an agent may be running the script).
fn write_script(path: &Path, body: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(body) {
        return Ok(());
    }
    let tmp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::write(&tmp, body)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        }
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// A copy of the executable named `flowcode-open.exe`, which BROWSER points to on Windows (see
/// `COPY_STEM`): a hard link when the volume allows, else a plain copy, refreshed when the
/// executable changes (an update, a rebuild). `false` when there is none.
#[cfg(windows)]
fn ensure_copy(exe: &Path, copy: &Path) -> bool {
    let same = |a: &std::fs::Metadata, b: &std::fs::Metadata| a.len() == b.len() && a.modified().ok() == b.modified().ok();
    let Ok(source) = exe.metadata() else { return false };
    if copy.metadata().is_ok_and(|c| same(&source, &c)) {
        return true;
    }
    let _ = std::fs::remove_file(copy);
    if std::fs::hard_link(exe, copy).is_ok() {
        return true;
    }
    let tmp = copy.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let done = std::fs::copy(exe, &tmp).and_then(|_| std::fs::rename(&tmp, copy)).is_ok();
    if !done {
        let _ = std::fs::remove_file(&tmp);
    }
    // A copy that is still in use cannot be replaced: the old one keeps working for the tools using it.
    done || copy.is_file()
}

struct Shims {
    dir: PathBuf,
    exe: PathBuf,
    /// What BROWSER points to; none when the executable could not be made available under that name.
    browser: Option<PathBuf>,
}

fn shims(app: &AppHandle) -> Option<&'static Shims> {
    static SHIMS: OnceLock<Shims> = OnceLock::new();
    if SHIMS.get().is_none() {
        let built = (|| -> Option<Shims> {
            let dir = app.path().app_local_data_dir().ok()?.join("open-shim");
            std::fs::create_dir_all(&dir).ok()?;
            let exe = std::env::current_exe().ok()?;
            let script = shim_script();
            for name in NATIVE_NAMES {
                write_script(&dir.join(name), &script).ok()?;
            }
            #[cfg(windows)]
            let browser = Some(dir.join(format!("{COPY_STEM}.exe"))).filter(|copy| ensure_copy(&exe, copy));
            #[cfg(not(windows))]
            let browser = Some(dir.join(COPY_STEM)).filter(|path| write_script(path, &script).is_ok());
            Some(Shims { dir, exe, browser })
        })();
        match built {
            Some(shims) => { let _ = SHIMS.set(shims); }
            None => eprintln!("browser open: shim folder not written; agents keep opening the system browser"),
        }
    }
    SHIMS.get()
}

/// BROWSER as tools parse it: forward slashes (Python splits it like a shell, which eats backslashes),
/// quoted when the path has a space (such a path does not survive every tool).
fn browser_value(path: &Path) -> String {
    let text = path.to_string_lossy().replace('\\', "/");
    if text.contains(' ') { format!("\"{text}\"") } else { text }
}

/// The environment that makes a native agent process (a Windows/macOS/Linux terminal tab or chat)
/// open pages through Flowcode: BROWSER, the executable the shims run, and the shim folder first on
/// `path` (the PATH the process would otherwise get; the app's own when `None`). The token and
/// folder of the MCP server (`FLOWCODE_MCP_TOKEN` / `FLOWCODE_MCP_DIR`) come with the tab or chat.
pub(crate) fn native_env(app: &AppHandle, path: Option<OsString>) -> Vec<(&'static str, OsString)> {
    let Some(shims) = shims(app) else { return Vec::new() };
    let rest = path.or_else(|| std::env::var_os("PATH")).unwrap_or_default();
    let joined = std::env::join_paths(std::iter::once(shims.dir.clone()).chain(std::env::split_paths(&rest)));
    let mut env: Vec<(&'static str, OsString)> = vec![("FLOWCODE_OPEN_EXE", shims.exe.clone().into_os_string())];
    if let Ok(joined) = joined {
        env.push(("PATH", joined));
    }
    if let Some(browser) = &shims.browser {
        env.push(("BROWSER", browser_value(browser).into()));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn the_target_is_the_first_url_whatever_surrounds_it() {
        let cwd = Path::new(".");
        assert_eq!(pick_target(&strings(&["http://localhost:5173/"]), cwd).as_deref(), Some("http://localhost:5173/"));
        // Python's webbrowser may add arguments; Node's `open` leaves quotes around the URL.
        assert_eq!(pick_target(&strings(&["--new-window", "\"https://a.test/x?a=1&b=2\"", "-x"]), cwd).as_deref(), Some("https://a.test/x?a=1&b=2"));
        assert_eq!(pick_target(&strings(&["HTTPS://A.test"]), cwd).as_deref(), Some("HTTPS://A.test"));
        assert_eq!(pick_target(&strings(&["-a", "Safari", "http://x.test"]), cwd).as_deref(), Some("http://x.test"));
    }

    #[test]
    fn other_schemes_and_spaces_are_not_targets() {
        let cwd = Path::new(".");
        assert_eq!(pick_target(&strings(&["file:///etc/passwd", "ftp://x", "javascript:alert(1)", "mailto:a@b.c"]), cwd), None);
        assert_eq!(pick_target(&strings(&["http://a.test/with space"]), cwd), None);
        assert_eq!(pick_target(&strings(&["http://a.test/\nx"]), cwd), None);
        assert_eq!(pick_target(&[], cwd), None);
        assert_eq!(pick_target(&strings(&["", "--", "-"]), cwd), None);
    }

    #[test]
    fn an_existing_file_is_a_target_relative_ones_from_the_working_folder() {
        let dir = std::env::temp_dir().join(format!("flowcode-open-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<p>x</p>").unwrap();
        let expected = dir.join("index.html").to_string_lossy().into_owned();
        assert_eq!(pick_target(&strings(&["index.html"]), &dir), Some(expected.clone()));
        assert_eq!(pick_target(&strings(&[&expected]), Path::new(".")), Some(expected.clone()));
        assert_eq!(pick_target(&strings(&["missing.html"]), &dir), None);
        // A folder is not a page; a URL later in the list still wins over nothing.
        assert_eq!(pick_target(&strings(&[&dir.to_string_lossy(), "http://x.test"]), &dir).as_deref(), Some("http://x.test"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_hidden_mode_starts_by_flag_or_by_the_copys_name_only() {
        let os = |a: &[&str]| a.iter().map(OsString::from).collect::<Vec<_>>();
        assert_eq!(requested(&os(&["--flowcode-open", "http://x"]), Some("flowcode")), Some(strings(&["http://x"])));
        assert_eq!(requested(&os(&["http://x"]), Some("Flowcode-Open")), Some(strings(&["http://x"])));
        assert_eq!(requested(&os(&["http://x"]), Some("flowcode")), None);
        assert_eq!(requested(&os(&["--flowcode-provider", "claude"]), Some("flowcode")), None);
        assert_eq!(requested(&[], Some("flowcode")), None);
    }

    #[test]
    fn browser_is_written_with_forward_slashes() {
        assert_eq!(browser_value(Path::new(r"C:\Users\a\open-shim\flowcode-open.exe")), "C:/Users/a/open-shim/flowcode-open.exe");
        assert_eq!(browser_value(Path::new(r"C:\Users\Ann Lee\x.exe")), "\"C:/Users/Ann Lee/x.exe\"");
    }

    #[test]
    fn the_system_opener_lookup_skips_our_shim_folders() {
        assert!(is_own_dir(Path::new("/home/a/.local/share/com.x/open-shim")));
        assert!(is_own_dir(Path::new("C:/Users/a/AppData/Local/x/provider-launch/default")));
        assert!(!is_own_dir(Path::new("/usr/bin")));
    }

    #[test]
    fn the_app_is_asked_through_request_files_and_the_answer_decides() {
        let dir = std::env::temp_dir().join(format!("flowcode-open-ipc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let answerer = {
            let dir = dir.clone();
            std::thread::spawn(move || {
                for _ in 0..100 {
                    std::thread::sleep(Duration::from_millis(20));
                    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                        let name = entry.file_name().to_string_lossy().into_owned();
                        let Some(id) = name.strip_prefix("req-").and_then(|n| n.strip_suffix(".json")) else { continue };
                        let request: Value = serde_json::from_str(&std::fs::read_to_string(entry.path()).unwrap()).unwrap();
                        assert_eq!(request["id"], id);
                        assert_eq!(request["tool"], "open_in_browser");
                        assert_eq!(request["token"], "tok");
                        assert_eq!(request["args"]["target"], "http://x.test/?a=1&b=2");
                        std::fs::remove_file(entry.path()).unwrap();
                        std::fs::write(dir.join(format!("res-{id}.json")), json!({ "ok": true, "text": "Sent" }).to_string()).unwrap();
                        return;
                    }
                }
            })
        };
        assert!(ask_app(&dir, "tok", "http://x.test/?a=1&b=2", Path::new("."), Duration::from_secs(3)));
        answerer.join().unwrap();
        // Nobody answers: it gives up, and takes its request back.
        assert!(!ask_app(&dir, "tok", "http://x.test", Path::new("."), Duration::from_millis(300)));
        assert!(std::fs::read_dir(&dir).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with("req-")));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
