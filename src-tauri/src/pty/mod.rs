use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::sync::mpsc;

use crate::util::lock;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

mod foreground;
pub use self::foreground::*;
mod shells;
pub use self::shells::*;
use self::shells::{resolve_shell, split_wsl_unc};

struct PtySession {
    /// Shared with the session's writer thread, which does the resizes: a
    /// ConPTY resize can stall, and must not do so under the map-wide lock.
    /// Only read here for `pty_foreground` on Unix.
    #[cfg_attr(not(unix), allow(dead_code))]
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    /// Feeds the session's writer thread (see `spawn_writer`). One queue for
    /// writes *and* resizes, so keystrokes and size changes reach the pty in
    /// the order they were issued. Dropping the session ends the thread.
    ops: std::sync::mpsc::Sender<PtyOp>,
    /// Bytes of `PtyOp::Write` queued and not yet written (see `MAX_QUEUED_WRITE`).
    queued: Arc<AtomicUsize>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    /// Where this session's output goes - swapped when its tab moves to
    /// another window (see `pty_detach`/`pty_attach`).
    sink: Arc<Mutex<Sink>>,
    /// Label of the window showing this session; `None` while its tab is in
    /// transit between windows. Closing a window kills what it owns (see
    /// `kill_owned_by`).
    owner: Option<String>,
    /// When `pty_detach` left it without a window (cleared on attach): a tab
    /// that no window ever picks up again is reaped (see `take_stale`).
    detached_at: Option<Instant>,
    /// Account profile this tab was launched under (`None` = the default
    /// one) - lets other modules tell which account an agent in it uses.
    profile: Option<String>,
    /// Current size, for remote clients (see remote.rs).
    cols: u16,
    rows: u16,
}

/// What the writer thread of a session does, in order.
enum PtyOp {
    Write(String),
    Resize(u16, u16),
}

/// Cap on input queued for a session's writer thread: a program that stopped
/// reading stdin plus a big paste or phone stream would otherwise grow the
/// queue without limit. Past it, `write` fails instead.
const MAX_QUEUED_WRITE: usize = 4 * 1024 * 1024;

/// How long a session may stay between windows before it is considered
/// abandoned - a move takes milliseconds.
const DETACHED_GRACE: Duration = Duration::from_secs(30);

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
    buffered: VecDeque<PtyEvent>,
    buffered_bytes: usize,
    /// Sequence number of the last `Output` event produced.
    seq: u64,
    /// Remote-access clients watching this session (see remote.rs). Fed
    /// before the local channel in `push`, and independent of it: they see
    /// the same stream whether the tab is attached or in transit.
    remote: Vec<RemoteSub>,
}

/// Events a remote subscriber may have queued before output starts being
/// dropped (events are pty reads, at most 8 KiB each: ~4 MiB per phone).
const REMOTE_QUEUE: usize = 512;

/// One remote client's feed. The queue is bounded so a phone that stopped
/// reading can't grow the PC's memory; when it is full the output is dropped
/// and the consumer is told (`RemoteFeed::is_lagged`) to resync from a snapshot.
struct RemoteSub {
    tx: mpsc::Sender<RemoteOut>,
    lag: Arc<RemoteLag>,
}

/// Shared between a `RemoteSub` and the `RemoteFeed` reading it.
#[derive(Default)]
struct RemoteLag {
    /// Output was dropped since the consumer last resynced.
    lagged: AtomicBool,
    /// Highest `seq` that was dropped: a resync snapshot must cover it.
    dropped_seq: AtomicU64,
}

/// Receiving end of a remote subscription (see `PtyState::remote_subscribe`).
pub struct RemoteFeed {
    pub rx: mpsc::Receiver<RemoteOut>,
    lag: Arc<RemoteLag>,
}

impl RemoteFeed {
    /// Whether output was dropped because the queue was full. The consumer
    /// should discard what is queued and send a fresh snapshot instead.
    pub fn is_lagged(&self) -> bool {
        self.lag.lagged.load(Ordering::Acquire)
    }

    /// Highest output `seq` dropped so far; a snapshot at or past it has
    /// lost nothing.
    pub fn dropped_seq(&self) -> u64 {
        self.lag.dropped_seq.load(Ordering::Acquire)
    }

