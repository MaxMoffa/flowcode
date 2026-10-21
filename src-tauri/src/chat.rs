//! Chat mode: an AI coding agent hosted through the Agent Client Protocol
//! (ACP - JSON-RPC 2.0, one JSON message per line over the child's
//! stdin/stdout) instead of a pty. The agent's streamed `session/update`s are
//! turned into numbered `ChatEvent`s, kept in a per-chat log (so a remounted
//! view can replay) and pushed to the window that owns the chat.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, watch};

use crate::util::{lock, now_ms};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

/// How long `initialize` / `session/new` / `session/load` may take: `npx` may
/// have to download the adapter the first time it is used.
const SETUP_TIMEOUT: Duration = Duration::from_secs(180);
const MODE_TIMEOUT: Duration = Duration::from_secs(30);

/// Events kept per chat for `chat_events`; the oldest are dropped past it.
const MAX_LOG_EVENTS: usize = 20_000;

/// How much of an agent's stderr is kept to explain why it died.
const STDERR_TAIL: usize = 4 * 1024;

/// ACP's "method not found" JSON-RPC error code.
const METHOD_NOT_FOUND: i64 = -32601;

/// Events a phone following a chat may fall behind by before it has to resync
/// from the log.
const FEED_CAPACITY: usize = 1024;

/// What the frontend receives for one chat; `kind` says which. `seq` numbers
/// the events of a chat from 1, `at` is when it happened (ms since epoch).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    pub seq: u64,
    pub at: u64,
    #[serde(flatten)]
    pub body: ChatBody,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ChatBody {
    /// A `session/update` notification, verbatim.
    Update { update: Value },
    /// What the user sent (recorded by `chat_prompt`).
    User { text: String },
    /// The agent asks for permission; answered with `chat_permission`.
    Permission { request_id: Value, tool_call: Value, options: Value },
    PermissionResolved { request_id: Value, option_id: Option<String> },
    TurnEnd { stop_reason: String },
    Error { message: String },
    Exit { code: Option<i32> },
    /// An extension notification (its method starts with `_`), verbatim. It
    /// doesn't change the chat's status.
    Ext { method: String, params: Value },
}

/// Where a chat's turn stands - what the phones' chat list shows.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum ChatStatus {
    Starting,
    Idle,
    Busy,
    /// The agent is waiting for a permission answer.
    Waiting,
    Exited,
}

impl ChatStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ChatStatus::Starting => "starting",
            ChatStatus::Idle => "idle",
            ChatStatus::Busy => "busy",
            ChatStatus::Waiting => "waiting",
            ChatStatus::Exited => "exited",
        }
    }
}

/// Something a phone should hear about even when it isn't following the chat.
#[derive(Clone, Debug)]
pub(crate) struct ChatAlert {
    pub agent: String,
    pub session_id: String,
    pub kind: AlertKind,
}

#[derive(Clone, Debug)]
pub(crate) enum AlertKind {
    /// The agent asks to run the tool called this.
    Permission { tool: String },
    /// The agent finished its turn.
    Done,
}

