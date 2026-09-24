use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    /// Behind its own lock (not just the map's): a write to a pty whose
    /// program isn't reading its input can block until the pipe drains, and
    /// holding the map-wide lock for that long would stall every other tab's
    /// keystrokes/resizes along with it.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
}

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, PtySession>>);

impl PtyState {
    /// (pty session id, shell PID) for every live session - just enough for
    /// external process-tree inspection (see agents.rs) without exposing the
    /// rest of PtySession's internals.
    pub fn shell_pids(&self) -> Vec<(String, u32)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(id, session)| session.pid.map(|pid| (id.clone(), pid)))
            .collect()
    }
}

/// Streamed to the frontend over the per-session `Channel` handed to
/// `pty_spawn`. A channel rather than a global `pty://output` event: the
/// frontend attaches its handler *before* the spawn call (so nothing the
/// shell prints first - notably ConPTY's initial `ESC[6n` cursor query,
/// which blocks the session until answered - can be missed), and each
/// terminal only ever receives its own session's bytes instead of every
/// tab filtering every other tab's output.
#[derive(Serialize, Clone)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
pub enum PtyEvent {
    Output(String),
    Exit,
}

/// How much of `pending` can be decoded and emitted now. A multi-byte UTF-8
/// character can straddle two reads - decoding each chunk in isolation would
/// turn both halves into U+FFFD - so a *truncated* trailing sequence (a lead
/// byte whose continuation bytes haven't arrived yet) is held back for the
/// next read. Anything else, invalid bytes included, is emitted right away
/// (lossily), so the held-back tail is never more than 3 bytes.
fn emittable_len(pending: &[u8]) -> usize {
    let len = pending.len();
    for back in 1..=len.min(3) {
        let byte = pending[len - back];
        if byte & 0xC0 == 0x80 {
            continue; // continuation byte - keep looking for the lead byte
        }
        let needed = match byte {
            0xF0..=0xFF => 4,
            0xE0..=0xEF => 3,
            0xC0..=0xDF => 2,
            _ => 1,
        };
        return if needed > back { len - back } else { len };
    }
    len
}

/// Runs the ConPTY warmup below exactly once per process, and - this is the
/// point - *blocks* every other caller until that one run has finished.
/// `setup()` kicks it off early on its own thread so the wait is normally
/// already over by the time it matters; `pty_spawn` goes through the same
/// gate, so a frontend that gets to its first tab quickly waits for the
/// warmup instead of racing it. Without this gate the warmup was pure
/// optimism: nothing stopped the first real tab's `CreatePseudoConsole` from
/// happening first anyway, which is exactly the case it exists to prevent.
#[cfg(target_os = "windows")]
static CONPTY_WARMUP: std::sync::Once = std::sync::Once::new();

#[cfg(target_os = "windows")]
pub fn warmup_conpty() {
    CONPTY_WARMUP.call_once(run_conpty_warmup);
}