    /// Clears the lag flag; call *before* asking for the snapshot, so drops
    /// that happen meanwhile re-arm it.
    pub fn clear_lag(&self) {
        self.lag.lagged.store(false, Ordering::Release);
    }
}

/// What a remote subscriber receives - the `PtyEvent`s, minus the serde tag.
pub enum RemoteOut {
    Output { data: String, seq: u64 },
    Exit,
}

impl Sink {
    fn push(&mut self, event: PtyEvent) {
        if !self.remote.is_empty() {
            // Closed receivers (a phone that went away) are dropped here. Never
            // block: a full queue drops the output and flags the subscriber.
            self.remote.retain(|sub| {
                let out = match &event {
                    PtyEvent::Output { data, seq } => RemoteOut::Output { data: data.clone(), seq: *seq },
                    PtyEvent::Exit => RemoteOut::Exit,
                };
                match sub.tx.try_send(out) {
                    Ok(()) => true,
                    Err(mpsc::error::TrySendError::Closed(_)) => false,
                    Err(mpsc::error::TrySendError::Full(RemoteOut::Output { seq, .. })) => {
                        sub.lag.dropped_seq.fetch_max(seq, Ordering::AcqRel);
                        sub.lag.lagged.store(true, Ordering::Release);
                        true
                    }
                    // The exit can't be queued: dropping the sender ends the
                    // stream once the queue drains, and that reports the exit.
                    Err(mpsc::error::TrySendError::Full(RemoteOut::Exit)) => false,
                }
            });
        }
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
        self.buffered.push_back(event);
        while self.buffered_bytes > MAX_BUFFERED_BYTES && self.buffered.len() > 1 {
            if let Some(PtyEvent::Output { data, .. }) = self.buffered.pop_front() {
                self.buffered_bytes -= data.len();
            }
        }
    }
}

#[derive(Default)]
pub struct PtyState(Mutex<HashMap<String, PtySession>>);

/// Account profile the pty session `pty_id` was launched under. Sessions are
/// dropped from the map when they end, so this needs no separate cleanup.
pub fn profile_of(state: &PtyState, pty_id: &str) -> Option<String> {
    lock(&state.0).get(pty_id)?.profile.clone()
}

impl PtyState {
    /// Queues a write to a session's pty - what `pty_write` and remote
    /// clients' input both go through. Never blocks: the session's writer
    /// thread does the actual write (which can block while the program isn't
    /// reading its input), in the order calls were made.
    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let sessions = lock(&self.0);
        let session = sessions.get(id).ok_or("unknown pty session")?;
        if session.queued.load(Ordering::Relaxed) > MAX_QUEUED_WRITE {
            return Err("pty busy".to_string());
        }
        session.queued.fetch_add(data.len(), Ordering::Relaxed);
        session.ops.send(PtyOp::Write(data.to_owned())).map_err(|_| {
            session.queued.fetch_sub(data.len(), Ordering::Relaxed);
            "pty session ended".to_string()
        })
    }

    /// Queues a resize of a session's pty - the desktop terminal's fit and a
    /// phone sizing a tab for its screen (remote.rs) both end up here. The
    /// size is recorded right away; the writer thread applies it to the pty.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = lock(&self.0);
        let session = sessions.get_mut(id).ok_or("unknown pty session")?;
        session.ops.send(PtyOp::Resize(cols, rows)).map_err(|_| "pty session ended".to_string())?;
        session.cols = cols;
        session.rows = rows;
        Ok(())
    }

    /// Label of the window showing a session (`None`: unknown, or in transit).
    pub fn owner_of(&self, id: &str) -> Option<String> {
        lock(&self.0).get(id)?.owner.clone()
    }

    /// Current (cols, rows) of every live session.
    pub fn sizes(&self) -> HashMap<String, (u16, u16)> {
        lock(&self.0).iter().map(|(id, s)| (id.clone(), (s.cols, s.rows))).collect()
    }

    /// Subscribes to a session's output for a remote client. Returns the
    /// receiver, the session's size and the window showing it (`None` while
    /// in transit). `None` overall if the session doesn't exist (any more).
    pub fn remote_subscribe(&self, id: &str) -> Option<(RemoteFeed, u16, u16, Option<String>)> {
        let sessions = lock(&self.0);
        let session = sessions.get(id)?;
        let (tx, rx) = mpsc::channel(REMOTE_QUEUE);
        let lag = Arc::new(RemoteLag::default());
        lock(&session.sink).remote.push(RemoteSub { tx, lag: Arc::clone(&lag) });
        Some((RemoteFeed { rx, lag }, session.cols, session.rows, session.owner.clone()))
    }

    /// Whether a session with this id is alive.
    pub fn exists(&self, id: &str) -> bool {
        lock(&self.0).contains_key(id)
    }

    /// (pty session id, shell PID) for every live session - just enough for
    /// external process-tree inspection (see agents.rs) without exposing the
    /// rest of PtySession's internals.
    pub fn shell_pids(&self) -> Vec<(String, u32)> {
        lock(&self.0)
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

/// The markers a Claude Code session sets for its children. The user's own
/// `CLAUDE_CODE_*` settings (Bedrock, Git Bash path...) must pass through.
const CLAUDE_SESSION_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_CODE_CHILD_SESSION",
];
const CLAUDE_SESSION_PREFIXES: &[&str] = &["CLAUDE_CODE_SESSION_", "CLAUDE_CODE_MESSAGING_"];

