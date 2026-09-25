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
    /// Where this session's output goes - swapped when its tab moves to
    /// another window (see `pty_detach`/`pty_attach`).
    sink: Arc<Mutex<Sink>>,
    /// Label of the window showing this session; `None` while its tab is in
    /// transit between windows. Closing a window kills what it owns (see
    /// `kill_owned_by`).
    owner: Option<String>,
}

/// Environment variable carrying a tab's pty session id into everything it
/// runs - see `pty_spawn` and agents.rs's WSL scan.
pub const PTY_ID_ENV: &str = "FLOWCODE_PTY_ID";

/// Cap on output held for a detached session - a tab is only ever detached
/// for the moment it takes to move it, so this is just a backstop against a
/// chatty program filling memory if the move never completes.
const MAX_BUFFERED_BYTES: usize = 8 * 1024 * 1024;

/// The output side of a session: the channel of the terminal currently
/// showing it, or - between `pty_detach` and `pty_attach` - a buffer that
/// holds everything the program prints meanwhile, handed over on attach.
struct Sink {
    channel: Option<Channel<PtyEvent>>,
    buffered: Vec<PtyEvent>,
    buffered_bytes: usize,
    /// Sequence number of the last `Output` event produced.
    seq: u64,
}

impl Sink {
    fn push(&mut self, event: PtyEvent) {
        if let Some(channel) = &self.channel {
            if channel.send(event.clone()).is_ok() {
                return;
            }
            // Its webview is gone (window closed mid-flight): keep the
            // output instead of dropping it, like a detached session.
            self.channel = None;
        }
        if let PtyEvent::Output { data, .. } = &event {
            self.buffered_bytes += data.len();
        }
        self.buffered.push(event);
        while self.buffered_bytes > MAX_BUFFERED_BYTES && self.buffered.len() > 1 {
            if let PtyEvent::Output { data, .. } = self.buffered.remove(0) {
                self.buffered_bytes -= data.len();
            }
        }
    }
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
///
/// `seq` numbers every `Output` in order, per session - what lets a tab being
/// moved to another window know it has received everything sent to it before
/// `pty_detach` (see that command).
#[derive(Serialize, Clone)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum PtyEvent {
    Output { data: String, seq: u64 },
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

/// Windows: PowerShell 7 when it's installed, Windows PowerShell (always
/// there) otherwise - what Windows Terminal opens too. Not COMSPEC: that is
/// cmd.exe on every Windows install, so it says nothing about what the user
/// prefers; cmd stays one pick away in Settings.
fn default_shell() -> String {
    if cfg!(target_os = "windows") {
        if on_path("pwsh.exe") { "pwsh.exe".into() } else { "powershell.exe".into() }
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

/// Whether `program` sits in one of PATH's directories. `symlink_metadata`,
/// not `is_file`: a Microsoft Store pwsh is an App Execution Alias in
/// WindowsApps, a reparse point that plain `metadata` can't follow even
/// though CreateProcess launches it fine.
fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| std::fs::symlink_metadata(dir.join(program)).is_ok()))
        .unwrap_or(false)
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
        // Names what "system" resolves to - on Windows it's Flowcode's own
        // pick (see `default_shell`), not something the OS reports.
        options[0].label =
            if on_path("pwsh.exe") { "Predefinita (PowerShell 7)" } else { "Predefinita (Windows PowerShell)" }.into();
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
    window: tauri::WebviewWindow,
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
    // Tags everything started in this tab with the tab's session id, WSL
    // included (WSLENV carries it across into the distro) - the only way to
    // tell which tab an agent running *inside* WSL belongs to, since Linux
    // processes don't show up in the Windows process tree (see agents.rs).
    let id = uuid::Uuid::new_v4().to_string();
    cmd.env(PTY_ID_ENV, &id);
    let wslenv = std::env::var("WSLENV").unwrap_or_default();
    if !wslenv.split(':').any(|v| v.split('/').next() == Some(PTY_ID_ENV)) {
        let joined = if wslenv.is_empty() { format!("{PTY_ID_ENV}/u") } else { format!("{wslenv}:{PTY_ID_ENV}/u") };
        cmd.env("WSLENV", joined);
    }
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
                // Global name shared with the explorer's `cd` for a nested
                // PowerShell (src/terminal/shellDialect.ts), which installs
                // this same wrapper only when it isn't there yet.
                "$global:__flowcodePrompt = $function:prompt; function global:prompt { ([char]27 + ']0;' + (Get-Location).Path + [char]7) + ((& $global:__flowcodePrompt) -join '') }",
            ]);
        }
        _ => {}
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let sink = Arc::new(Mutex::new(Sink {
        channel: Some(on_event),
        buffered: Vec::new(),
        buffered_bytes: 0,
        seq: 0,
    }));
    state.0.lock().unwrap().insert(
        id.clone(),
        PtySession {
            master: pair.master,
            writer: Arc::new(Mutex::new(writer)),
            killer: child.clone_killer(),
            pid: child.process_id(),
            sink: Arc::clone(&sink),
            owner: Some(window.label().to_string()),
        },
    );

    let session_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let emit = |data: String| {
            let mut sink = sink.lock().unwrap();
            sink.seq += 1;
            let seq = sink.seq;
            sink.push(PtyEvent::Output { data, seq });
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let emit_len = emittable_len(&pending);
                    if emit_len > 0 {
                        let data = String::from_utf8_lossy(&pending[..emit_len]).into_owned();
                        pending.drain(..emit_len);
                        emit(data);
                    }
                }
            }
        }
        if !pending.is_empty() {
            emit(String::from_utf8_lossy(&pending).into_owned());
        }
        sink.lock().unwrap().push(PtyEvent::Exit);
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