/// A running chat as the remote access server lists it.
pub(crate) struct ChatSummary {
    pub chat_id: String,
    pub agent: String,
    pub cwd: String,
    pub profile: Option<String>,
    pub session_id: Option<String>,
    pub modes: Option<Value>,
    pub status: ChatStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStarted {
    pub chat_id: String,
    pub session_id: String,
    pub agent: String,
    pub modes: Option<Value>,
    pub config_options: Option<Value>,
    /// The agent replayed a previous session (`session/load`) rather than
    /// starting a fresh one.
    pub loaded: bool,
}

/// What a request sent to the agent does with its answer.
enum Pending {
    /// Someone is blocked waiting for it.
    Waiter(mpsc::Sender<Result<Value, String>>),
    /// A `session/prompt`: its answer ends (or fails) the turn.
    Prompt,
}

struct RpcError {
    code: i64,
    message: String,
}

/// One line the agent wrote, sorted by what it is.
enum Incoming {
    Response { id: u64, result: Result<Value, RpcError> },
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
}

/// Parses a stdout line; `None` for anything that isn't a JSON-RPC message
/// (some adapters print logs to stdout).
fn parse_line(line: &str) -> Option<Incoming> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let obj = value.as_object()?;
    let method = obj.get("method").and_then(Value::as_str);
    let id = obj.get("id").filter(|id| !id.is_null());
    let params = obj.get("params").cloned().unwrap_or(Value::Null);
    match (method, id) {
        (Some(method), Some(id)) => Some(Incoming::Request { id: id.clone(), method: method.to_string(), params }),
        (Some(method), None) => Some(Incoming::Notification { method: method.to_string(), params }),
        (None, Some(id)) => {
            // Our own ids are integers; anything else isn't an answer to us.
            let id = id.as_u64()?;
            let result = match obj.get("error") {
                Some(err) => Err(RpcError {
                    code: err.get("code").and_then(Value::as_i64).unwrap_or(0),
                    message: err.get("message").and_then(Value::as_str).unwrap_or("unknown error").to_string(),
                }),
                None => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
            };
            Some(Incoming::Response { id, result })
        }
        (None, None) => None,
    }
}

/// ACP signals "sign in first" with code -32000 / "Authentication required".
fn is_auth_error(err: &RpcError) -> bool {
    let message = err.message.to_lowercase();
    err.code == -32000 || message.contains("authenticat") || message.contains("auth_required")
}

fn error_text(err: &RpcError) -> String {
    if is_auth_error(err) { format!("auth_required: {}", err.message) } else { err.message.clone() }
}

/// Appends to a ring buffer holding the last `cap` bytes.
fn push_tail(buf: &mut Vec<u8>, chunk: &[u8], cap: usize) {
    buf.extend_from_slice(chunk);
    if buf.len() > cap {
        buf.drain(..buf.len() - cap);
    }
}

/// The program and arguments that start an agent's ACP server.
fn launch_command(agent: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match agent {
        "vibe" => ("vibe-acp", &[]),
        "gemini" => ("gemini", &["--experimental-acp"]),
        "claude" => ("npx", &["-y", "@agentclientprotocol/claude-agent-acp"]),
        "codex" => ("npx", &["-y", "@agentclientprotocol/codex-acp"]),
        _ => return None,
    })
}

struct Log {
    seq: u64,
    events: VecDeque<ChatEvent>,
}

/// Everything about one running agent; shared by the commands and the
/// session's reader thread.
struct Chat {
    id: String,
    app: AppHandle,
    /// Label of the window showing this chat - the only one events go to.
    owner: String,
    agent: String,
    cwd: String,
    profile: Option<String>,
    child: Mutex<Child>,
    writer: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Pending>>,
    /// Permission requests the agent is waiting on: the JSON text of the
    /// request id (a usable map key) -> the id itself.
    permissions: Mutex<HashMap<String, Value>>,
    log: Mutex<Log>,
    /// Every event, as `emit` logs it, for the phones following this chat.
    feed: broadcast::Sender<ChatEvent>,
    status: Mutex<ChatStatus>,
    stderr: Mutex<Vec<u8>>,
    stderr_done: AtomicBool,
    /// The agent's stdout ended; set under the `pending` lock, so nothing is
    /// registered after the pending requests were failed.
    exited: AtomicBool,
    /// The chat was closed on purpose: nobody is left to tell.
    closed: AtomicBool,
    session_id: OnceLock<String>,
    /// The `modes` the agent announced when the session started.
    modes: OnceLock<Value>,
}

