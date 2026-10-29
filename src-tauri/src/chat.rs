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
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
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

/// Most text kept per chat log (approximated by the length of its strings),
/// oldest events dropped first: a long chat streams far more text than the
/// event count alone bounds once its chunks are merged (see `LogEntry`).
const MAX_LOG_BYTES: usize = 32 * 1024 * 1024;

/// How much of an agent's stderr is kept to explain why it died.
const STDERR_TAIL: usize = 4 * 1024;

/// ACP's "method not found" JSON-RPC error code.
const METHOD_NOT_FOUND: i64 = -32601;

/// Replies the reader thread may queue for the chat's writer thread (see
/// `Chat::replies`) before further ones are dropped.
const REPLY_QUEUE: usize = 64;

/// Longest line read from the agent's stdout: past it the rest of that line
/// is skipped, not buffered - a runaway agent must not grow one `Vec` until
/// the app runs out of memory.
const MAX_LINE_BYTES: usize = 16 * 1024 * 1024;

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
    User {
        text: String,
        /// Names of the files sent along (the files themselves are not kept).
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        attachments: Vec<String>,
    },
    /// The agent asks for permission; answered with `chat_permission`.
    Permission { request_id: Value, tool_call: Value, options: Value },
    PermissionResolved { request_id: Value, option_id: Option<String> },
    TurnEnd { stop_reason: String },
    Error { message: String },
    Exit { code: Option<i32> },
    /// An extension notification (its method starts with `_`), verbatim - or
    /// Flowcode's own `_flowcode/model` (the model changed). It doesn't
    /// change the chat's status.
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

/// The status a chat moves to when `body` is emitted while it is `before`;
/// `permissions_pending` says whether a permission request is still open
/// (after the bookkeeping of this very event).
///
/// Only the user's prompt starts a turn: agents keep sending updates between
/// turns (usage, commands, session info), and an adapter may even ask for a
/// permission outside one (it is still recorded, and answerable) - none of
/// that may make an idle chat look busy, or a prompt would be refused as
/// `agent_busy` with nothing ever ending the phantom turn.
fn next_status(before: ChatStatus, body: &ChatBody, permissions_pending: bool) -> ChatStatus {
    use ChatStatus::*;
    let in_turn = if permissions_pending { Waiting } else { Busy };
    match (before, body) {
        (Exited, _) | (_, ChatBody::Exit { .. }) => Exited,
        // A resumed session replays its history while starting: nothing
        // moves until the handshake is done (`Chat::started`).
        (Starting, _) => Starting,
        (_, ChatBody::TurnEnd { .. } | ChatBody::Error { .. }) => Idle,
        (_, ChatBody::Ext { .. }) => before,
        (Idle, ChatBody::User { .. }) => in_turn,
        (Idle, _) => Idle,
        (Busy | Waiting, _) => in_turn,
    }
}

/// Whether an event emitted while the chat is `before` is news a phone should
/// be alerted to: not the history a starting chat replays, nor anything after
/// the agent exited.
fn is_live(before: ChatStatus, body: &ChatBody) -> bool {
    match before {
        ChatStatus::Exited => false,
        ChatStatus::Starting => matches!(body, ChatBody::Exit { .. }),
        _ => true,
    }
}

/// Whether a prompt may be sent to a chat that is `status`. One turn at a time:
/// two windows (or a phone and the desktop) prompting at once must not
/// interleave turns, so anything but idle is refused (the frontend queues the
/// message and sends it when the turn ends).
fn prompt_gate(status: ChatStatus) -> Result<(), String> {
    match status {
        ChatStatus::Idle => Ok(()),
        ChatStatus::Exited => Err("agent_exited: the agent has exited".into()),
        ChatStatus::Starting => Err("agent_busy: the agent is still starting".into()),
        ChatStatus::Busy | ChatStatus::Waiting => Err("agent_busy: the agent is still working on its turn".into()),
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
    /// The normalized models (`ChatModels::to_json`), when the agent offers any.
    pub models: Option<Value>,
    pub status: ChatStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStarted {
    pub chat_id: String,
    pub session_id: String,
    pub agent: String,
    pub modes: Option<Value>,
    /// The normalized models (`ChatModels::to_json`), when the agent offers any.
    pub models: Option<Value>,
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

/// The program and arguments that start an agent's ACP server (for the npm
/// adapters, the `npx` fallback used until `acp_adapters` has installed one).
fn launch_command(agent: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match agent {
        "vibe" => ("vibe-acp", &[]),
        "gemini" => ("gemini", &["--experimental-acp"]),
        "claude" => ("npx", &["-y", "@agentclientprotocol/claude-agent-acp"]),
        "codex" => ("npx", &["-y", "@agentclientprotocol/codex-acp"]),
        _ => return None,
    })
}

/// The text of a streamed agent message or thought chunk, with what another
/// chunk must share to be merged with it: its `sessionUpdate` kind and its
/// `messageId` (if the agent sends one). `None` for any other update.
fn text_chunk(update: &Value) -> Option<(&str, Option<&Value>, &str)> {
    let kind = update.get("sessionUpdate")?.as_str()?;
    if kind != "agent_message_chunk" && kind != "agent_thought_chunk" {
        return None;
    }
    let content = update.get("content")?;
    if content.get("type")?.as_str()? != "text" {
        return None;
    }
    let text = content.get("text")?.as_str()?;
    Some((kind, update.get("messageId").filter(|id| !id.is_null()), text))
}

/// Whether `session/update` params name the session `stale` (one whose load
/// failed and was replaced). Updates without a `sessionId` are kept.
fn is_stale_update(params: &Value, stale: Option<&str>) -> bool {
    stale.is_some_and(|stale| params.get("sessionId").and_then(Value::as_str) == Some(stale))
}

/// The extension event that tells every view a chat's model changed; its
/// params are the normalized models (`ChatModels::to_json`).
const MODEL_EXT_METHOD: &str = "_flowcode/model";

/// One model the agent offers.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ModelChoice {
    id: String,
    name: String,
    description: Option<String>,
    /// The caption of the group it is listed under (grouped config options).
    group: Option<String>,
}

/// Which ACP API changes the model: the two coexist while the protocol moves
/// from the unstable `models` to the session config options.
#[derive(Clone, Debug, PartialEq)]
enum ModelVia {
    /// `session/set_model` (the `models` of `session/new` / `session/load`).
    Models,
    /// `session/set_config_option` on the option with this id.
    ConfigOption { config_id: String },
}

/// The models a chat's agent offers, whichever API announced them.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ChatModels {
    current: String,
    available: Vec<ModelChoice>,
    via: ModelVia,
}

impl ChatModels {
    /// What the frontend gets: the shape of ACP's `models`, plus `group`.
    fn to_json(&self) -> Value {
        let available: Vec<Value> = self
            .available
            .iter()
            .map(|m| {
                let mut entry = json!({ "modelId": m.id, "name": m.name });
                if let Some(description) = &m.description {
                    entry["description"] = json!(description);
                }
                if let Some(group) = &m.group {
                    entry["group"] = json!(group);
                }
                entry
            })
            .collect();
        json!({ "currentModelId": self.current, "availableModels": available })
    }

    fn offers(&self, model_id: &str) -> bool {
        self.available.iter().any(|m| m.id == model_id)
    }
}

fn opt_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The unstable ACP `models` object: `{ currentModelId, availableModels:
/// [{ modelId, name, description? }] }`. Entries without an id are skipped,
/// a name falls back to the id; `None` when nothing usable is left.
fn models_from_models(models: &Value) -> Option<ChatModels> {
    let current = opt_str(models, "currentModelId")?;
    let available: Vec<ModelChoice> = models
        .get("availableModels")?
        .as_array()?
        .iter()
        .filter_map(|m| {
            let id = opt_str(m, "modelId")?;
            Some(ModelChoice { name: opt_str(m, "name").unwrap_or_else(|| id.clone()), id, description: opt_str(m, "description"), group: None })
        })
        .collect();
    (!available.is_empty()).then_some(ChatModels { current, available, via: ModelVia::Models })
}