/// First half of moving a tab to another window: the session stops sending
/// to its current terminal and holds its output until `pty_attach`. The
/// program itself never notices. Returns the `seq` of the last output already
/// sent - the old terminal waits until it has processed that one before
/// snapshotting its screen, so nothing sent before the detach is lost.
#[tauri::command]
pub fn pty_detach(state: State<'_, PtyState>, id: String) -> Result<u64, String> {
    let mut sessions = state.0.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("unknown pty session")?;
    session.owner = None;
    let mut sink = session.sink.lock().unwrap();
    sink.channel = None;
    Ok(sink.seq)
}

/// Second half of the move: the session's new terminal (in `window`) takes
/// over its output, starting with whatever was held since `pty_detach`.
#[tauri::command]
pub fn pty_attach(
    window: tauri::WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("unknown pty session")?;
    session.owner = Some(window.label().to_string());
    let mut sink = session.sink.lock().unwrap();
    for event in sink.buffered.drain(..) {
        let _ = on_event.send(event);
    }
    sink.buffered_bytes = 0;
    sink.channel = Some(on_event);
    Ok(())
}

impl PtyState {
    /// Kills every session shown in the window `label` - called when that
    /// window is destroyed, since its terminals (and the tabs to reach them)
    /// are gone with it. Sessions in transit belong to no window and are left
    /// alone.
    pub fn kill_owned_by(&self, label: &str) {
        let mut sessions = self.0.lock().unwrap();
        let ids: Vec<String> = sessions
            .iter()
            .filter(|(_, s)| s.owner.as_deref() == Some(label))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(mut session) = sessions.remove(&id) {
                let _ = session.killer.kill();
            }
        }
    }
}

/// What is at the front of a terminal tab right now, as the OS sees it -
/// the basis for anything that types a command into a tab (the explorer's
/// `cd`, shortcuts, runCommand plugins): it has to know whether a shell is
/// actually waiting at its prompt, and which one, to write in its syntax.
/// Asked of the OS rather than inferred from what the user typed, so a
/// history recall, an alias or a script that starts a shell can't fool it.
#[derive(Serialize)]
pub struct Foreground {
    /// "cmd" | "powershell" | "posix" (bash, zsh, sh, dash, ksh, csh...) |
    /// "fish" | "nu" - a shell at its prompt, in that syntax;
    /// "wsl" - a WSL session (whatever Linux shell runs inside it, POSIX `cd`);
    /// "remote" - ssh/mosh/telnet: a shell, but on another machine;
    /// "program" - anything else (a dev server, an editor, Claude Code...):
    /// typing into it would be input to that program, not a command.
    kind: &'static str,
    /// Name of the foreground process, for diagnostics.
    program: String,
    /// "wsl" only: the distro named on its command line (`-d`), if any.
    wsl_distro: Option<String>,
}