impl Chat {
    /// Logs an event and sends it to the owner window and the phones. Under
    /// the log lock, so events reach them in `seq` order and
    /// `ChatState::subscribe` can take the log and the feed in one go.
    fn emit(&self, body: ChatBody) {
        let mut log = lock(&self.log);
        log.seq += 1;
        let event = ChatEvent { seq: log.seq, at: now_ms(), body };
        log.events.push_back(event.clone());
        if log.events.len() > MAX_LOG_EVENTS {
            log.events.pop_front();
        }
        let _ = self.feed.send(event.clone());
        if !self.closed.load(Ordering::Relaxed) {
            let _ = self.app.emit_to(&self.owner, "chat-event", json!({ "chatId": self.id, "event": event }));
        }
        let (live, changed) = self.track(&event.body);
        drop(log);
        if changed {
            self.changed();
        }
        if live {
            self.alert(&event.body);
        }
    }

    /// Moves the status along with an event; returns whether the chat is past
    /// its start and whether the status changed. Nothing moves while the agent
    /// is starting (a resumed session replays its history) or once it exited.
    fn track(&self, body: &ChatBody) -> (bool, bool) {
        let mut status = lock(&self.status);
        let before = *status;
        let ended = matches!(body, ChatBody::Exit { .. });
        if before == ChatStatus::Exited || (before == ChatStatus::Starting && !ended) {
            return (false, false);
        }
        *status = match body {
            ChatBody::Exit { .. } => ChatStatus::Exited,
            ChatBody::TurnEnd { .. } | ChatBody::Error { .. } => ChatStatus::Idle,
            ChatBody::Ext { .. } => before,
            // Agents keep sending updates between turns (usage, commands,
            // session info): only a prompt starts a turn.
            ChatBody::Update { .. } if before == ChatStatus::Idle => before,
            _ if lock(&self.permissions).is_empty() => ChatStatus::Busy,
            _ => ChatStatus::Waiting,
        };
        (true, *status != before)
    }

    fn set_status(&self, status: ChatStatus) {
        if std::mem::replace(&mut *lock(&self.status), status) != status {
            self.changed();
        }
    }

    /// Tells the remote access server the chat list or a status changed.
    fn changed(&self) {
        if let Some(state) = self.app.try_state::<ChatState>() {
            state.changed();
        }
    }

    /// Raises an alert for the events a phone wants to hear about.
    fn alert(&self, body: &ChatBody) {
        let kind = match body {
            ChatBody::Permission { tool_call, .. } => {
                AlertKind::Permission { tool: tool_call.get("title").and_then(Value::as_str).unwrap_or_default().to_string() }
            }
            ChatBody::TurnEnd { stop_reason } if stop_reason != "cancelled" => AlertKind::Done,
            _ => return,
        };
        let (Some(state), Some(session_id)) = (self.app.try_state::<ChatState>(), self.session_id.get()) else { return };
        let _ = state.alerts.send(ChatAlert { agent: self.agent.clone(), session_id: session_id.clone(), kind });
    }

    fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(&lock(&self.stderr)).trim().to_string()
    }

    /// `base`, followed by what the agent last wrote to stderr.
    fn with_tail(&self, base: &str) -> String {
        let tail = self.stderr_tail();
        if tail.is_empty() { base.to_string() } else { format!("{base}: {tail}") }
    }

    /// Writes one message line to the agent's stdin.
    fn send(&self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut writer = lock(&self.writer);
        writer
            .write_all(&line)
            .and_then(|()| writer.flush())
            .map_err(|e| self.with_tail(&format!("the agent is not accepting input ({e})")))
    }

    fn register(&self, pending: Pending) -> Result<u64, String> {
        let mut map = lock(&self.pending);
        if self.exited.load(Ordering::Acquire) {
            return Err(self.with_tail("the agent has exited"));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        map.insert(id, pending);
        Ok(id)
    }

    fn send_request(&self, id: u64, method: &str, params: Value) -> Result<(), String> {
        let sent = self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        if sent.is_err() {
            lock(&self.pending).remove(&id);
        }
        sent
    }

    /// Sends a request and waits for its answer.
    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let id = self.register(Pending::Waiter(tx))?;
        self.send_request(id, method, params)?;
        match rx.recv_timeout(timeout) {
            Ok(answer) => answer,
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&id);
                Err(self.with_tail(&format!("{method} timed out after {}s", timeout.as_secs())))
            }
            Err(RecvTimeoutError::Disconnected) => Err(self.with_tail("the agent closed")),
        }
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    fn session_id(&self) -> Result<&str, String> {
        self.session_id.get().map(String::as_str).ok_or_else(|| "chat not started".to_string())
    }

    fn handle(&self, incoming: Incoming) {
        match incoming {
            Incoming::Response { id, result } => {
                let Some(pending) = lock(&self.pending).remove(&id) else { return };
                let result = result.map_err(|e| error_text(&e));
                match pending {
                    Pending::Waiter(tx) => {
                        let _ = tx.send(result);
                    }
                    Pending::Prompt => match result {
                        Ok(value) => {
                            let stop_reason = value.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn");
                            self.emit(ChatBody::TurnEnd { stop_reason: stop_reason.to_string() });
                        }
                        Err(message) => self.emit(ChatBody::Error { message }),
                    },
                }
            }
            Incoming::Request { id, method, params } => {
                if method == "session/request_permission" {
                    lock(&self.permissions).insert(id.to_string(), id.clone());
                    self.emit(ChatBody::Permission {
                        request_id: id,
                        tool_call: params.get("toolCall").cloned().unwrap_or(Value::Null),
                        options: params.get("options").cloned().unwrap_or_else(|| json!([])),
                    });
                } else {
                    // No fs or terminal capability was advertised.
                    let _ = self.send(&json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": METHOD_NOT_FOUND, "message": "Method not found" },
                    }));
                }
            }
            Incoming::Notification { method, params } => {
                if method == "session/update" {
                    if let Some(update) = params.get("update") {
                        self.emit(ChatBody::Update { update: update.clone() });
                    }
                } else if method.starts_with('_') {
                    self.emit(ChatBody::Ext { method, params });
                }
            }
        }
    }

    /// Answers a pending permission request: `Some(option)` selects it, `None`
    /// cancels. Errs if there is no such request (any more).
    fn resolve_permission(&self, request_id: &Value, option_id: Option<&str>) -> Result<(), String> {
        let id = lock(&self.permissions)
            .remove(&request_id.to_string())
            .ok_or_else(|| "unknown permission request".to_string())?;
        let outcome = match option_id {
            Some(option_id) => json!({ "outcome": "selected", "optionId": option_id }),
            None => json!({ "outcome": "cancelled" }),
        };
        let sent = self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": outcome } }));
        self.emit(ChatBody::PermissionResolved { request_id: id, option_id: option_id.map(str::to_string) });
        sent
    }

    fn cancel_permissions(&self) {
        let ids: Vec<Value> = lock(&self.permissions).values().cloned().collect();
        for id in ids {
            let _ = self.resolve_permission(&id, None);
        }
    }

    /// The agent's stdout ended: collect its exit code, fail everything still
    /// waiting on it and tell the window.
    fn finish(&self) {
        let code = self.reap();
        // The stderr thread usually ends with the process; don't wait on a
        // grandchild that kept the pipe open.
        for _ in 0..10 {
            if self.stderr_done.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let message = match code {
            Some(code) => self.with_tail(&format!("the agent exited with code {code}")),
            None => self.with_tail("the agent exited"),
        };
        let drained = {
            let mut map = lock(&self.pending);
            self.exited.store(true, Ordering::Release);
            std::mem::take(&mut *map)
        };
        for pending in drained.into_values() {
            match pending {
                Pending::Waiter(tx) => {
                    let _ = tx.send(Err(message.clone()));
                }
                Pending::Prompt => self.emit(ChatBody::Error { message: message.clone() }),
            }
        }
        lock(&self.permissions).clear();
        self.emit(ChatBody::Exit { code });
    }

    /// Waits (briefly) for the process to be gone, killing it if it lingers.
    fn reap(&self) -> Option<i32> {
        for _ in 0..40 {
            if let Ok(Some(status)) = lock(&self.child).try_wait() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut child = lock(&self.child);
        let _ = child.kill();
        child.wait().ok().and_then(|status| status.code())
    }

    /// Kills the agent and what it started (an `npx` adapter runs the real
    /// agent as a child of its own). The reader thread reaps it.
    fn kill(&self) {
        self.closed.store(true, Ordering::Relaxed);
        let mut child = lock(&self.child);
        kill_tree(child.id());
        let _ = child.kill();
    }
}

#[cfg(target_os = "windows")]
fn kill_tree(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

/// The agent is spawned as the leader of its own process group (see
/// `spawn_agent`), so the whole group can be signalled.
#[cfg(not(target_os = "windows"))]
fn kill_tree(pid: u32) {
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn read_stdout(chat: Arc<Chat>, stdout: impl Read) {
    let mut reader = BufReader::new(stdout);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        // Bytes, not `lines()`: one stray non-UTF-8 byte must not end the chat.
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Some(incoming) = parse_line(&String::from_utf8_lossy(&buf)) {
                    chat.handle(incoming);
                }
            }
        }
    }
    chat.finish();
}

