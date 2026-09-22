use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
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
            .filter_map(|(id, session)| session.child.process_id().map(|pid| (id.clone(), pid)))
            .collect()
    }
}

#[derive(Serialize, Clone)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct PtyExitPayload {
    id: String,
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
#[tauri::command]
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
        Some("zsh") => "zsh".into(),
        Some("bash") => "bash".into(),
        Some("sh") => "sh".into(),
        Some(other) => other.to_string(),
    }
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
) -> Result<String, String> {
    // No-op once the warmup has run (the common case, since setup() starts it
    // at launch); blocks only if this spawn really did beat it - see
    // CONPTY_WARMUP above.
    #[cfg(target_os = "windows")]
    warmup_conpty();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell_program = resolve_shell(shell.as_deref());
    // Only cmd.exe understands the `/k prompt ...` trick below - picking it
    // via the resolved program's filename (not just "are we on Windows",
    // which is what this used to check) matters now that a tab's shell can
    // actually be something else (PowerShell, pwsh) instead of whatever
    // `default_shell()` alone would have picked.
    let shell_stem = std::path::Path::new(&shell_program)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    let is_cmd = shell_stem.eq_ignore_ascii_case("cmd");
    // PowerShell needs the same treatment as cmd.exe below, just in its own
    // dialect - both editions, since `pwsh` and `powershell` differ in
    // version, not in having no cwd title of their own.
    let is_powershell = shell_stem.eq_ignore_ascii_case("powershell") || shell_stem.eq_ignore_ascii_case("pwsh");

    let mut cmd = CommandBuilder::new(shell_program);
    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }
    // cmd.exe never retitles on its own - not even after a `cd` the user
    // typed by hand - unlike bash/zsh, which retitle every prompt on their
    // own. Without this, the frontend's "a real cd is authoritative, follow
    // it in the explorer" logic has nothing to listen to on Windows. `$E` is
    // cmd.exe's own PROMPT code for ESC, and `$P` expands to the *current*
    // cwd every time the prompt is drawn, not just once - so this makes
    // every prompt emit a real OSC 0 title update with the live cwd, on top
    // of (not instead of) the normal visible "$P$G" ("C:\path>") prompt text.
    //
    // Set via `/k` at spawn time, not by typing `prompt ...` into the
    // already-running shell afterward (the frontend used to do this): typing
    // it interactively means cmd.exe echoes it back like anything else you
    // type, which then has to be erased again once the freshly-retitled
    // prompt redraws - a fragile row-counting trick that depended on
    // reading the terminal's cursor position at exactly the right moment.
    // Setting it before the shell ever draws its first prompt needs no
    // typing, no echo and nothing to erase.
    if is_cmd {
        cmd.args(["/k", "prompt", "$E]0;$P$E\\$P$G"]);
    }
    // PowerShell is in the same boat as cmd.exe - it never retitles per
    // prompt either - but it had no equivalent of the line above, so a
    // PowerShell tab reported *no* cwd at all: `cd` never moved the
    // explorer, and (the reason this got noticed) leaving a nested `wsl`
    // session emitted nothing the frontend could recognize as "back on the
    // host shell", leaving the explorer stranded on the WSL path with the
    // tab still flagged as a WSL session - measured on this machine, where
    // the only title around the `exit` was ConPTY restoring the original
    // `...\powershell.exe`, which is (correctly) ignored as an executable
    // path. `-NoExit -Command` is PowerShell's `/k`: it runs after the
    // user's profile, so it can wrap whatever `prompt` that profile left
    // behind (oh-my-posh and friends included) rather than replacing it -
    // the OSC 0 title is prefixed, the visible prompt is still the user's
    // own. Written entirely with single-quoted strings and `[char]` escapes
    // so the whole thing survives being passed through CreateProcess as one
    // argument without any quote juggling.
    if is_powershell {
        cmd.args([
            "-NoExit",
            "-Command",
            "$f = $function:prompt; function prompt { $p = (Get-Location).Path; ([char]27 + ']0;' + $p + [char]7) + ((& $f) -join '') }",
        ]);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = uuid::Uuid::new_v4().to_string();

    {
        let mut sessions = state.0.lock().unwrap();
        sessions.insert(
            id.clone(),
            PtySession {
                master: pair.master,
                writer,
                child,
            },
        );
    }

    let emit_id = id.clone();
    let emit_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // A multi-byte UTF-8 character can straddle two 4096-byte reads -
        // decoding each chunk with `from_utf8_lossy` in isolation would
        // replace both halves with U+FFFD instead of the real character
        // (garbled accented letters, box-drawing borders, emoji in anything
        // the shell prints). Any trailing incomplete sequence is held back
        // here and prepended to the next read instead.
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid_len = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    // A genuinely invalid byte (not just a truncated tail)
                    // must still be flushed - otherwise `pending` could grow
                    // without bound - so only hold back a short tail that
                    // could still become valid with more bytes.
                    let hold_back = pending.len() - valid_len <= 3;
                    let emit_len = if hold_back { valid_len } else { pending.len() };
                    if emit_len > 0 {
                        let data = String::from_utf8_lossy(&pending[..emit_len]).to_string();
                        let _ = emit_app.emit(
                            "pty://output",
                            PtyOutputPayload {
                                id: emit_id.clone(),
                                data,
                            },
                        );
                    }
                    pending.drain(..emit_len);
                }
                Err(_) => break,
            }
        }
        if !pending.is_empty() {
            let data = String::from_utf8_lossy(&pending).to_string();
            let _ = emit_app.emit(
                "pty://output",
                PtyOutputPayload {
                    id: emit_id.clone(),
                    data,
                },
            );
        }
        let _ = emit_app.emit("pty://exit", PtyExitPayload { id: emit_id.clone() });
    });

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("unknown pty session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    state: State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
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
    let mut sessions = state.0.lock().unwrap();
    if let Some(mut session) = sessions.remove(&id) {
        session.child.kill().map_err(|e| e.to_string())?;
    }
    Ok(())
}