/// The model option of ACP session config options: the `select` option of
/// category `model` (else the one with id `model`). Its options may be flat
/// (`{ value, name, description? }`) or grouped (`{ group, name, options }`);
/// groups are flattened, their name kept as each model's caption.
fn models_from_config_options(options: &Value) -> Option<ChatModels> {
    let options = options.as_array()?;
    let is_model = |o: &&Value| o.get("category").and_then(Value::as_str) == Some("model");
    let option = options
        .iter()
        .find(is_model)
        .or_else(|| options.iter().find(|o| o.get("id").and_then(Value::as_str) == Some("model")))?;
    if option.get("type").and_then(Value::as_str).is_some_and(|t| t != "select") {
        return None;
    }
    let config_id = opt_str(option, "id")?;
    let current = opt_str(option, "currentValue")?;
    let choice = |v: &Value, group: Option<&String>| {
        let id = opt_str(v, "value")?;
        Some(ModelChoice {
            name: opt_str(v, "name").unwrap_or_else(|| id.clone()),
            id,
            description: opt_str(v, "description"),
            group: group.cloned(),
        })
    };
    let mut available = Vec::new();
    for entry in option.get("options")?.as_array()? {
        match entry.get("options").and_then(Value::as_array) {
            Some(grouped) => {
                let caption = opt_str(entry, "name").or_else(|| opt_str(entry, "group"));
                available.extend(grouped.iter().filter_map(|v| choice(v, caption.as_ref())));
            }
            None => available.extend(choice(entry, None)),
        }
    }
    (!available.is_empty()).then_some(ChatModels { current, available, via: ModelVia::ConfigOption { config_id } })
}

/// The models a `session/new` / `session/load` result announces: its config
/// options when they have a model option (the newer API), else its `models`.
fn normalize_models(result: &Value) -> Option<ChatModels> {
    result
        .get("configOptions")
        .and_then(models_from_config_options)
        .or_else(|| result.get("models").and_then(models_from_models))
}

/// The models after the agent accepted `model_id`: a `set_config_option`
/// answer carries every option anew (the agent may have changed the list),
/// otherwise only the current model moved.
fn models_after_set(before: &ChatModels, result: &Value, model_id: &str) -> ChatModels {
    let fresh = match before.via {
        ModelVia::ConfigOption { .. } => result.get("configOptions").and_then(models_from_config_options),
        ModelVia::Models => None,
    };
    fresh.unwrap_or_else(|| ChatModels { current: model_id.to_string(), ..before.clone() })
}

/// The models after a `config_option_update`: `Some(new)` when they changed.
/// An update without a model option only matters to models that came from
/// config options (they're gone); `session/set_model` ones stay.
fn models_after_config_update(before: Option<&ChatModels>, options: &Value) -> Option<Option<ChatModels>> {
    let next = match models_from_config_options(options) {
        Some(models) => Some(models),
        None if matches!(before, Some(ChatModels { via: ModelVia::ConfigOption { .. }, .. })) => None,
        None => return None,
    };
    (next.as_ref() != before).then_some(next)
}

/// Roughly how many bytes a JSON value takes: its strings and keys, plus a
/// little for the rest. Cheaper than serializing it, and enough for a cap.
fn approx_size(value: &Value) -> usize {
    match value {
        Value::String(s) => s.len() + 2,
        Value::Array(items) => 2 + items.iter().map(approx_size).sum::<usize>(),
        Value::Object(map) => 2 + map.iter().map(|(k, v)| k.len() + 4 + approx_size(v)).sum::<usize>(),
        _ => 8,
    }
}

/// `approx_size` of an event, with its envelope.
fn body_size(body: &ChatBody) -> usize {
    64 + match body {
        ChatBody::Update { update } => approx_size(update),
        ChatBody::User { text, .. } => text.len(),
        ChatBody::Permission { request_id, tool_call, options } => {
            approx_size(request_id) + approx_size(tool_call) + approx_size(options)
        }
        ChatBody::PermissionResolved { request_id, option_id } => {
            approx_size(request_id) + option_id.as_ref().map_or(0, String::len)
        }
        ChatBody::TurnEnd { stop_reason } => stop_reason.len(),
        ChatBody::Error { message } => message.len(),
        ChatBody::Exit { .. } => 0,
        ChatBody::Ext { method, params } => method.len() + approx_size(params),
    }
}

/// One entry of a chat's log. Agents stream a message a few tokens per
/// `session/update`, so the text chunks of one message (or thought) are merged
/// into a single entry - otherwise a long chat would spend `MAX_LOG_EVENTS` on
/// tokens and lose its start. Only the log merges: the live feed and the
/// window still get every chunk as its own event.
///
/// A merged entry carries the `seq` (and `at`) of its last chunk, so anyone
/// replaying from before it gets the whole text. Someone who already saw part
/// of the run live (its `after_seq` falls inside the run) must get only the
/// rest, or it would show that text twice: `offsets` remember where each
/// chunk's text starts, and `since` slices from the first chunk not yet seen.
struct LogEntry {
    event: ChatEvent,
    /// `seq` of the first chunk in this entry; `event.seq` is the last one's,
    /// and the chunks in between have every `seq` in between (only the last
    /// entry takes merges, and only from the very next event).
    first_seq: u64,
    /// Byte offset in the merged text at which each chunk starts, in `seq`
    /// order. Empty for an entry that isn't a text chunk: it never merges.
    offsets: Vec<usize>,
    /// `body_size`, grown with each merge - what `Log::bytes` counts.
    size: usize,
}

impl LogEntry {
    fn new(event: ChatEvent) -> Self {
        let offsets = match &event.body {
            ChatBody::Update { update } if text_chunk(update).is_some() => vec![0],
            _ => Vec::new(),
        };
        LogEntry { first_seq: event.seq, size: body_size(&event.body), offsets, event }
    }

    /// Merges `next` into this entry if both are text chunks of the same
    /// message and `next` directly follows; returns the bytes added.
    fn absorb(&mut self, next: &ChatEvent) -> Option<usize> {
        if self.offsets.is_empty() || next.seq != self.event.seq + 1 {
            return None;
        }
        let ChatBody::Update { update: next_update } = &next.body else { return None };
        let (kind, message_id, text) = text_chunk(next_update)?;
        let ChatBody::Update { update } = &mut self.event.body else { return None };
        if !matches!(text_chunk(update), Some((k, id, _)) if k == kind && id == message_id) {
            return None;
        }
        // A subagent's text (stamped with its launch call) never merges into another's or the main agent's.
        let parent = |u: &Value| u.pointer("/_meta/claudeCode/parentToolUseId").and_then(Value::as_str).map(str::to_owned);
        if parent(update) != parent(next_update) {
            return None;
        }
        let Some(Value::String(merged)) = update.pointer_mut("/content/text") else { return None };
        self.offsets.push(merged.len());
        merged.push_str(text);
        self.event.seq = next.seq;
        self.event.at = next.at;
        self.size += text.len();
        Some(text.len())
    }

    /// This entry for someone who has seen every event up to `after_seq`
    /// (which is below `event.seq`): whole, or only the text of the chunks
    /// after `after_seq` if that falls inside the merged run.
    fn since(&self, after_seq: u64) -> ChatEvent {
        let mut event = self.event.clone();
        if after_seq < self.first_seq || after_seq >= self.event.seq {
            return event;
        }
        let Some(&offset) = usize::try_from(after_seq - self.first_seq + 1).ok().and_then(|i| self.offsets.get(i)) else {
            return event;
        };
        if let ChatBody::Update { update } = &mut event.body {
            if let Some(Value::String(text)) = update.pointer_mut("/content/text") {
                // Always a boundary: each offset is where a whole chunk began.
                if text.is_char_boundary(offset) {
                    text.drain(..offset);
                }
            }
        }
        event
    }
}

/// A chat's numbered events, as `chat_events` and the phones replay them.
struct Log {
    /// The last `seq` given out: never reused, even after `reset`.
    seq: u64,
    events: VecDeque<LogEntry>,
    /// Sum of the entries' `size`.
    bytes: usize,
    max_events: usize,
    max_bytes: usize,
}

impl Log {
    fn new(max_events: usize, max_bytes: usize) -> Self {
        Log { seq: 0, events: VecDeque::new(), bytes: 0, max_events, max_bytes }
    }

    /// Numbers `body` and records it, dropping the oldest entries past the
    /// caps (always keeping the newest). Returns the event as it happened -
    /// what the live feed carries - even when the log merged it.
    fn push(&mut self, body: ChatBody, at: u64) -> ChatEvent {
        self.seq += 1;
        let event = ChatEvent { seq: self.seq, at, body };
        match self.events.back_mut().and_then(|last| last.absorb(&event)) {
            Some(added) => self.bytes += added,
            None => {
                let entry = LogEntry::new(event.clone());
                self.bytes += entry.size;
                self.events.push_back(entry);
            }
        }
        while self.events.len() > self.max_events || (self.bytes > self.max_bytes && self.events.len() > 1) {
            let Some(dropped) = self.events.pop_front() else { break };
            self.bytes = self.bytes.saturating_sub(dropped.size);
        }
        event
    }