fn read_stderr(chat: Arc<Chat>, mut stderr: impl Read) {
    let mut buf = [0u8; 2048];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => push_tail(&mut lock(&chat.stderr), &buf[..n], STDERR_TAIL),
        }
    }
    chat.stderr_done.store(true, Ordering::Release);
}

/// A chat in `ChatState`; dropping it kills the agent.
struct ChatSession {
    chat: Arc<Chat>,
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        self.chat.kill();
    }
}

pub struct ChatState {
    sessions: Mutex<HashMap<String, ChatSession>>,
    /// Counts the chats started or ended and the status changes, so the
    /// remote access server hears of them.
    changes: watch::Sender<u64>,
    alerts: broadcast::Sender<ChatAlert>,
}

impl Default for ChatState {
    fn default() -> Self {
        ChatState {
            sessions: Mutex::new(HashMap::new()),
            changes: watch::channel(0).0,
            alerts: broadcast::channel(32).0,
        }
    }
}

impl ChatState {
    fn changed(&self) {
        self.changes.send_modify(|n| *n += 1);
    }

    pub(crate) fn watch_changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    pub(crate) fn watch_alerts(&self) -> broadcast::Receiver<ChatAlert> {
        self.alerts.subscribe()
    }

    /// Every running chat, in no particular order.
    pub(crate) fn list(&self) -> Vec<ChatSummary> {
        lock(&self.sessions)
            .values()
            .map(|s| ChatSummary {
                chat_id: s.chat.id.clone(),
                agent: s.chat.agent.clone(),
                cwd: s.chat.cwd.clone(),
                profile: s.chat.profile.clone(),
                session_id: s.chat.session_id.get().cloned(),
                modes: s.chat.modes.get().cloned(),
                status: *lock(&s.chat.status),
            })
            .collect()
    }

    /// The events after `after_seq` and a receiver of every one that follows -
    /// taken under the log lock, so none is missed or doubled in between.
    pub(crate) fn subscribe(
        &self,
        chat_id: &str,
        after_seq: u64,
    ) -> Result<(Vec<ChatEvent>, broadcast::Receiver<ChatEvent>), String> {
        let chat = self.get(chat_id)?;
        let log = lock(&chat.log);
        let events = log.events.iter().filter(|e| e.seq > after_seq).cloned().collect();
        Ok((events, chat.feed.subscribe()))
    }