fn process_stem(process: &sysinfo::Process) -> String {
    let raw = process.name().to_string_lossy().to_lowercase();
    let raw = raw.trim_start_matches('-'); // login shells: "-zsh"
    std::path::Path::new(raw)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw.to_string())
}

fn classify(process: &sysinfo::Process) -> Foreground {
    let program = process_stem(process);
    // `C:\Windows\System32\bash.exe` is WSL's legacy launcher, not a bash.
    let system32_bash = cfg!(windows)
        && program == "bash"
        && process
            .exe()
            .is_some_and(|exe| exe.to_string_lossy().to_lowercase().contains(r"\windows\system32\"));
    let kind = match program.as_str() {
        "cmd" => "cmd",
        "powershell" | "pwsh" => "powershell",
        "wsl" => "wsl",
        _ if system32_bash => "wsl",
        "bash" | "zsh" | "sh" | "dash" | "ash" | "ksh" | "mksh" | "pdksh" | "yash" | "csh" | "tcsh" => "posix",
        "fish" => "fish",
        "nu" => "nu",
        "ssh" | "mosh" | "mosh-client" | "telnet" => "remote",
        _ => "program",
    };
    let wsl_distro = (kind == "wsl")
        .then(|| {
            let args: Vec<String> = process.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
            args.iter()
                .position(|a| a == "-d" || a == "--distribution")
                .and_then(|i| args.get(i + 1).cloned())
        })
        .flatten();
    Foreground { kind, program, wsl_distro }
}

/// Follows the tab's process tree down from its shell: at each level the
/// most recently started child is the one in front (the console hosts
/// ConPTY hangs off the shell don't count). Stops at a WSL or ssh client -
/// whatever runs past it is on the Linux/remote side. The only option on
/// Windows, which has no notion of a terminal's foreground process; the Unix
/// fallback when the pty can't tell.
fn foreground_by_tree(sys: &sysinfo::System, root: sysinfo::Pid) -> Option<Foreground> {
    let mut children_of: HashMap<sysinfo::Pid, Vec<&sysinfo::Process>> = HashMap::new();
    for process in sys.processes().values() {
        if let Some(parent) = process.parent() {
            children_of.entry(parent).or_default().push(process);
        }
    }
    let mut current = sys.process(root)?;
    for _ in 0..64 {
        let fg = classify(current);
        if matches!(fg.kind, "wsl" | "remote") {
            return Some(fg);
        }
        let next = children_of
            .get(&current.pid())
            .into_iter()
            .flatten()
            .filter(|p| !matches!(process_stem(p).as_str(), "conhost" | "openconsole"))
            .max_by_key(|p| (p.start_time(), p.pid()));
        match next {
            Some(child) => current = child,
            None => return Some(fg),
        }
    }
    Some(classify(current))
}

/// Just what `classify` reads: names, parents, start times, exe paths and
/// command lines (the WSL distro).
fn process_snapshot() -> sysinfo::System {
    let mut sys = sysinfo::System::new();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::new()
            .with_exe(sysinfo::UpdateKind::OnlyIfNotSet)
            .with_cmd(sysinfo::UpdateKind::OnlyIfNotSet),
    );
    sys
}

/// `leader`: the pty's foreground process group leader, where the OS has
/// one (Unix); `root`: the tab's own shell, for the process-tree fallback.
fn foreground(leader: Option<u32>, root: u32) -> Option<Foreground> {
    let sys = process_snapshot();
    if let Some(fg) = leader.and_then(|pid| sys.process(sysinfo::Pid::from_u32(pid))).map(classify) {
        return Some(fg);
    }
    foreground_by_tree(&sys, sysinfo::Pid::from_u32(root))
}

#[tauri::command]
pub async fn pty_foreground(state: State<'_, PtyState>, id: String) -> Result<Foreground, String> {
    let (root, leader) = {
        let sessions = state.0.lock().unwrap();
        let session = sessions.get(&id).ok_or("unknown pty session")?;
        // Unix: the terminal's foreground process group - the kernel's own
        // answer to "who gets what's typed", exact by definition.
        #[cfg(unix)]
        let leader = session.master.process_group_leader().map(|pid| pid as u32);
        #[cfg(not(unix))]
        let leader: Option<u32> = None;
        (session.pid, leader)
    };
    let root = root.ok_or("pid della shell sconosciuto")?;
    crate::blocking(move || foreground(leader, root).ok_or_else(|| "shell non trovata".to_string())).await
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

    /// Real processes through a real ConPTY - slow (several seconds) and
    /// Windows-only, hence ignored by default:
    /// `cargo test --lib foreground_follows -- --ignored --nocapture`
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn foreground_follows_nested_shells_and_programs() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::time::Duration;

        let pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let child = pair.slave.spawn_command(CommandBuilder::new("cmd.exe")).unwrap();
        let root = sysinfo::Pid::from_u32(child.process_id().unwrap());
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut writer = pair.master.take_writer().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
        // ConPTY opens with a cursor-position query that blocks until answered.
        writer.write_all(b"\x1b[1;1R").unwrap();
        let kind = || super::foreground_by_tree(&super::process_snapshot(), root).unwrap().kind;
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(kind(), "cmd");
        writer.write_all(b"powershell -NoLogo\r").unwrap();
        std::thread::sleep(Duration::from_secs(4));
        assert_eq!(kind(), "powershell");
        writer.write_all(b"ping -n 6 127.0.0.1\r").unwrap();
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(kind(), "program");
        std::thread::sleep(Duration::from_secs(5));
        assert_eq!(kind(), "powershell");
        writer.write_all(b"exit\r").unwrap();
        std::thread::sleep(Duration::from_secs(2));
        assert_eq!(kind(), "cmd");
        // A WSL session: the Linux side isn't visible from here, the
        // wsl.exe client (and the distro on its command line) is.
        if std::process::Command::new("wsl.exe").args(["-l", "-q"]).output().is_ok_and(|o| o.status.success()) {
            writer.write_all(b"wsl.exe -d Ubuntu\r").unwrap();
            std::thread::sleep(Duration::from_secs(5));
            let fg = super::foreground_by_tree(&super::process_snapshot(), root).unwrap();
            assert_eq!((fg.kind, fg.wsl_distro.as_deref()), ("wsl", Some("Ubuntu")));
            writer.write_all(b"exit\n").unwrap();
            std::thread::sleep(Duration::from_secs(2));
            assert_eq!(kind(), "cmd");
        }
        writer.write_all(b"exit\r").unwrap();
    }
    /// Same idea on Unix, through the pty's foreground process group (the
    /// path `pty_foreground` takes there):
    /// `cargo test --lib foreground_follows -- --ignored --nocapture`
    #[cfg(unix)]
    #[test]
    #[ignore]
    fn foreground_follows_nested_shells_and_programs_unix() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        use std::time::Duration;

        let pair = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut cmd = CommandBuilder::new("bash");
        cmd.args(["--norc", "--noprofile", "-i"]);
        let child = pair.slave.spawn_command(cmd).unwrap();
        let root = child.process_id().unwrap();
        let master = pair.master;
        let mut reader = master.try_clone_reader().unwrap();
        let mut writer = master.take_writer().unwrap();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while matches!(reader.read(&mut buf), Ok(n) if n > 0) {}
        });
        let kind = || {
            let leader = master.process_group_leader().map(|pid| pid as u32);
            let fg = super::foreground(leader, root).unwrap();
            (fg.kind, fg.program)
        };
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(kind().0, "posix");
        writer.write_all(b"sh\n").unwrap();
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(kind(), ("posix", "sh".to_string()));
        writer.write_all(b"sleep 3\n").unwrap();
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(kind(), ("program", "sleep".to_string()));
        std::thread::sleep(Duration::from_secs(3));
        assert_eq!(kind(), ("posix", "sh".to_string()));
        writer.write_all(b"exit\n").unwrap();
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(kind(), ("posix", "bash".to_string()));
        writer.write_all(b"exit\n").unwrap();
    }
}