    /// What someone who has seen every event up to `after_seq` is missing
    /// (`LogEntry::since`: nothing it saw comes back).
    fn after(&self, after_seq: u64) -> Vec<ChatEvent> {
        // Entries are in `seq` order: a merge only ever raises the last one's.
        let start = self.events.partition_point(|e| e.event.seq <= after_seq);
        self.events.range(start..).map(|e| e.since(after_seq)).collect()
    }

    /// Forgets every event but keeps counting from the last `seq`, so the
    /// numbering stays strictly increasing for anyone who saw some.
    fn reset(&mut self) {
        self.events.clear();
        self.bytes = 0;
    }
}

/// A file sent along with a prompt: its bytes (base64) or a path on this PC.
#[derive(Deserialize, Debug)]
pub struct Attachment {
    name: String,
    mime: String,
    data: Option<String>,
    path: Option<String>,
}

/// A name that is safe as a single path component.
fn sanitize_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let clean: String = base.chars().filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|')).collect();
    let clean = clean.trim().trim_matches('.').to_string();
    if clean.is_empty() { "attachment".into() } else { clean }
}

/// `file:///C:/x%20y` for an absolute path (percent-encoded, forward slashes).
fn file_uri(path: &std::path::Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    let raw = raw.strip_prefix("//?/").unwrap_or(&raw);
    let mut uri = String::from("file://");
    if !raw.starts_with('/') {
        uri.push('/');
    }
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || b"/-._~:".contains(&b) {
            uri.push(b as char);
        } else {
            uri.push_str(&format!("%{b:02X}"));
        }
    }
    uri
}

/// The ACP content block for one attachment: an inline `image` when the
/// agent takes them, else a `resource_link` to a file (the baseline every
/// agent accepts; it opens the file with its own tools).
fn attachment_block(a: &Attachment, images: bool) -> Result<Value, String> {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD;
    if images && a.mime.starts_with("image/") {
        let data = match (&a.data, &a.path) {
            (Some(data), _) => data.clone(),
            (None, Some(path)) => b64.encode(std::fs::read(path).map_err(|e| format!("could not read {path}: {e}"))?),
            _ => return Err(format!("attachment {} has no content", a.name)),
        };
        return Ok(json!({ "type": "image", "mimeType": a.mime, "data": data }));
    }
    let path = match (&a.data, &a.path) {
        (Some(data), _) => {
            let bytes = b64.decode(data).map_err(|e| format!("bad attachment {}: {e}", a.name))?;
            let dir = std::env::temp_dir().join("flowcode-attachments").join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&dir).map_err(|e| format!("could not save {}: {e}", a.name))?;
            let file = dir.join(sanitize_name(&a.name));
            std::fs::write(&file, bytes).map_err(|e| format!("could not save {}: {e}", a.name))?;
            file
        }
        (None, Some(path)) => std::path::PathBuf::from(path),
        _ => return Err(format!("attachment {} has no content", a.name)),
    };
    Ok(json!({ "type": "resource_link", "uri": file_uri(&path), "name": a.name, "mimeType": a.mime }))
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
    /// Replies the reader thread owes the agent, written by the chat's own
    /// writer thread (`write_replies`): the reader must never block on the
    /// agent's stdin - an agent busy writing to a full stdout isn't reading
    /// it, and nobody would read that stdout. Bounded, unlike a thread per
    /// reply: an agent flooding requests gets replies dropped, not threads.
    replies: mpsc::SyncSender<Value>,
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
    /// The models the agent offers; unlike the modes they change after the
    /// start (`chat_set_model`, a `config_option_update`), hence the mutex.
    models: Mutex<Option<ChatModels>>,
    /// A session whose `session/load` failed and was replaced by a new one:
    /// whatever history it still streams (a timed-out load may go on) is
    /// dropped. Set under the log lock, and checked under it (`emit_when`).
    stale_session: Mutex<Option<String>>,
    /// The agent announced it takes image blocks in a prompt (`promptCapabilities.image`).
    prompt_images: AtomicBool,
}

impl Chat {
    /// Logs an event and sends it to the owner window and the phones.
    fn emit(&self, body: ChatBody) {
        let _ = self.emit_when(body, |_| Ok(()));
    }

    /// `emit`, if `allow` accepts the status the chat is in; its error
    /// otherwise, and nothing is emitted. The check, the status move and the
    /// logging all happen under the log lock, so no other event slips in
    /// between - which is what makes `ChatState::prompt`'s "only when idle"
    /// atomic. The log lock is held while sending too, so events reach the
    /// window and the phones in `seq` order and `ChatState::subscribe` can
    /// take the log and the feed in one go; neither send blocks (a broadcast
    /// and a queued webview event). Lock order: log, status, permissions -
    /// nothing may call this holding `permissions` or `status`.
    fn emit_when(&self, body: ChatBody, allow: impl FnOnce(ChatStatus) -> Result<(), String>) -> Result<(), String> {
        let mut log = lock(&self.log);
        let (before, after) = {
            let mut status = lock(&self.status);
            let before = *status;
            allow(before)?;
            let permissions_pending = !lock(&self.permissions).is_empty();
            *status = next_status(before, &body, permissions_pending);
            (before, *status)
        };
        let live = is_live(before, &body);
        let event = log.push(body, now_ms());
        let _ = self.feed.send(event.clone());
        if !self.closed.load(Ordering::Relaxed) {
            let _ = self.app.emit_to(&self.owner, "chat-event", json!({ "chatId": self.id, "event": event }));
        }
        drop(log);
        if after != before {
            self.changed();
        }
        if live {
            self.alert(&event.body);
        }
        Ok(())
    }

    /// The handshake is done: the chat goes from starting to idle - only from
    /// starting, since the agent may already have exited and a dead chat must
    /// not look idle.
    fn started(&self) {
        let moved = {
            let mut status = lock(&self.status);
            let moved = *status == ChatStatus::Starting;
            if moved {
                *status = ChatStatus::Idle;
            }
            moved
        };
        if moved {
            self.changed();
        }
    }

    /// A `session/load` of `session_id` failed and a new session replaces it:
    /// the history the load already replayed would show up in the new
    /// session's log, so the log is emptied (nobody has read it yet - the
    /// chat isn't listed nor known to its window before `chat_start` answers)
    /// and whatever that session still streams is dropped from now on.
    fn forget_session(&self, session_id: &str) {
        let mut log = lock(&self.log);
        *lock(&self.stale_session) = Some(session_id.to_string());
        log.reset();
    }

    /// The new session took the id of the one `forget_session` dropped (an
    /// agent that reuses ids): its updates are this chat's after all.
    fn unforget_session(&self, session_id: &str) {
        let mut stale = lock(&self.stale_session);
        if stale.as_deref() == Some(session_id) {
            *stale = None;
        }
    }