    /// Hands the agent a prompt, recording it as the user's.
    pub(crate) fn prompt(&self, chat_id: &str, text: String) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        let session_id = chat.session_id()?.to_string();
        chat.emit(ChatBody::User { text: text.clone() });
        let id = chat.register(Pending::Prompt)?;
        chat.send_request(
            id,
            "session/prompt",
            json!({ "sessionId": session_id, "prompt": [{ "type": "text", "text": text }] }),
        )
    }

    pub(crate) fn cancel(&self, chat_id: &str) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        let sent = chat.notify("session/cancel", json!({ "sessionId": chat.session_id()? }));
        // ACP: every permission request still open when a turn is cancelled
        // is answered as cancelled.
        chat.cancel_permissions();
        sent
    }

    pub(crate) fn permission(&self, chat_id: &str, request_id: &Value, option_id: Option<&str>) -> Result<(), String> {
        self.get(chat_id)?.resolve_permission(request_id, option_id)
    }

    /// Waits for the agent's answer, so it runs on the blocking pool.
    pub(crate) async fn set_mode(&self, chat_id: &str, mode_id: String) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        crate::blocking(move || {
            let session_id = chat.session_id()?.to_string();
            chat.request("session/set_mode", json!({ "sessionId": session_id, "modeId": mode_id }), MODE_TIMEOUT)
                .map(|_| ())
        })
        .await
    }

    fn get(&self, chat_id: &str) -> Result<Arc<Chat>, String> {
        lock(&self.sessions).get(chat_id).map(|s| Arc::clone(&s.chat)).ok_or_else(|| "unknown chat".to_string())
    }

    /// Kills every chat shown in the window `label` - called when that window
    /// is destroyed. The kills happen off this thread, after the lock is released.
    pub fn kill_owned_by(&self, label: &str) {
        let doomed: Vec<ChatSession> = {
            let mut sessions = lock(&self.sessions);
            let ids: Vec<String> =
                sessions.iter().filter(|(_, s)| s.chat.owner == label).map(|(id, _)| id.clone()).collect();
            ids.iter().filter_map(|id| sessions.remove(id)).collect()
        };
        if !doomed.is_empty() {
            self.changed();
            std::thread::spawn(move || drop(doomed));
        }
    }
}

/// Starts the agent's ACP server in `cwd` with its pipes open.
fn spawn_agent(app: &AppHandle, agent: &str, cwd: &str, profile: Option<&str>) -> Result<(Child, String), String> {
    let (program, args) = launch_command(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    let line = std::iter::once(program).chain(args.iter().copied()).collect::<Vec<_>>().join(" ");
    // Through cmd on Windows so npm's `.cmd` shims resolve.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut cmd = Command::new("cmd");
        cmd.arg("/C").arg(program).args(args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(program);
        cmd.args(args);
        cmd.process_group(0);
        cmd
    };
    cmd.current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in crate::profiles::env_for(app, profile) {
        cmd.env(k, v);
    }
    let child = cmd.spawn().map_err(|e| format!("could not start `{line}`: {e}"))?;
    Ok((child, line))
}

/// `initialize`, then `session/load` or `session/new`.
fn handshake(chat: &Chat, cwd: &str, resume: Option<String>) -> Result<(Value, String, bool), String> {
    let init = chat.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
            "clientInfo": { "name": "flowcode", "version": env!("CARGO_PKG_VERSION") },
        }),
        SETUP_TIMEOUT,
    )?;
    let can_load = init.pointer("/agentCapabilities/loadSession").and_then(Value::as_bool).unwrap_or(false);
    match resume.filter(|id| can_load && !id.is_empty()) {
        Some(session_id) => {
            let result = chat.request(
                "session/load",
                json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] }),
                SETUP_TIMEOUT,
            )?;
            Ok((result, session_id, true))
        }
        None => {
            let result = chat.request("session/new", json!({ "cwd": cwd, "mcpServers": [] }), SETUP_TIMEOUT)?;
            let session_id = result
                .get("sessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| "session/new returned no sessionId".to_string())?
                .to_string();
            Ok((result, session_id, false))
        }
    }
}