// `(async)` - i.e. "run this off the main thread". A plain `#[tauri::command]`
// on a non-async fn runs on the event-loop thread, where the warmup wait below
// (and openpty/spawn_command's own blocking syscalls) would stall the window.
// Tauri hands every argument to a command separately, so there is no struct to
// group these into without changing the frontend call.
#[allow(clippy::too_many_arguments)]
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
    profile: Option<String>,
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
    // Flowcode started from inside a Claude Code session (or from a shell
    // that inherited one) carries its markers, and a Claude started in our
    // tabs would then take itself for that session's child: it skips its
    // `sessions/<pid>.json` registry, so the tab never learns it is working
    // (see agents/claude.rs). Every tab starts as a top-level terminal.
    for (key, _) in std::env::vars_os() {
        let Some(key) = key.to_str() else { continue };
        if CLAUDE_SESSION_VARS.contains(&key) || CLAUDE_SESSION_PREFIXES.iter().any(|p| key.starts_with(p)) {
            cmd.env_remove(key);
        }
    }
    // Account profile: point the agent CLIs at the profile's own folders. Not
    // for WSL - these are Windows paths, meaningless inside the distro.
    if wsl_distro.is_none() && shell_stem != "wsl" {
        for (k, v) in crate::profiles::env_for(&app, profile.as_deref()) {
            cmd.env(k, v);
        }
    }
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
        //
        // It also keeps the commands the app types on its own (an explorer
        // `cd`, a CLI launched from a shortcut - sent with a leading space,
        // see Terminal.tsx) out of PSReadLine's history, the way bash's
        // `ignorespace` does: a line starting with a space is skipped, any
        // other goes through the handler that was there before (the
        // profile's, or PSReadLine's own sensitive-data filter).
        "powershell" | "pwsh" => {
            cmd.args([
                "-NoExit",
                "-Command",
                // Global name shared with the explorer's `cd` for a nested
                // PowerShell (src/terminal/shellDialect.ts), which installs
                // this same wrapper only when it isn't there yet.
                concat!(
                    "$global:__flowcodePrompt = $function:prompt; function global:prompt { ([char]27 + ']0;' + (Get-Location).Path + [char]7) + ((& $global:__flowcodePrompt) -join '') }; ",
                    "try { $global:__flowcodeHistory = (Get-PSReadLineOption).AddToHistoryHandler; ",
                    "Set-PSReadLineOption -AddToHistoryHandler { param($line) ",
                    "if ($line.StartsWith([string][char]32)) { return $false }; ",
                    "$h = $global:__flowcodeHistory; if ($h -is [scriptblock]) { return & $h $line }; ",
                    "if ($h) { return $h.Invoke($line) }; return $true } } catch { }",
                ),
            ]);
        }
        _ => {}
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    // The shell is already running: a failure past this point must not leave
    // it orphaned with nothing holding its handle.
    let mut reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(e) => {
            let _ = child.kill();
            return Err(e.to_string());
        }
    };
    let writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(e) => {
            let _ = child.kill();
            return Err(e.to_string());
        }
    };

    let sink = Arc::new(Mutex::new(Sink {
        channel: Some(on_event),
        buffered: VecDeque::new(),
        buffered_bytes: 0,
        seq: 0,
        remote: Vec::new(),
    }));
    let master = Arc::new(Mutex::new(pair.master));
    let (ops, ops_rx) = std::sync::mpsc::channel();
    let queued = Arc::new(AtomicUsize::new(0));
    spawn_writer(writer, Arc::clone(&master), ops_rx, Arc::clone(&queued));
    lock(&state.0).insert(
        id.clone(),
        PtySession {
            master,
            ops,
            queued,
            killer: child.clone_killer(),
            pid: child.process_id(),
            sink: Arc::clone(&sink),
            owner: Some(window.label().to_string()),
            detached_at: None,
            profile: profile.clone(),
            cols,
            rows,
        },
    );

    let session_id = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        let emit = |data: String| {
            let mut sink = lock(&sink);
            sink.seq += 1;
            let seq = sink.seq;
            sink.push(PtyEvent::Output { data, seq });
        };
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if pending.is_empty() {
                        // Common case: nothing held back, so decode straight
                        // from the read buffer and keep only the tail.
                        let emit_len = emittable_len(&buf[..n]);
                        if emit_len > 0 {
                            emit(String::from_utf8_lossy(&buf[..emit_len]).into_owned());
                        }
                        pending.extend_from_slice(&buf[emit_len..n]);
                    } else {
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
        }
        if !pending.is_empty() {
            emit(String::from_utf8_lossy(&pending).into_owned());
        }
        lock(&sink).push(PtyEvent::Exit);
        // The session is over either way (shell exited, or the tab killed it):
        // drop it from the map so its handles are released now rather than
        // whenever the tab happens to close, and reap the child so it doesn't
        // linger as a zombie on Unix.
        lock(&app.state::<PtyState>().0).remove(&session_id);
        let _ = child.wait();
    });

    Ok(id)
}