    /// Whether a `session/update`'s params belong to a session `forget_session` dropped.
    fn is_stale(&self, params: &Value) -> bool {
        is_stale_update(params, lock(&self.stale_session).as_deref())
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

    /// Switches the agent to `model_id` (one it offers) through whichever API
    /// announced the models. Allowed mid-turn: ACP applies it from the next
    /// prompt. Every view hears of it through a `_flowcode/model` event, the
    /// phones' chat list through `changed`.
    fn set_model(&self, model_id: &str) -> Result<(), String> {
        let session_id = self.session_id()?.to_string();
        let via = {
            let models = lock(&self.models);
            let models = models.as_ref().ok_or_else(|| "the agent offers no model to choose".to_string())?;
            if !models.offers(model_id) {
                return Err(format!("unknown model: {model_id}"));
            }
            models.via.clone()
        };
        let result = match &via {
            ModelVia::Models => self.request(
                "session/set_model",
                json!({ "sessionId": session_id, "modelId": model_id }),
                MODE_TIMEOUT,
            )?,
            ModelVia::ConfigOption { config_id } => self.request(
                "session/set_config_option",
                json!({ "sessionId": session_id, "configId": config_id, "value": model_id }),
                MODE_TIMEOUT,
            )?,
        };
        let next = {
            let mut models = lock(&self.models);
            let Some(before) = models.as_ref() else { return Ok(()) };
            let next = models_after_set(before, &result, model_id);
            *models = Some(next.clone());
            next
        };
        self.models_changed(Some(&next));
        Ok(())
    }

    /// The agent pushed new config options: stores the model part, if it moved.
    fn config_options_changed(&self, options: &Value) {
        let next = {
            let mut models = lock(&self.models);
            let Some(next) = models_after_config_update(models.as_ref(), options) else { return };
            *models = next.clone();
            next
        };
        self.models_changed(next.as_ref());
    }

    /// Tells the views (an event, so a replay knows too) and the phones' list.
    /// Called without the `models` lock: `emit` takes the log lock.
    fn models_changed(&self, models: Option<&ChatModels>) {
        let params = models.map_or_else(|| json!({ "currentModelId": null, "availableModels": [] }), ChatModels::to_json);
        self.emit(ChatBody::Ext { method: MODEL_EXT_METHOD.to_string(), params });
        self.changed();
    }

    fn handle(self: &Arc<Self>, incoming: Incoming) {
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
                    // No fs or terminal capability was advertised. Answered
                    // by the writer thread (see `replies`).
                    let reply = json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "error": { "code": METHOD_NOT_FOUND, "message": "Method not found" },
                    });
                    if let Err(mpsc::TrySendError::Full(_)) = self.replies.try_send(reply) {
                        eprintln!("chat {}: too many unanswered agent requests, dropping the reply to `{method}`", self.id);
                    }
                }
            }
            Incoming::Notification { method, params } => {
                if method == "session/update" {
                    if let Some(update) = params.get("update") {
                        if update.get("sessionUpdate").and_then(Value::as_str) == Some("config_option_update")
                            && !self.is_stale(&params)
                        {
                            if let Some(options) = update.get("configOptions") {
                                self.config_options_changed(options);
                            }
                        }
                        // The staleness is checked under the log lock, so a
                        // late update can't pass it, then land after the
                        // `forget_session` that emptied the log.
                        let stale = |_| if self.is_stale(&params) { Err(String::new()) } else { Ok(()) };
                        let _ = self.emit_when(ChatBody::Update { update: update.clone() }, stale);
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
        // Nobody is left to answer the open permission requests: close each
        // in the views before they hear the agent exited. Taken out of the
        // map first - `emit` locks it - so a `resolve_permission` racing
        // this one resolves each request at most once between them.
        let permissions = std::mem::take(&mut *lock(&self.permissions));
        for request_id in permissions.into_values() {
            self.emit(ChatBody::PermissionResolved { request_id, option_id: None });
        }
        for pending in drained.into_values() {
            match pending {
                Pending::Waiter(tx) => {
                    let _ = tx.send(Err(message.clone()));
                }
                Pending::Prompt => self.emit(ChatBody::Error { message: message.clone() }),
            }
        }
        self.emit(ChatBody::Exit { code });
    }

    /// Waits (briefly) for the process to be gone, killing it if it lingers -
    /// with what it started, as `kill` does: killing only `cmd` (Windows) or
    /// the `npx` shim would leave the real agent running.
    fn reap(&self) -> Option<i32> {
        for _ in 0..40 {
            if let Ok(Some(status)) = lock(&self.child).try_wait() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut child = lock(&self.child);
        kill_if_running(&mut child);
        child.wait().ok().and_then(|status| status.code())
    }

    /// Kills the agent and what it started (an `npx` adapter runs the real
    /// agent as a child of its own). The reader thread reaps it.
    fn kill(&self) {
        self.closed.store(true, Ordering::Relaxed);
        let mut child = lock(&self.child);
        kill_if_running(&mut child);
        // Briefly, until it is really gone (`chat_close` promises a dead
        // agent); the reader thread still collects the status the same way.
        for _ in 0..40 {
            if !matches!(child.try_wait(), Ok(None)) {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}

/// `kill_tree` plus `Child::kill`, only while the child hasn't been reaped:
/// once `wait` collected it its pid is free for the OS to hand to an
/// unrelated process, which `taskkill /T` would then kill with its children.
fn kill_if_running(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        kill_tree(child.id());
        let _ = child.kill();
    }
}

/// The chat's writer thread: sends the queued replies (see `Chat::replies`)
/// until the chat is gone - its sender dropped with it.
fn write_replies(chat: Weak<Chat>, replies: mpsc::Receiver<Value>) {
    while let Ok(reply) = replies.recv() {
        let Some(chat) = chat.upgrade() else { return };
        let _ = chat.send(&reply);
    }
}

/// Reads one `\n`-terminated line into `buf` (cleared first), keeping at most
/// `max` bytes of it: the rest of a longer line is read and thrown away.
/// `Ok(None)` at the end of the stream, `Ok(Some(false))` for a cut line.
fn read_line_capped(reader: &mut impl BufRead, buf: &mut Vec<u8>, max: usize) -> std::io::Result<Option<bool>> {
    buf.clear();
    let mut complete = true;
    let mut read_any = false;
    loop {
        let chunk = match reader.fill_buf() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if chunk.is_empty() {
            return Ok(read_any.then_some(complete));
        }
        read_any = true;
        let (piece, done) = match chunk.iter().position(|&b| b == b'\n') {
            Some(i) => (&chunk[..=i], true),
            None => (chunk, false),
        };
        let room = max.saturating_sub(buf.len());
        if piece.len() > room {
            complete = false;
        }
        buf.extend_from_slice(&piece[..piece.len().min(room)]);
        let used = piece.len();
        reader.consume(used);
        if done {
            return Ok(Some(complete));
        }
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn kill_tree(pid: u32) {
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
pub(crate) fn kill_tree(pid: u32) {
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
        // Bytes, not `lines()`: one stray non-UTF-8 byte must not end the chat.
        match read_line_capped(&mut reader, &mut buf, MAX_LINE_BYTES) {
            Ok(None) | Err(_) => break,
            Ok(Some(true)) => {
                if let Some(incoming) = parse_line(&String::from_utf8_lossy(&buf)) {
                    chat.handle(incoming);
                }
            }
            Ok(Some(false)) => {
                eprintln!("chat {}: skipped an agent message over {MAX_LINE_BYTES} bytes", chat.id);
                chat.emit(ChatBody::Error {
                    message: format!("the agent sent a message over {} MiB; it was skipped", MAX_LINE_BYTES >> 20),
                });
            }
        }
    }
    chat.finish();
}

/// Keeps the tail of the agent's stderr. Holds the chat weakly: a grandchild
/// that outlived the agent (and so escaped `kill_tree`) can keep the pipe -
/// and this thread - open indefinitely, and must not keep the chat alive.
fn read_stderr(chat: Weak<Chat>, mut stderr: impl Read) {
    let mut buf = [0u8; 2048];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let Some(chat) = chat.upgrade() else { return };
                push_tail(&mut lock(&chat.stderr), &buf[..n], STDERR_TAIL);
            }
        }
    }
    if let Some(chat) = chat.upgrade() {
        chat.stderr_done.store(true, Ordering::Release);
    }
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

    /// The session ids of the running chats, so the agent scan can tell a
    /// chat's thread (Codex, Vibe) from a terminal tab's.
    pub(crate) fn live_session_ids(&self) -> std::collections::HashSet<String> {
        lock(&self.sessions).values().filter_map(|s| s.chat.session_id.get().cloned()).collect()
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
                models: lock(&s.chat.models).as_ref().map(ChatModels::to_json),
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
        let events = log.after(after_seq);
        Ok((events, chat.feed.subscribe()))
    }

    /// Hands the agent a prompt, recording it as the user's. Refused with
    /// `agent_busy` unless the chat is idle (`prompt_gate`; checked and moved
    /// to busy atomically by `emit_when`, so of two racing prompts exactly one
    /// starts the turn), `agent_exited` once the agent is gone.
    ///
    /// Once the `User` event is out, the turn must end: if the request can't
    /// be sent, an `Error` closes it (back to idle) - unless the agent's exit
    /// already failed the registered prompt, which emits that `Error` itself.
    pub(crate) fn prompt(&self, chat_id: &str, text: String, attachments: Vec<Attachment>) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        let session_id = chat.session_id()?.to_string();
        // File IO first: a failure here must not leave a turn open.
        let mut blocks = Vec::new();
        if !text.is_empty() || attachments.is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
        let images = chat.prompt_images.load(Ordering::Acquire);
        for attachment in &attachments {
            blocks.push(attachment_block(attachment, images)?);
        }
        let names = attachments.iter().map(|a| a.name.clone()).collect();
        chat.emit_when(ChatBody::User { text, attachments: names }, prompt_gate)?;
        let id = match chat.register(Pending::Prompt) {
            Ok(id) => id,
            Err(message) => {
                chat.emit(ChatBody::Error { message: message.clone() });
                return Err(message);
            }
        };
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": { "sessionId": session_id, "prompt": blocks },
        });
        if let Err(message) = chat.send(&request) {
            // Whoever takes the pending prompt out reports its failure.
            if lock(&chat.pending).remove(&id).is_some() {
                chat.emit(ChatBody::Error { message: message.clone() });
            }
            return Err(message);
        }
        Ok(())
    }

    /// Stops the running turn. Without one there is nothing to stop: no
    /// `session/cancel` is sent (an adapter may carry it over to the next
    /// prompt, or fail writing to an agent that exited) - but permission
    /// requests asked outside a turn are still cancelled.
    pub(crate) fn cancel(&self, chat_id: &str) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        let running = matches!(*lock(&chat.status), ChatStatus::Busy | ChatStatus::Waiting);
        let sent = if running { chat.notify("session/cancel", json!({ "sessionId": chat.session_id()? })) } else { Ok(()) };
        // ACP: every permission request still open when a turn is cancelled
        // is answered as cancelled.
        chat.cancel_permissions();
        sent
    }

    pub(crate) fn permission(&self, chat_id: &str, request_id: &Value, option_id: Option<&str>) -> Result<(), String> {
        self.get(chat_id)?.resolve_permission(request_id, option_id)
    }

    /// Waits for the agent's answer, so it runs on the blocking pool. Agents
    /// only send `current_mode_update` for switches of their own, so once
    /// one is accepted it is logged as one: every view (the window, the
    /// phones, a later replay) then shows the same mode.
    pub(crate) async fn set_mode(&self, chat_id: &str, mode_id: String) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        crate::blocking(move || {
            let session_id = chat.session_id()?.to_string();
            chat.request("session/set_mode", json!({ "sessionId": session_id, "modeId": mode_id }), MODE_TIMEOUT)?;
            chat.emit(ChatBody::Update { update: json!({ "sessionUpdate": "current_mode_update", "currentModeId": mode_id }) });
            Ok(())
        })
        .await
    }

    /// Waits for the agent's answer, so it runs on the blocking pool.
    pub(crate) async fn set_model(&self, chat_id: &str, model_id: String) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        crate::blocking(move || chat.set_model(&model_id)).await
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