fn start_blocking(
    app: AppHandle,
    owner: String,
    agent: String,
    cwd: String,
    profile: Option<String>,
    resume: Option<String>,
) -> Result<(Arc<Chat>, ChatStarted), String> {
    let (mut child, line) = spawn_agent(&app, &agent, &cwd, profile.as_deref())?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("could not open the pipes of `{line}`"));
    };
    let chat_id = uuid::Uuid::new_v4().to_string();
    let chat = Arc::new(Chat {
        id: chat_id.clone(),
        app,
        owner,
        agent: agent.clone(),
        cwd: cwd.clone(),
        profile,
        child: Mutex::new(child),
        writer: Mutex::new(stdin),
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        permissions: Mutex::new(HashMap::new()),
        log: Mutex::new(Log { seq: 0, events: VecDeque::new() }),
        feed: broadcast::channel(FEED_CAPACITY).0,
        status: Mutex::new(ChatStatus::Starting),
        stderr: Mutex::new(Vec::new()),
        stderr_done: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        session_id: OnceLock::new(),
        modes: OnceLock::new(),
    });
    {
        let chat = Arc::clone(&chat);
        std::thread::spawn(move || read_stdout(chat, stdout));
    }
    {
        let chat = Arc::clone(&chat);
        std::thread::spawn(move || read_stderr(chat, stderr));
    }
    match handshake(&chat, &cwd, resume) {
        Ok((result, session_id, loaded)) => {
            let _ = chat.session_id.set(session_id.clone());
            if let Some(modes) = result.get("modes") {
                let _ = chat.modes.set(modes.clone());
            }
            chat.set_status(ChatStatus::Idle);
            let started = ChatStarted {
                chat_id,
                session_id,
                agent,
                modes: result.get("modes").cloned(),
                config_options: result.get("configOptions").cloned(),
                loaded,
            };
            Ok((chat, started))
        }
        Err(e) => {
            chat.kill();
            Err(if e.starts_with("auth_required") { e } else { format!("`{line}`: {e}") })
        }
    }
}

#[tauri::command]
pub async fn chat_start(
    app: AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, ChatState>,
    agent: String,
    cwd: String,
    profile: Option<String>,
    resume_session_id: Option<String>,
) -> Result<ChatStarted, String> {
    let owner = window.label().to_string();
    let (chat, started) =
        crate::blocking(move || start_blocking(app, owner, agent, cwd, profile, resume_session_id)).await?;
    lock(&state.sessions).insert(started.chat_id.clone(), ChatSession { chat });
    state.changed();
    Ok(started)
}

#[tauri::command(async)]
pub fn chat_prompt(state: State<'_, ChatState>, chat_id: String, text: String) -> Result<(), String> {
    state.prompt(&chat_id, text)
}

#[tauri::command(async)]
pub fn chat_cancel(state: State<'_, ChatState>, chat_id: String) -> Result<(), String> {
    state.cancel(&chat_id)
}

#[tauri::command(async)]
pub fn chat_permission(
    state: State<'_, ChatState>,
    chat_id: String,
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    state.permission(&chat_id, &request_id, option_id.as_deref())
}

#[tauri::command]
pub async fn chat_set_mode(state: State<'_, ChatState>, chat_id: String, mode_id: String) -> Result<(), String> {
    state.set_mode(&chat_id, mode_id).await
}

#[tauri::command(async)]
pub fn chat_close(state: State<'_, ChatState>, chat_id: String) -> Result<(), String> {
    // Dropping the session kills the agent.
    let session = lock(&state.sessions).remove(&chat_id);
    drop(session);
    state.changed();
    Ok(())
}