// Plain commands: both only enqueue (see `PtyState::write`), which is cheap
// enough for the event-loop thread.
#[tauri::command]
pub fn pty_write(state: State<'_, PtyState>, id: String, data: String) -> Result<(), String> {
    state.write(&id, &data)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, PtyState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(&id, cols, rows)
}

#[tauri::command(async)]
pub fn pty_kill(state: State<'_, PtyState>, id: String) -> Result<(), String> {
    // Removed from the map right away; the reader thread notices EOF once the
    // process is gone and does the rest of the cleanup (see pty_spawn).
    let session = lock(&state.0).remove(&id);
    if let Some(mut session) = session {
        let killed = session.killer.kill().map_err(|e| e.to_string());
        // Dropping closes the pseudo console, which can take a while.
        std::thread::spawn(move || drop(session));
        killed?;
    }
    Ok(())
}

/// One thread per session performs its writes and resizes in order. A write
/// can block while the program isn't reading its input, a ConPTY resize can
/// stall; either only delays this session's own queue. Ends when the session
/// is dropped (the queue's sender with it).
fn spawn_writer(
    mut writer: Box<dyn Write + Send>,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    ops: std::sync::mpsc::Receiver<PtyOp>,
    queued: Arc<AtomicUsize>,
) {
    std::thread::spawn(move || {
        for op in ops {
            match op {
                PtyOp::Write(data) => {
                    let _ = writer.write_all(data.as_bytes()).and_then(|()| writer.flush());
                    queued.fetch_sub(data.len(), Ordering::Relaxed);
                }
                PtyOp::Resize(cols, rows) => {
                    let _ = lock(&master).resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
            }
        }
    });
}

/// Kills and drops sessions already taken out of the map, off the calling
/// thread: the kill and the pseudo console's teardown can both be slow.
fn reap(sessions: Vec<PtySession>) {
    if sessions.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        for mut session in sessions {
            let _ = session.killer.kill();
        }
    });
}