/// Whether the agent can start without downloading its adapter: it has its
/// own binary, or the managed install is in place.
#[tauri::command]
pub fn chat_adapter_ready(app: AppHandle, agent: String) -> bool {
    crate::acp_adapters::package(&agent).is_none() || crate::acp_adapters::installed_entry(&app, &agent).is_some()
}

/// Starts the agent's ACP server in `cwd` with its pipes open.
fn spawn_agent(app: &AppHandle, agent: &str, cwd: &str, profile: Option<&str>) -> Result<(Child, String), String> {
    let (program, args) = launch_command(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    // A Flowcode-managed install runs straight under node (no npx, no download);
    // until the first one lands, npx fetches the adapter as before.
    let installed = crate::acp_adapters::installed_entry(app, agent);
    crate::acp_adapters::refresh_in_background(app, agent);
    let line = match &installed {
        Some(entry) => format!("node {}", entry.display()),
        None => std::iter::once(program).chain(args.iter().copied()).collect::<Vec<_>>().join(" "),
    };
    #[cfg(target_os = "windows")]
    let mut cmd = match &installed {
        Some(entry) => {
            let mut cmd = Command::new("node");
            cmd.arg(entry);
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd
        }
        // Through cmd on Windows so npm's `.cmd` shims resolve.
        None => {
            let mut cmd = Command::new("cmd");
            cmd.arg("/C").arg(program).args(args);
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd
        }
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        use std::os::unix::process::CommandExt;
        let mut cmd = match &installed {
            Some(entry) => {
                let mut cmd = Command::new("node");
                cmd.arg(entry);
                cmd
            }
            None => {
                let mut cmd = Command::new(program);
                cmd.args(args);
                cmd
            }
        };
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

/// Whether a non-`strict` resume whose `session/load` failed with `error`
/// goes on with a new session. Not when the agent wants a sign-in: a new
/// session would fail the same way, and the view must offer the login.
fn falls_back(strict: bool, error: &str) -> bool {
    !strict && !error.starts_with("auth_required")
}

/// Attempts (after the first) a strict `session/load` makes while another process still holds the session.
const LOAD_RETRIES: u32 = 6;
const LOAD_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Whether a `session/load` error says another client still has the session open (codex-acp's `thread_active_writer`).
fn session_in_use(error: &str) -> bool {
    let error = error.to_lowercase();
    error.contains("active writer") || error.contains("in use by another")
}

fn new_session(chat: &Chat, cwd: &str) -> Result<(Value, String, bool), String> {
    let result = chat.request("session/new", json!({ "cwd": cwd, "mcpServers": [] }), SETUP_TIMEOUT)?;
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session/new returned no sessionId".to_string())?
        .to_string();
    Ok((result, session_id, false))
}

/// `initialize`, then `session/load` or `session/new`; `strict` refuses a
/// fresh session when the resume can't load. Otherwise a load that fails
/// (the session is gone, the agent can't read it...) falls back to a new
/// session (`loaded` false, its new id) rather than failing the chat; the
/// history the failed load had already replayed is dropped with it.
fn handshake(chat: &Chat, cwd: &str, resume: Option<String>, strict: bool) -> Result<(Value, String, bool), String> {
    let init = chat.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false, "_meta": { "subagent-transcript": true } },
            "clientInfo": { "name": "flowcode", "version": env!("CARGO_PKG_VERSION") },
        }),
        SETUP_TIMEOUT,
    )?;
    let images = init.pointer("/agentCapabilities/promptCapabilities/image").and_then(Value::as_bool).unwrap_or(false);
    chat.prompt_images.store(images, Ordering::Release);
    let can_load = init.pointer("/agentCapabilities/loadSession").and_then(Value::as_bool).unwrap_or(false);
    if strict && !can_load && resume.as_deref().is_some_and(|id| !id.is_empty()) {
        return Err("resume_unsupported: the agent can't resume a session".into());
    }
    match resume.filter(|id| can_load && !id.is_empty()) {
        Some(session_id) => {
            let mut loaded = Err(String::new());
            // A terminal that just handed its session over may still be letting go of it
            // (Codex: "already has an active writer"): a strict resume tries again briefly.
            for attempt in 0..=if strict { LOAD_RETRIES } else { 0 } {
                if attempt > 0 {
                    std::thread::sleep(LOAD_RETRY_DELAY);
                }
                loaded = chat.request(
                    "session/load",
                    json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": [] }),
                    SETUP_TIMEOUT,
                );
                if !loaded.as_ref().err().is_some_and(|e| session_in_use(e)) || chat.exited.load(Ordering::Acquire) {
                    break;
                }
            }
            match loaded {
                Ok(result) => Ok((result, session_id, true)),
                // An agent that died explains itself better than a
                // `session/new` it can no longer answer.
                Err(e) if !falls_back(strict, &e) || chat.exited.load(Ordering::Acquire) => Err(e),
                Err(e) => {
                    eprintln!("chat: could not load session {session_id}, starting a new one: {e}");
                    chat.forget_session(&session_id);
                    let fresh = new_session(chat, cwd)?;
                    chat.unforget_session(&fresh.1);
                    Ok(fresh)
                }
            }
        }
        None => new_session(chat, cwd),
    }
}