/// Spawns and immediately tears down a throwaway ConPTY session, blocking
/// until it exits. Windows-only, called once from `lib.rs`'s `setup()`
/// before the window/webview is shown.
///
/// The very first `CreatePseudoConsole` a process ever makes can come up
/// with its input pipe not actually wired to the child yet - the shell
/// prints its prompt fine (output flows), but nothing typed reaches it,
/// with no error anywhere. Every ConPTY after that first one behaves
/// normally. Ending up with the user's actual first terminal tab being the
/// one that silently eats keystrokes is exactly backwards - so this makes
/// something else be the "first" one instead, before there's a real tab
/// (or a user) around to notice.
#[cfg(target_os = "windows")]
fn run_conpty_warmup() {
    let pty_system = native_pty_system();
    let Ok(pair) = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    }) else {
        return;
    };
    // Always cmd.exe here, regardless of the user's configured default
    // shell (`default_shell()` below) - this only needs *some* process to
    // round-trip through ConPTY, and cmd.exe is guaranteed present.
    let mut cmd = CommandBuilder::new("cmd.exe");
    cmd.args(["/c", "exit"]);
    let Ok(mut child) = pair.slave.spawn_command(cmd) else {
        return;
    };
    drop(pair.slave);
    // Even `cmd.exe /c exit` writes a few dozen bytes of mode-set/title
    // escapes on its way out - if nothing drains the pty's output pipe, the
    // write can block once that pipe fills, which blocks the exit itself,
    // which means `child.wait()` below never returns. A real pty_spawn
    // session never hits this because its own reader thread (below) is
    // always draining output; this one-off warmup needs the same, even
    // though it has nowhere to send what it reads.
    if let Ok(mut reader) = pair.master.try_clone_reader() {
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
    }
    // Bounded, not `child.wait()`: this runs inside `CONPTY_WARMUP.call_once`,
    // which every `pty_spawn` call blocks on (see below) - if this particular
    // throwaway `cmd.exe /c exit` ever fails to exit on its own (seen in
    // practice: it can sit alive indefinitely with no error anywhere), an
    // unbounded wait here would wedge the `Once` forever and silently take
    // every terminal tab down with it, not just this one warmup session.
    // Polling with a deadline, killing on timeout, guarantees this always
    // returns - worst case the warmup is skipped and the real first tab
    // absorbs the stuck-input-pipe quirk this exists to prevent, which is
    // exactly the pre-warmup behavior, not a new failure mode.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                break;
            }
        }
    }
}

fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

#[derive(Serialize)]
pub struct ShellOption {
    /// Sent back verbatim as `pty_spawn`'s `shell` argument - `"system"`
    /// (always first, and the default the Settings page pre-selects) means
    /// "whatever `default_shell()` already picks", so choosing it changes
    /// nothing from today's behavior.
    id: String,
    label: String,
}

/// Whether `wsl.exe` resolves to a real, usable WSL install with at least
/// one distro registered - `-l -q` (quiet, just distro names, no `-v`
/// table header to parse) exits non-zero both when WSL itself isn't
/// installed at all and when it's installed but has no distro yet, either
/// of which means there's nothing a "wsl" shell option could actually
/// launch. Same spawn shape as `wsl_default_distro` in system.rs.
#[cfg(target_os = "windows")]
fn wsl_installed() -> bool {
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-l", "-q"]).stdin(std::process::Stdio::null());
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.output().map(|out| out.status.success()).unwrap_or(false)
}

/// The terminal choices the Settings page offers, filtered to what actually
/// makes sense on this OS - a Windows build has no business offering zsh,
/// and vice versa. "wsl" only ever appears when `wsl_installed()` finds a
/// real, usable install - offering it otherwise would just hand back a
/// shell option that fails the moment it's picked.
///
/// `(async)`: probing for WSL spawns `wsl.exe`, which must not block the UI thread.
#[tauri::command(async)]
pub fn list_shell_options() -> Vec<ShellOption> {
    let mut options = vec![ShellOption { id: "system".into(), label: "Predefinita di sistema".into() }];
    if cfg!(target_os = "windows") {
        options.push(ShellOption { id: "cmd".into(), label: "Prompt dei comandi (cmd)".into() });
        options.push(ShellOption { id: "powershell".into(), label: "Windows PowerShell".into() });
        options.push(ShellOption { id: "pwsh".into(), label: "PowerShell 7".into() });
        #[cfg(target_os = "windows")]
        if wsl_installed() {
            options.push(ShellOption { id: "wsl".into(), label: "WSL".into() });
        }
    } else if cfg!(target_os = "macos") {
        options.push(ShellOption { id: "zsh".into(), label: "zsh".into() });
        options.push(ShellOption { id: "bash".into(), label: "bash".into() });
    } else {
        options.push(ShellOption { id: "bash".into(), label: "bash".into() });
        options.push(ShellOption { id: "zsh".into(), label: "zsh".into() });
        options.push(ShellOption { id: "sh".into(), label: "sh (POSIX)".into() });
    }
    options
}