#[tauri::command]
pub fn chat_events(state: State<'_, ChatState>, chat_id: String, after_seq: u64) -> Result<Vec<ChatEvent>, String> {
    let chat = state.get(&chat_id)?;
    let log = lock(&chat.log);
    Ok(log.events.iter().filter(|e| e.seq > after_seq).cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_lines_into_responses_requests_and_notifications() {
        let Some(Incoming::Response { id: 3, result: Ok(result) }) =
            parse_line(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#)
        else {
            panic!("not a response");
        };
        assert_eq!(result["stopReason"], "end_turn");

        let Some(Incoming::Response { id: 4, result: Err(err) }) =
            parse_line(r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"Authentication required"}}"#)
        else {
            panic!("not an error response");
        };
        assert_eq!((err.code, err.message.as_str()), (-32000, "Authentication required"));

        // Agent request ids may be strings.
        let Some(Incoming::Request { id, method, .. }) =
            parse_line(r#"{"jsonrpc":"2.0","id":"a1","method":"fs/read_text_file","params":{}}"#)
        else {
            panic!("not a request");
        };
        assert_eq!((id, method.as_str()), (json!("a1"), "fs/read_text_file"));

        assert!(matches!(
            parse_line(r#"{"jsonrpc":"2.0","method":"session/update","params":{"update":{}}}"#),
            Some(Incoming::Notification { .. })
        ));
    }

    #[test]
    fn skips_lines_that_are_not_jsonrpc() {
        assert!(parse_line("").is_none());
        assert!(parse_line("INFO starting up").is_none());
        assert!(parse_line("{ broken").is_none());
        assert!(parse_line("[1,2]").is_none());
        assert!(parse_line(r#"{"hello":"world"}"#).is_none());
        // A response whose id isn't one of ours.
        assert!(parse_line(r#"{"id":"x","result":{}}"#).is_none());
    }

    #[test]
    fn recognizes_authentication_errors() {
        let err = |code, message: &str| RpcError { code, message: message.to_string() };
        assert_eq!(error_text(&err(-32000, "Authentication required")), "auth_required: Authentication required");
        assert!(is_auth_error(&err(1, "please authenticate first")));
        assert_eq!(error_text(&err(-32602, "Invalid params")), "Invalid params");
    }

    #[test]
    fn events_serialize_camel_case_tagged_by_kind() {
        let event = ChatEvent { seq: 7, at: 99, body: ChatBody::TurnEnd { stop_reason: "end_turn".into() } };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "seq": 7, "at": 99, "kind": "turnEnd", "stopReason": "end_turn" })
        );
        let event = ChatEvent {
            seq: 1,
            at: 2,
            body: ChatBody::PermissionResolved { request_id: json!(5), option_id: None },
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "seq": 1, "at": 2, "kind": "permissionResolved", "requestId": 5, "optionId": null })
        );
        let event = ChatEvent { seq: 3, at: 4, body: ChatBody::Update { update: json!({ "sessionUpdate": "x" }) } };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "seq": 3, "at": 4, "kind": "update", "update": { "sessionUpdate": "x" } })
        );
        let event = ChatEvent {
            seq: 5,
            at: 6,
            body: ChatBody::Ext { method: "_session/retrying".into(), params: json!({ "category": "rate_limited" }) },
        };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            json!({ "seq": 5, "at": 6, "kind": "ext", "method": "_session/retrying", "params": { "category": "rate_limited" } })
        );
    }

    #[test]
    fn keeps_only_the_tail_of_stderr() {
        let mut buf = Vec::new();
        push_tail(&mut buf, b"abcdef", 4);
        assert_eq!(buf, b"cdef");
        push_tail(&mut buf, b"gh", 4);
        assert_eq!(buf, b"efgh");
    }

    #[test]
    fn knows_how_to_launch_each_agent() {
        assert_eq!(launch_command("vibe"), Some(("vibe-acp", &[][..])));
        assert_eq!(launch_command("gemini"), Some(("gemini", &["--experimental-acp"][..])));
        assert_eq!(launch_command("claude").map(|c| c.0), Some("npx"));
        assert_eq!(launch_command("codex").map(|c| c.0), Some("npx"));
        assert!(launch_command("nope").is_none());
    }
}