fn start_blocking(
    app: AppHandle,
    owner: String,
    agent: String,
    cwd: String,
    profile: Option<String>,
    resume: Option<String>,
    strict: bool,
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
    let (replies, queued) = mpsc::sync_channel(REPLY_QUEUE);
    let chat = Arc::new(Chat {
        id: chat_id.clone(),
        app,
        owner,
        agent: agent.clone(),
        cwd: cwd.clone(),
        profile,
        child: Mutex::new(child),
        writer: Mutex::new(stdin),
        replies,
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        permissions: Mutex::new(HashMap::new()),
        log: Mutex::new(Log::new(MAX_LOG_EVENTS, MAX_LOG_BYTES)),
        feed: broadcast::channel(FEED_CAPACITY).0,
        status: Mutex::new(ChatStatus::Starting),
        stderr: Mutex::new(Vec::new()),
        stderr_done: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        session_id: OnceLock::new(),
        modes: OnceLock::new(),
        models: Mutex::new(None),
        stale_session: Mutex::new(None),
        prompt_images: AtomicBool::new(false),
    });
    {
        let chat = Arc::clone(&chat);
        std::thread::spawn(move || read_stdout(chat, stdout));
    }
    {
        let chat = Arc::downgrade(&chat);
        std::thread::spawn(move || read_stderr(chat, stderr));
    }
    {
        let chat = Arc::downgrade(&chat);
        std::thread::spawn(move || write_replies(chat, queued));
    }
    match handshake(&chat, &cwd, resume, strict) {
        Ok((result, session_id, loaded)) => {
            let _ = chat.session_id.set(session_id.clone());
            if let Some(modes) = result.get("modes") {
                let _ = chat.modes.set(modes.clone());
            }
            let models = normalize_models(&result);
            *lock(&chat.models) = models.clone();
            chat.started();
            let started = ChatStarted {
                chat_id,
                session_id,
                agent,
                modes: result.get("modes").cloned(),
                models: models.as_ref().map(ChatModels::to_json),
                config_options: result.get("configOptions").cloned(),
                loaded,
            };
            Ok((chat, started))
        }
        Err(e) => {
            chat.kill();
            Err(if e.starts_with("auth_required") || e.starts_with("resume_unsupported") { e } else { format!("`{line}`: {e}") })
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
    strict_resume: Option<bool>,
) -> Result<ChatStarted, String> {
    let owner = window.label().to_string();
    let (chat, started) = {
        let (app, owner) = (app.clone(), owner.clone());
        crate::blocking(move || start_blocking(app, owner, agent, cwd, profile, resume_session_id, strict_resume.unwrap_or(false)))
            .await?
    };
    // The window may have closed while the agent was starting, and its
    // `kill_owned_by` (run by `on_window_event` on `Destroyed`) then had
    // nothing to kill. Tauri takes a destroyed window out of its map *before*
    // running the `Destroyed` handlers, so inserting first and looking the
    // window up after can't miss both ways: either the insert came first and
    // `kill_owned_by` takes the chat, or it came after that handler ran - and
    // so after the window left the map - and the lookup finds no window.
    let chat_id = started.chat_id.clone();
    lock(&state.sessions).insert(chat_id.clone(), ChatSession { chat });
    if app.get_webview_window(&owner).is_none() {
        // `None` if `kill_owned_by` got it first; either way it dies.
        let orphan = lock(&state.sessions).remove(&chat_id);
        state.changed();
        if let Some(orphan) = orphan {
            std::thread::spawn(move || drop(orphan));
        }
        return Err("window_closed".into());
    }
    state.changed();
    Ok(started)
}

/// The commands that write to the agent run on the blocking pool: a write to
/// an agent that stopped reading its stdin blocks until it reads again.
#[tauri::command]
pub async fn chat_prompt(app: AppHandle, chat_id: String, text: String, attachments: Option<Vec<Attachment>>) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().prompt(&chat_id, text, attachments.unwrap_or_default())).await
}

#[tauri::command]
pub async fn chat_cancel(app: AppHandle, chat_id: String) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().cancel(&chat_id)).await
}

#[tauri::command]
pub async fn chat_permission(
    app: AppHandle,
    chat_id: String,
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    crate::blocking(move || app.state::<ChatState>().permission(&chat_id, &request_id, option_id.as_deref())).await
}

#[tauri::command]
pub async fn chat_set_mode(state: State<'_, ChatState>, chat_id: String, mode_id: String) -> Result<(), String> {
    state.set_mode(&chat_id, mode_id).await
}

#[tauri::command]
pub async fn chat_set_model(state: State<'_, ChatState>, chat_id: String, model_id: String) -> Result<(), String> {
    state.set_model(&chat_id, model_id).await
}

/// Resolves only once the agent is dead: the terminal handoff awaits it
/// before running `claude --resume` on the same session, which must not find
/// the chat's agent still holding it.
#[tauri::command]
pub async fn chat_close(app: AppHandle, chat_id: String) -> Result<(), String> {
    let state = app.state::<ChatState>();
    let session = lock(&state.sessions).remove(&chat_id);
    state.changed();
    // Dropping the session kills the agent - `taskkill` / `kill` and the
    // wait for the exit included: not on an async worker.
    crate::blocking(move || {
        drop(session);
        Ok(())
    })
    .await
}