/// Turns a `ShellOption::id` (as chosen in Settings, round-tripped through
/// `pty_spawn`'s `shell` argument) into the actual program to spawn. Falls
/// back to treating an unrecognized id as a literal program name rather than
/// erroring - keeps this forward-compatible with an id this version of the
/// list doesn't know about (e.g. after a downgrade) instead of breaking every
/// new tab.
fn resolve_shell(id: Option<&str>) -> String {
    match id {
        None | Some("") | Some("system") => default_shell(),
        Some("cmd") => "cmd.exe".into(),
        Some("powershell") => "powershell.exe".into(),
        Some("pwsh") => "pwsh.exe".into(),
        Some("wsl") => "wsl.exe".into(),
        Some(id) if id.starts_with("wsl:") => "wsl.exe".into(),
        Some("zsh") => "zsh".into(),
        Some("bash") => "bash".into(),
        Some("sh") => "sh".into(),
        Some(other) => other.to_string(),
    }
}

/// `\\wsl.localhost\Ubuntu\home\me` (or the older `\\wsl$\...` form) ->
/// `("Ubuntu", "/home/me")`. A WSL folder only reaches the frontend in that
/// UNC form (see wslPath.ts), but it can't be wsl.exe's cwd as-is - the
/// distro would start in its default dir instead - so it's handed over as
/// `-d <distro> --cd <posix path>`.
fn split_wsl_unc(path: &str) -> Option<(String, String)> {
    let lower = path.to_ascii_lowercase();
    let prefix = [r"\\wsl.localhost\", r"\\wsl$\"]
        .into_iter()
        .find(|prefix| lower.starts_with(prefix))?;
    let rest = &path[prefix.len()..];
    let (distro, tail) = rest.split_once('\\').unwrap_or((rest, ""));
    if distro.is_empty() {
        return None;
    }
    let tail = tail.trim_end_matches('\\').replace('\\', "/");
    Some((distro.to_string(), format!("/{tail}")))
}

// `(async)` - i.e. "run this off the main thread". A plain `#[tauri::command]`
// on a non-async fn runs on the event-loop thread, where the warmup wait below
// (and openpty/spawn_command's own blocking syscalls) would stall the window.
#[tauri::command(async)]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    shell: Option<String>,
    on_event: Channel<PtyEvent>,
) -> Result<String, String> {
    // No-op once the warmup has run (the common case, since setup() starts it
    // at launch); blocks only if this spawn really did beat it - see
    // CONPTY_WARMUP above.
    #[cfg(target_os = "windows")]
    warmup_conpty();

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell_program = resolve_shell(shell.as_deref());
    // Only cmd.exe understands the `/k prompt ...` trick below - picked via
    // the resolved program's filename, not "are we on Windows", since a tab's
    // shell can be something else (PowerShell, pwsh, wsl).
    let shell_stem = std::path::Path::new(&shell_program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    let mut cmd = CommandBuilder::new(&shell_program);
    let cwd = cwd.filter(|d| !d.is_empty());
    // `wsl:<distro>` pins the distro a tab was opened from (a favorite saved
    // in a WSL session, "Apri in un altro terminale" from one) - plain `wsl`
    // keeps using the machine's default distro. A `\\wsl.localhost\<distro>`
    // cwd names its distro on its own and wins over both.
    let wsl_unc = if shell_stem == "wsl" { cwd.as_deref().and_then(split_wsl_unc) } else { None };
    let wsl_distro = match &wsl_unc {
        Some((distro, _)) => Some(distro.clone()),
        None => shell
            .as_deref()
            .and_then(|id| id.strip_prefix("wsl:"))
            .filter(|d| !d.is_empty())
            .map(str::to_string),
    };
    if let Some(distro) = &wsl_distro {
        cmd.args(["-d", distro]);
    }
    if let Some((_, posix)) = &wsl_unc {
        cmd.args(["--cd", posix]);
    } else if let Some(dir) = cwd {
        // An empty cwd must never reach CommandBuilder: on Windows it becomes
        // an empty lpCurrentDirectory, which CreateProcessW treats as invalid
        // rather than "inherit" - the shell silently never starts. A plain
        // `C:\...` one is fine for wsl.exe too: it maps it to `/mnt/c/...`.
        cmd.cwd(dir);
    }
    // How CLIs decide whether to emit color: with none of these, Rust TUIs
    // like Codex (and plenty of Node/Python tools) fall back to plain
    // monochrome output. Windows Terminal is recognized via WT_SESSION;
    // Flowcode advertises itself the way VS Code's terminal does.
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Flowcode");
    cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    match shell_stem.as_str() {
        // cmd.exe never retitles on its own - not even after a `cd` typed by
        // hand - so the frontend's "follow the real cwd" logic would have
        // nothing to listen to. `$E` is ESC and `$P` expands to the *current*
        // cwd each time the prompt is drawn, so every prompt emits an OSC 0
        // title with the live cwd on top of the normal "$P$G" prompt text.
        // Set via `/k` at spawn (not typed into the running shell) so there's
        // no echo to erase afterwards.
        "cmd" => {
            cmd.args(["/k", "prompt", "$E]0;$P$E\\$P$G"]);
        }
        // Same problem as cmd.exe, in PowerShell's dialect (both editions).
        // `-NoExit -Command` runs after the user's profile, so this wraps
        // whatever `prompt` the profile defined (oh-my-posh included) rather
        // than replacing it - only the OSC 0 title is prefixed. Written with
        // single quotes and `[char]` escapes so it survives CreateProcess as
        // one argument without quote juggling.
        "powershell" | "pwsh" => {
            cmd.args([
                "-NoExit",
                "-Command",
                "$f = $function:prompt; function prompt { $p = (Get-Location).Path; ([char]27 + ']0;' + $p + [char]7) + ((& $f) -join '') }",
            ]);
        }
        _ => {}
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();
    state.0.lock().unwrap().insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            killer: child.clone_killer(),
            pid: child.process_id(),
        },
    );

    let session_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let emit_len = emittable_len(&pending);
                    if emit_len > 0 {
                        let data = String::from_utf8_lossy(&pending[..emit_len]).into_owned();
                        pending.drain(..emit_len);
                        if on_event.send(PtyEvent::Output(data)).is_err() {
                            break;
                        }
                    }
                }
            }
        }
        if !pending.is_empty() {
            let _ = on_event.send(PtyEvent::Output(String::from_utf8_lossy(&pending).into_owned()));
        }
        let _ = on_event.send(PtyEvent::Exit);
        // The session is over either way (shell exited, or the tab killed it):
        // drop it from the map so its handles are released now rather than
        // whenever the tab happens to close, and reap the child so it doesn't
        // linger as a zombie on Unix.
        app.state::<PtyState>().0.lock().unwrap().remove(&session_id);
        let _ = child.wait();
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let writer = {
        let sessions = state.0.lock().unwrap();
        Arc::clone(&sessions.get(&id).ok_or("unknown pty session")?.writer)
    };
    let mut writer = writer.lock().unwrap();
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    let session = sessions.get(&id).ok_or("unknown pty session")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    // Removed from the map right away; the reader thread notices EOF once the
    // process is gone and does the rest of the cleanup (see pty_spawn).
    let session = state.0.lock().unwrap().remove(&id);
    if let Some(mut session) = session {
        session.killer.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{emittable_len, split_wsl_unc};

    #[test]
    fn holds_back_only_truncated_utf8_tail() {
        let euro = "€".as_bytes(); // 3 bytes
        assert_eq!(emittable_len(b"abc"), 3);
        assert_eq!(emittable_len(euro), 3);
        assert_eq!(emittable_len(&[b'a', euro[0]]), 1);
        assert_eq!(emittable_len(&[b'a', euro[0], euro[1]]), 1);
        // A stray continuation byte / invalid lead is flushed, not held.
        assert_eq!(emittable_len(&[b'a', 0x80, 0x80, 0x80]), 4);
        assert_eq!(emittable_len(&[]), 0);
    }

    #[test]
    fn splits_wsl_unc_paths() {
        assert_eq!(
            split_wsl_unc(r"\\wsl.localhost\Ubuntu\home\me\"),
            Some(("Ubuntu".into(), "/home/me".into()))
        );
        assert_eq!(split_wsl_unc(r"\\WSL$\Debian"), Some(("Debian".into(), "/".into())));
        assert_eq!(split_wsl_unc(r"C:\Users\me"), None);
        assert_eq!(split_wsl_unc(r"\\server\share"), None);
    }
}