/// Removes the sessions that stayed detached past `DETACHED_GRACE` - their
/// tab never got attached to a window (the move failed midway).
fn take_stale(sessions: &mut HashMap<String, PtySession>) -> Vec<PtySession> {
    let ids: Vec<String> = sessions
        .iter()
        .filter(|(_, s)| s.detached_at.is_some_and(|at| at.elapsed() > DETACHED_GRACE))
        .map(|(id, _)| id.clone())
        .collect();
    ids.iter().filter_map(|id| sessions.remove(id)).collect()
}

/// First half of moving a tab to another window: the session stops sending
/// to its current terminal and holds its output until `pty_attach`. The
/// program itself never notices. Returns the `seq` of the last output already
/// sent - the old terminal waits until it has processed that one before
/// snapshotting its screen, so nothing sent before the detach is lost.
#[tauri::command(async)]
pub fn pty_detach(state: State<'_, PtyState>, id: String) -> Result<u64, String> {
    let mut sessions = lock(&state.0);
    let session = sessions.get_mut(&id).ok_or("unknown pty session")?;
    session.owner = None;
    session.detached_at = Some(Instant::now());
    let seq = {
        let mut sink = lock(&session.sink);
        sink.channel = None;
        sink.seq
    };
    let stale = take_stale(&mut sessions);
    drop(sessions);
    reap(stale);
    Ok(seq)
}

/// Second half of the move: the session's new terminal (in `window`) takes
/// over its output, starting with whatever was held since `pty_detach`.
#[tauri::command(async)]
pub fn pty_attach(
    window: tauri::WebviewWindow,
    state: State<'_, PtyState>,
    id: String,
    on_event: Channel<PtyEvent>,
) -> Result<(), String> {
    let mut sessions = lock(&state.0);
    let session = sessions.get_mut(&id).ok_or("unknown pty session")?;
    session.owner = Some(window.label().to_string());
    session.detached_at = None;
    let mut sink = lock(&session.sink);
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
    /// alone - except those abandoned for good (see `take_stale`), reaped
    /// here too. The kills happen off this thread, after the lock is released.
    pub fn kill_owned_by(&self, label: &str) {
        let doomed = {
            let mut sessions = lock(&self.0);
            let ids: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| s.owner.as_deref() == Some(label))
                .map(|(id, _)| id.clone())
                .collect();
            let mut doomed: Vec<PtySession> = ids.iter().filter_map(|id| sessions.remove(id)).collect();
            doomed.extend(take_stale(&mut sessions));
            doomed
        };
        reap(doomed);
    }
}

fn process_stem(process: &sysinfo::Process) -> String {
    let raw = process.name().to_string_lossy().to_lowercase();
    let raw = raw.trim_start_matches('-'); // login shells: "-zsh"
    std::path::Path::new(raw)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_remote_subscriber_that_stops_reading_is_flagged_not_buffered() {
        let mut sink = Sink { channel: None, buffered: VecDeque::new(), buffered_bytes: 0, seq: 0, remote: Vec::new() };
        let (tx, rx) = mpsc::channel(REMOTE_QUEUE);
        let lag = Arc::new(RemoteLag::default());
        sink.remote.push(RemoteSub { tx, lag: Arc::clone(&lag) });
        let mut feed = RemoteFeed { rx, lag };
        for seq in 1..=REMOTE_QUEUE as u64 {
            sink.push(PtyEvent::Output { data: "x".into(), seq });
        }
        assert!(!feed.is_lagged());
        sink.push(PtyEvent::Output { data: "y".into(), seq: 1000 });
        sink.push(PtyEvent::Output { data: "z".into(), seq: 1001 });
        assert!(feed.is_lagged());
        assert_eq!(feed.dropped_seq(), 1001);
        // Only the queued part is there; the subscriber stays attached.
        let mut queued = 0;
        while feed.rx.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, REMOTE_QUEUE);
        assert_eq!(sink.remote.len(), 1);
        feed.clear_lag();
        assert!(!feed.is_lagged());
        // A closed receiver is dropped on the next push.
        drop(feed);
        sink.push(PtyEvent::Output { data: "w".into(), seq: 1002 });
        assert!(sink.remote.is_empty());
    }

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
        let kind = || crate::system::with_processes(|sys| super::foreground_by_tree(sys, root)).unwrap().kind;
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
            let fg = crate::system::with_processes(|sys| super::foreground_by_tree(sys, root)).unwrap();
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