/// Async: a whole log is cloned (and then serialized), not for the main thread.
#[tauri::command(async)]
pub fn chat_events(state: State<'_, ChatState>, chat_id: String, after_seq: u64) -> Result<Vec<ChatEvent>, String> {
    let chat = state.get(&chat_id)?;
    let events = lock(&chat.log).after(after_seq);
    Ok(events)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_lines_are_cut_and_the_rest_skipped() {
        let input = format!("short\n{}\nnext\ntail", "x".repeat(50));
        // A tiny BufReader capacity: the long line spans many `fill_buf`s.
        let mut reader = BufReader::with_capacity(4, input.as_bytes());
        let mut buf = Vec::new();
        assert_eq!(read_line_capped(&mut reader, &mut buf, 10).unwrap(), Some(true));
        assert_eq!(buf, b"short\n");
        assert_eq!(read_line_capped(&mut reader, &mut buf, 10).unwrap(), Some(false));
        assert_eq!(buf.len(), 10, "only the cap is kept");
        assert_eq!(read_line_capped(&mut reader, &mut buf, 10).unwrap(), Some(true));
        assert_eq!(buf, b"next\n", "the long line's rest was skipped");
        assert_eq!(read_line_capped(&mut reader, &mut buf, 10).unwrap(), Some(true));
        assert_eq!(buf, b"tail", "a last line without newline");
        assert_eq!(read_line_capped(&mut reader, &mut buf, 10).unwrap(), None);
        // Exactly at the cap (newline included) is whole.
        let mut reader = BufReader::new(&b"123456789\n"[..]);
        assert_eq!(read_line_capped(&mut reader, &mut buf, 10).unwrap(), Some(true));
    }

    #[test]
    fn a_reaped_child_is_not_killed_again() {
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
            c
        } else {
            let mut c = Command::new("sleep");
            c.arg("30");
            c
        };
        let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        kill_if_running(&mut child);
        let status = child.wait().unwrap();
        assert!(!status.success(), "killed, not finished");
        // Reaped: its pid may belong to anyone now - must be a no-op.
        kill_if_running(&mut child);
        assert!(matches!(child.try_wait(), Ok(Some(_))));
    }

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

    fn chunk(kind: &str, text: &str) -> ChatBody {
        ChatBody::Update { update: json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }) }
    }

    fn chunk_with_id(text: &str, id: &str) -> ChatBody {
        ChatBody::Update {
            update: json!({ "sessionUpdate": "agent_message_chunk", "messageId": id, "content": { "type": "text", "text": text } }),
        }
    }

    /// (seq, text) of each event: a chunk's text or a user message.
    fn summary(events: &[ChatEvent]) -> Vec<(u64, String)> {
        events
            .iter()
            .map(|e| {
                let text = match &e.body {
                    ChatBody::Update { update } => update["content"]["text"].as_str().unwrap_or("").to_string(),
                    ChatBody::User { text, .. } => text.clone(),
                    _ => String::new(),
                };
                (e.seq, text)
            })
            .collect()
    }

    fn big_log() -> Log {
        Log::new(MAX_LOG_EVENTS, MAX_LOG_BYTES)
    }

    #[test]
    fn status_follows_events() {
        use ChatStatus::*;
        let user = ChatBody::User { text: "hi".into(), attachments: Vec::new() };
        let update = ChatBody::Update { update: json!({ "sessionUpdate": "usage_update" }) };
        let permission = ChatBody::Permission { request_id: json!(1), tool_call: json!({}), options: json!([]) };
        let resolved = ChatBody::PermissionResolved { request_id: json!(1), option_id: None };
        let ext = ChatBody::Ext { method: "_x".into(), params: Value::Null };
        let turn_end = ChatBody::TurnEnd { stop_reason: "end_turn".into() };
        let error = ChatBody::Error { message: "boom".into() };
        let exit = ChatBody::Exit { code: Some(0) };

        // Only the user's prompt starts a turn.
        assert_eq!(next_status(Idle, &user, false), Busy);
        assert_eq!(next_status(Idle, &user, true), Waiting);
        for body in [&update, &permission, &resolved, &ext] {
            assert_eq!(next_status(Idle, body, false), Idle, "{body:?}");
            assert_eq!(next_status(Idle, body, true), Idle, "{body:?}");
        }
        // In a turn: waiting exactly while a permission is open.
        for before in [Busy, Waiting] {
            for body in [&user, &update, &permission, &resolved] {
                assert_eq!(next_status(before, body, true), Waiting, "{before:?} {body:?}");
                assert_eq!(next_status(before, body, false), Busy, "{before:?} {body:?}");
            }
            assert_eq!(next_status(before, &ext, false), before);
            assert_eq!(next_status(before, &ext, true), before);
        }
        // The turn ends, the agent exits.
        for before in [Idle, Busy, Waiting] {
            assert_eq!(next_status(before, &turn_end, true), Idle);
            assert_eq!(next_status(before, &error, false), Idle);
            assert_eq!(next_status(before, &exit, false), Exited);
        }
        // Nothing moves while starting (a resumed session replays history) but the exit.
        for body in [&user, &update, &permission, &resolved, &ext, &turn_end, &error] {
            assert_eq!(next_status(Starting, body, false), Starting, "{body:?}");
            assert_eq!(next_status(Exited, body, false), Exited, "{body:?}");
        }
        assert_eq!(next_status(Starting, &exit, false), Exited);
        assert_eq!(next_status(Exited, &exit, false), Exited);
    }

    #[test]
    fn only_events_after_the_start_are_live() {
        let update = ChatBody::Update { update: json!({}) };
        let exit = ChatBody::Exit { code: None };
        assert!(!is_live(ChatStatus::Starting, &update));
        assert!(is_live(ChatStatus::Starting, &exit));
        assert!(!is_live(ChatStatus::Exited, &update));
        assert!(!is_live(ChatStatus::Exited, &exit));
        for status in [ChatStatus::Idle, ChatStatus::Busy, ChatStatus::Waiting] {
            assert!(is_live(status, &update));
        }
    }

    #[test]
    fn prompts_go_only_to_an_idle_agent() {
        assert!(prompt_gate(ChatStatus::Idle).is_ok());
        for status in [ChatStatus::Busy, ChatStatus::Waiting, ChatStatus::Starting] {
            assert!(prompt_gate(status).unwrap_err().starts_with("agent_busy"), "{status:?}");
        }
        assert!(prompt_gate(ChatStatus::Exited).unwrap_err().starts_with("agent_exited"));
    }

    #[test]
    fn a_session_held_by_another_client_is_recognized() {
        assert!(session_in_use("thread abc already has an active writer"));
        assert!(session_in_use("This Codex session is in use by another Codex client (the Codex app, the CLI or an IDE extension)."));
        assert!(!session_in_use("Session not found"));
    }

    #[test]
    fn a_failed_load_falls_back_unless_strict_or_signed_out() {
        assert!(falls_back(false, "Session not found"));
        assert!(falls_back(false, "session/load timed out after 180s"));
        assert!(!falls_back(true, "Session not found"));
        assert!(!falls_back(false, "auth_required: Authentication required"));
        assert!(!falls_back(true, "auth_required: Authentication required"));
    }

    #[test]
    fn updates_of_a_forgotten_session_are_stale() {
        let params = json!({ "sessionId": "old", "update": {} });
        assert!(is_stale_update(&params, Some("old")));
        assert!(!is_stale_update(&params, Some("new")));
        assert!(!is_stale_update(&params, None));
        assert!(!is_stale_update(&json!({ "update": {} }), Some("old")));
    }

    #[test]
    fn recognizes_text_chunks() {
        let thought = json!({
            "sessionUpdate": "agent_thought_chunk", "messageId": "m", "content": { "type": "text", "text": "hm" }
        });
        let (kind, id, text) = text_chunk(&thought).unwrap();
        assert_eq!((kind, id, text), ("agent_thought_chunk", Some(&json!("m")), "hm"));
        let no_id =
            json!({ "sessionUpdate": "agent_message_chunk", "messageId": null, "content": { "type": "text", "text": "a" } });
        assert_eq!(text_chunk(&no_id).unwrap().1, None);
        let user = json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "a" } });
        assert!(text_chunk(&user).is_none());
        let image = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image", "data": "" } });
        assert!(text_chunk(&image).is_none());
        assert!(text_chunk(&json!({ "sessionUpdate": "tool_call" })).is_none());
    }

    #[test]
    fn the_log_merges_a_streamed_message_but_the_feed_gets_every_chunk() {
        let mut log = big_log();
        let user = log.push(ChatBody::User { text: "q".into(), attachments: Vec::new() }, 1);
        let live: Vec<ChatEvent> = ["Hel", "lo ", "wörld"]
            .iter()
            .enumerate()
            .map(|(i, t)| log.push(chunk("agent_message_chunk", t), 10 + i as u64))
            .collect();
        assert_eq!(user.seq, 1);
        assert_eq!(summary(&live), vec![(2, "Hel".into()), (3, "lo ".into()), (4, "wörld".into())]);
        assert_eq!(log.events.len(), 2);
        let replay = log.after(0);
        assert_eq!(summary(&replay), vec![(1, "q".into()), (4, "Hello wörld".into())]);
        // The merged entry carries its last chunk's time.
        assert_eq!(replay[1].at, 12);
    }

    #[test]
    fn subagent_chunks_do_not_merge_with_other_streams() {
        let mut log = big_log();
        let sub = |text: &str, parent: &str| ChatBody::Update {
            update: json!({
                "sessionUpdate": "agent_message_chunk",
                "_meta": { "claudeCode": { "parentToolUseId": parent } },
                "content": { "type": "text", "text": text }
            }),
        };
        log.push(chunk("agent_message_chunk", "main "), 0); // 1
        log.push(sub("a1 ", "A"), 0); // 2: another stream
        log.push(sub("a2", "A"), 0); // 3: merges into 2
        log.push(sub("b", "B"), 0); // 4: another subagent
        log.push(chunk("agent_message_chunk", "main2"), 0); // 5
        assert_eq!(
            summary(&log.after(0)),
            vec![(1, "main ".into()), (3, "a1 a2".into()), (4, "b".into()), (5, "main2".into())]
        );
    }

    #[test]
    fn a_replay_from_inside_a_merged_run_gets_only_the_rest() {
        let mut log = big_log();
        log.push(ChatBody::User { text: "q".into(), attachments: Vec::new() }, 0);
        for t in ["a", "bé", "c", "d"] {
            log.push(chunk("agent_message_chunk", t), 0); // seqs 2..=5
        }
        // Saw only the user's message: the whole run.
        assert_eq!(summary(&log.after(1)), vec![(5, "abécd".into())]);
        // Saw the first chunk live.
        assert_eq!(summary(&log.after(2)), vec![(5, "bécd".into())]);
        // Saw up to the third.
        assert_eq!(summary(&log.after(4)), vec![(5, "d".into())]);
        // Saw everything.
        assert!(log.after(5).is_empty());
        // The run grows after someone saw all of it: they get just the new text.
        log.push(chunk("agent_message_chunk", "e"), 0);
        assert_eq!(summary(&log.after(5)), vec![(6, "e".into())]);
        // The entry itself is untouched by the slicing.
        assert_eq!(summary(&log.after(0)), vec![(1, "q".into()), (6, "abécde".into())]);
    }

    #[test]
    fn only_chunks_of_the_same_message_merge() {
        let mut log = big_log();
        log.push(chunk("agent_thought_chunk", "think"), 0); // 1
        log.push(chunk("agent_message_chunk", "say"), 0); // 2: another kind
        log.push(chunk("agent_message_chunk", " more"), 0); // 3: merges into 2
        log.push(ChatBody::Update { update: json!({ "sessionUpdate": "tool_call", "toolCallId": "t" }) }, 0); // 4
        log.push(chunk("agent_message_chunk", "after"), 0); // 5: the tool call broke the run
        log.push(chunk_with_id("x", "m1"), 0); // 6: an id the last one lacks
        log.push(chunk_with_id("y", "m1"), 0); // 7: same id, merges
        log.push(chunk_with_id("z", "m2"), 0); // 8: another message
        let image = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image", "data": "" } });
        log.push(ChatBody::Update { update: image }, 0); // 9: not text
        log.push(chunk("agent_message_chunk", "end"), 0); // 10
        assert_eq!(
            summary(&log.after(0)),
            vec![
                (1, "think".into()),
                (3, "say more".into()),
                (4, String::new()),
                (5, "after".into()),
                (7, "xy".into()),
                (8, "z".into()),
                (9, String::new()),
                (10, "end".into()),
            ]
        );
        // From inside the id'd run, and from just before a single entry.
        assert_eq!(
            summary(&log.after(6)),
            vec![(7, "y".into()), (8, "z".into()), (9, String::new()), (10, "end".into())]
        );
        assert_eq!(summary(&log.after(9)), vec![(10, "end".into())]);
    }

    #[test]
    fn the_log_drops_its_oldest_past_the_caps() {
        let mut log = Log::new(3, MAX_LOG_BYTES);
        for n in 1..=5 {
            log.push(ChatBody::User { text: n.to_string(), attachments: Vec::new() }, 0);
        }
        assert_eq!(summary(&log.after(0)), vec![(3, "3".into()), (4, "4".into()), (5, "5".into())]);

        // By bytes: each of these is 64 + 100 bytes, room for two.
        let mut log = Log::new(100, 400);
        for n in 1..=4u8 {
            log.push(ChatBody::User { text: n.to_string().repeat(100), attachments: Vec::new() }, 0);
        }
        assert_eq!(log.after(0).iter().map(|e| e.seq).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(log.bytes, log.events.iter().map(|e| e.size).sum::<usize>());

        // A merged run counts its whole text against the cap.
        let mut log = Log::new(100, 400);
        log.push(ChatBody::User { text: "q".into(), attachments: Vec::new() }, 0);
        for _ in 0..10 {
            log.push(chunk("agent_message_chunk", &"x".repeat(50)), 0);
        }
        assert_eq!(log.events.len(), 1, "the user message goes, the newest entry stays");
        assert_eq!(log.after(0)[0].seq, 11);
        assert_eq!(log.bytes, log.events.iter().map(|e| e.size).sum::<usize>());

        // The newest entry is kept even when alone over the cap.
        let mut log = Log::new(100, 10);
        log.push(ChatBody::User { text: "y".repeat(1000), attachments: Vec::new() }, 0);
        assert_eq!(log.events.len(), 1);
    }

    #[test]
    fn a_reset_log_keeps_counting() {
        let mut log = big_log();
        log.push(chunk("agent_message_chunk", "old history"), 0);
        log.push(ChatBody::User { text: "old".into(), attachments: Vec::new() }, 0);
        log.reset();
        assert!(log.after(0).is_empty());
        assert_eq!(log.bytes, 0);
        let next = log.push(chunk("agent_message_chunk", "new"), 0);
        assert_eq!(next.seq, 3);
        assert_eq!(summary(&log.after(0)), vec![(3, "new".into())]);
    }

    #[test]
    fn json_sizes_are_approximated() {
        assert_eq!(approx_size(&json!("abc")), 5);
        assert_eq!(approx_size(&json!({ "k": "v" })), 2 + 1 + 4 + 3);
        assert_eq!(approx_size(&json!([1, null])), 2 + 8 + 8);
        assert!(body_size(&ChatBody::User { text: "x".repeat(1000), attachments: Vec::new() }) >= 1000);
    }

    #[test]
    fn knows_how_to_launch_each_agent() {
        assert_eq!(launch_command("vibe"), Some(("vibe-acp", &[][..])));
        assert_eq!(launch_command("gemini"), Some(("gemini", &["--experimental-acp"][..])));
        assert_eq!(launch_command("claude").map(|c| c.0), Some("npx"));
        assert_eq!(launch_command("codex").map(|c| c.0), Some("npx"));
        assert!(launch_command("nope").is_none());
    }

    #[test]
    fn normalizes_the_unstable_models_object() {
        let result = json!({ "models": {
            "currentModelId": "sonnet",
            "availableModels": [
                { "modelId": "sonnet", "name": "Sonnet", "description": "Everyday" },
                { "modelId": "opus" },
                { "name": "no id" },
            ],
        } });
        let models = normalize_models(&result).unwrap();
        assert_eq!(models.via, ModelVia::Models);
        assert_eq!(
            models.to_json(),
            json!({ "currentModelId": "sonnet", "availableModels": [
                { "modelId": "sonnet", "name": "Sonnet", "description": "Everyday" },
                { "modelId": "opus", "name": "opus" },
            ] })
        );
    }

    #[test]
    fn prefers_the_model_config_option() {
        let result = json!({
            "models": { "currentModelId": "a", "availableModels": [{ "modelId": "a", "name": "A" }] },
            "configOptions": [
                { "id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "ask",
                  "options": [{ "value": "ask", "name": "Ask" }] },
                { "id": "llm", "name": "Model", "category": "model", "type": "select", "currentValue": "gpt-5",
                  "options": [{ "value": "gpt-5", "name": "GPT-5", "description": "Smart" }, { "value": "gpt-5-mini", "name": "Mini" }] },
            ],
        });
        let models = normalize_models(&result).unwrap();
        assert_eq!(models.via, ModelVia::ConfigOption { config_id: "llm".into() });
        assert_eq!(models.current, "gpt-5");
        assert_eq!(models.available.len(), 2);
        assert_eq!(models.available[0].description.as_deref(), Some("Smart"));

        // No model option among the config options: the `models` object it is.
        let result = json!({
            "models": { "currentModelId": "a", "availableModels": [{ "modelId": "a", "name": "A" }] },
            "configOptions": [{ "id": "mode", "category": "mode", "type": "select", "currentValue": "x", "options": [{ "value": "x", "name": "X" }] }],
        });
        assert_eq!(normalize_models(&result).unwrap().via, ModelVia::Models);
    }

    #[test]
    fn falls_back_to_the_option_called_model_and_flattens_groups() {
        let options = json!([{ "id": "model", "name": "Model", "type": "select", "currentValue": "b", "options": [
            { "group": "fast", "name": "Fast", "options": [{ "value": "a", "name": "A" }] },
            { "group": "smart", "options": [{ "value": "b", "name": "B" }, { "value": "c" }] },
        ] }]);
        let models = models_from_config_options(&options).unwrap();
        assert_eq!(
            models.to_json(),
            json!({ "currentModelId": "b", "availableModels": [
                { "modelId": "a", "name": "A", "group": "Fast" },
                { "modelId": "b", "name": "B", "group": "smart" },
                { "modelId": "c", "name": "c", "group": "smart" },
            ] })
        );
    }

    #[test]
    fn no_or_malformed_models_give_none() {
        assert!(normalize_models(&json!({ "sessionId": "s" })).is_none());
        assert!(normalize_models(&json!({ "models": null })).is_none());
        assert!(normalize_models(&json!({ "models": { "currentModelId": "a", "availableModels": [] } })).is_none());
        assert!(normalize_models(&json!({ "models": { "availableModels": [{ "modelId": "a" }] } })).is_none());
        assert!(normalize_models(&json!({ "models": { "currentModelId": "a", "availableModels": "a" } })).is_none());
        assert!(normalize_models(&json!({ "configOptions": { "id": "model" } })).is_none());
        let not_select = json!([{ "id": "model", "category": "model", "type": "boolean", "currentValue": "a", "options": [{ "value": "a" }] }]);
        assert!(models_from_config_options(&not_select).is_none());
        let no_current = json!([{ "id": "model", "category": "model", "type": "select", "options": [{ "value": "a" }] }]);
        assert!(models_from_config_options(&no_current).is_none());
        let no_options = json!([{ "id": "model", "category": "model", "type": "select", "currentValue": "a", "options": [{ "name": "x" }] }]);
        assert!(models_from_config_options(&no_options).is_none());
    }

    #[test]
    fn a_set_model_answer_updates_the_models() {
        let flat = models_from_models(&json!({ "currentModelId": "a", "availableModels": [{ "modelId": "a" }, { "modelId": "b" }] })).unwrap();
        assert!(flat.offers("b") && !flat.offers("z"));
        let after = models_after_set(&flat, &Value::Null, "b");
        assert_eq!((after.current.as_str(), after.available.len()), ("b", 2));

        let option = |current: &str| json!([{ "id": "model", "category": "model", "type": "select", "currentValue": current,
            "options": [{ "value": "a" }, { "value": "b" }, { "value": "c" }] }]);
        let config = models_from_config_options(&option("a")).unwrap();
        // The answer's options win (here the agent picked "c" for "b")...
        let after = models_after_set(&config, &json!({ "configOptions": option("c") }), "b");
        assert_eq!(after.current, "c");
        // ...and without any, the asked model is the current one.
        assert_eq!(models_after_set(&config, &json!({}), "b").current, "b");
    }

    #[test]
    fn config_option_updates_change_the_models_only_when_they_moved() {
        let option = |current: &str| json!([{ "id": "model", "category": "model", "type": "select", "currentValue": current,
            "options": [{ "value": "a" }, { "value": "b" }] }]);
        let config = models_from_config_options(&option("a")).unwrap();
        assert_eq!(models_after_config_update(Some(&config), &option("a")), None);
        assert_eq!(models_after_config_update(Some(&config), &option("b")).unwrap().unwrap().current, "b");
        assert_eq!(models_after_config_update(None, &option("a")), Some(Some(config.clone())));
        // The model option went away.
        assert_eq!(models_after_config_update(Some(&config), &json!([])), Some(None));
        // Models announced by `models` aren't config options: untouched.
        let flat = models_from_models(&json!({ "currentModelId": "a", "availableModels": [{ "modelId": "a" }] })).unwrap();
        assert_eq!(models_after_config_update(Some(&flat), &json!([])), None);
        assert_eq!(models_after_config_update(None, &json!([])), None);
    }
}
