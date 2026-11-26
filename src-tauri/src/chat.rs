//! Chat mode: an AI coding agent hosted through the Agent Client Protocol
//! (ACP - JSON-RPC 2.0, one JSON message per line over the child's
//! stdin/stdout) instead of a pty. The agent's streamed `session/update`s are
//! turned into numbered `ChatEvent`s, kept in a per-chat log (so a remounted
//! view can replay) and pushed to the window that owns the chat.

use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{broadcast, watch};

use crate::chat_mcp::{Owner, ToolsConfig};
use crate::util::{lock, now_ms};

pub(crate) mod delegate;
pub(crate) mod goal;
mod attachments;
mod cline;
mod commands;
mod errors;
mod launch;
pub(crate) mod log;
mod models;
mod peer;
mod session;
mod state;
use delegate::{Delegations, TaskLink};

pub(crate) use attachments::*;
pub use commands::*;
use errors::*;
pub(crate) use launch::*;
use log::*;
pub(crate) use models::*;
pub(crate) use peer::*;
pub(crate) use session::*;
pub(crate) use state::*;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

/// How long `initialize` / `session/new` / `session/load` may take: `npx` may
/// have to download the adapter the first time it is used.
const SETUP_TIMEOUT: Duration = Duration::from_secs(180);
const MODE_TIMEOUT: Duration = Duration::from_secs(30);
/// The event carrying a chat's goal (`{ goal: Goal | null, actions: string[] }`).
const GOAL_EXT_METHOD: &str = "_flowcode/goal";
/// Flowcode's own: `/clear` replaced the session on the same agent process - the views empty the chat.
pub(super) const CLEARED_EXT_METHOD: &str = "_flowcode/cleared";
/// The agent started a turn by itself (no prompt of ours): the views show it working until its `turnEnd`.
/// Sent by the backend alone, so a view never opens a turn the backend won't close.
pub(super) const AUTONOMOUS_EXT_METHOD: &str = "_flowcode/autonomous";
/// Flowcode's own: the resume message scheduled for the usage limit's reset
/// changed - `state` "armed" (with `at`, `text`), "cancelled" or "sent", and
/// the `limitId` (the views' limit item) it was armed for.
const RESUME_EXT_METHOD: &str = "_flowcode/resume";
/// After the reset time before the resume goes out: the CLI rounds that time
/// to the minute, and the account's usage takes a moment to catch up.
const RESUME_GRACE_MS: u64 = 60_000;
/// How often a scheduled resume checks the clock, and retries while the chat
/// is busy.
const RESUME_TICK: Duration = Duration::from_secs(5);
/// Longest resume message accepted.
pub(crate) const MAX_RESUME_TEXT_BYTES: usize = 4096;
/// A page of a chat's log for a phone (see `Log::tail_page`): `(events,
/// has_more, first_seq)`, `before_seq` None for the newest one.
pub(crate) type LogPage = (Vec<ChatEvent>, bool, u64);

/// The newest page of the log and a receiver of every event after it, taken
/// under the log lock so none is missed or doubled in between.
pub(crate) fn subscribe_tail(state: &ChatState, chat_id: &str) -> Result<(LogPage, broadcast::Receiver<ChatEvent>), String> {
    let chat = state.get(chat_id)?;
    let log = lock(&chat.log);
    let page = log.tail_page(None, FIRST_PAGE_EVENTS, FIRST_PAGE_TURNS);
    Ok((page, chat.feed.subscribe()))
}

/// The page of the log before `before_seq`, at least one turn.
pub(crate) fn older_page(state: &ChatState, chat_id: &str, before_seq: u64) -> Result<LogPage, String> {
    let chat = state.get(chat_id)?;
    let page = lock(&chat.log).tail_page(Some(before_seq), FIRST_PAGE_EVENTS, 1);
    Ok(page)
}
/// How often the goal is looked at while it may change.
const GOAL_POLL: Duration = Duration::from_secs(4);
/// Time the agent gets to write its goal down after a turn or a control.
const GOAL_SETTLE: Duration = Duration::from_millis(700);

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

/// Messages that may wait for the chat's writer thread (see `Chat::replies`)
/// before further replies are dropped and `send` refuses.
const REPLY_QUEUE: usize = 256;

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
        /// The pictures among them, stored (`chat_images`) so the UI can show
        /// them; absent for events logged without any.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<UserImage>,
        /// Set when the prompt is another agent's message (`agent_messages`): who sent it. `text` is then the
        /// message as sent, not the framed prompt the agent got.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        peer: Option<Value>,
    },
    /// The agent asks for permission; answered with `chat_permission`.
    Permission { request_id: Value, tool_call: Value, options: Value },
    PermissionResolved { request_id: Value, option_id: Option<String> },
    /// The agent asks the user a question (ACP `elicitation/create`, form
    /// mode); answered with `chat_ask`.
    Ask { request_id: Value, message: String, schema: Value, tool_call_id: Option<String> },
    /// `action` is "accept", "decline" or "cancel".
    AskResolved { request_id: Value, action: String, content: Option<Value> },
    TurnEnd { stop_reason: String },
    /// `limit`: the turn failed on the plan's usage limit / quota / credits
    /// (see `is_limit_error`), so the views show the pond's limit card.
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        limit: bool,
    },
    Exit { code: Option<i32> },
    /// An extension notification (its method starts with `_`), verbatim - or
    /// Flowcode's own `_flowcode/model` (the model changed). It doesn't
    /// change the chat's status.
    Ext { method: String, params: Value },
}

/// A picture the user sent with a prompt, as the UI fetches it (`chat_image`).
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UserImage {
    pub name: String,
    pub mime_type: String,
    /// Its id in the image store.
    pub id: String,
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
/// Only the user's prompt - or the agent's own main-conversation output
/// (`starts_autonomous_turn`) - starts a turn: agents keep sending updates between
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
        // The agent started a turn by itself (a cross-session message, a finished background task).
        (Idle, ChatBody::Update { update }) if starts_autonomous_turn(update) => in_turn,
        (Idle, _) => Idle,
        (Busy | Waiting, _) => in_turn,
    }
}

/// Whether an update seen while idle is the agent's own output starting a turn with no prompt pending: the
/// main conversation's message, thought or tool call - not housekeeping (usage, commands, session info) nor a
/// native subagent's work (`parentToolUseId`), which can trail the turn that ended.
fn starts_autonomous_turn(update: &Value) -> bool {
    matches!(update.get("sessionUpdate").and_then(Value::as_str), Some("agent_message_chunk" | "agent_thought_chunk" | "tool_call"))
        && update.pointer("/_meta/claudeCode/parentToolUseId").is_none_or(Value::is_null)
}

/// Whether an update is the Claude adapter's end-of-result marker of an autonomous cycle: a `usage_update`
/// carrying `_meta["_claude/origin"]` (only results with an origin have it).
fn is_autonomous_end_marker(body: &ChatBody) -> bool {
    matches!(body, ChatBody::Update { update }
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("usage_update")
            && update.pointer("/_meta").and_then(|m| m.get("_claude/origin")).is_some())
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
/// message and sends it when the turn ends). The exception: a turn the agent
/// started by itself (`autonomous`) takes a prompt while it runs - the adapter
/// merges it in and its response ends the turn - but not while a permission is
/// open (`Waiting`).
fn prompt_gate(status: ChatStatus, autonomous: bool) -> Result<(), String> {
    match status {
        ChatStatus::Idle => Ok(()),
        ChatStatus::Busy if autonomous => Ok(()),
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
    /// The normalized thinking levels (`ThoughtLevels::to_json`), when the agent offers any.
    pub thought: Option<Value>,
    /// The WSL distro the agent runs in; `None` on Windows.
    pub wsl_distro: Option<String>,
    pub status: ChatStatus,
    /// When `status` last changed (ms since the epoch).
    pub status_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStarted {
    pub chat_id: String,
    pub session_id: String,
    pub modes: Option<Value>,
    /// The normalized models (`ChatModels::to_json`), when the agent offers any.
    pub models: Option<Value>,
    /// The normalized thinking levels (`ThoughtLevels::to_json`), when the agent offers any.
    pub thought: Option<Value>,
    /// The agent replayed a previous session (`session/load`) rather than
    /// starting a fresh one.
    pub loaded: bool,
    /// The WSL distro the agent runs in; `None` for a chat running on Windows.
    pub wsl_distro: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_events_list_their_images_only_when_there_are_some() {
        let image = UserImage { name: "a.png".into(), mime_type: "image/png".into(), id: "ab".into() };
        let with = ChatEvent { seq: 1, at: 2, body: ChatBody::User { text: "hi".into(), attachments: vec!["a.png".into()], images: vec![image], peer: None } };
        assert_eq!(
            serde_json::to_value(&with).unwrap(),
            json!({ "seq": 1, "at": 2, "kind": "user", "text": "hi", "attachments": ["a.png"], "images": [{ "name": "a.png", "mimeType": "image/png", "id": "ab" }] })
        );
        let without = ChatEvent { seq: 1, at: 2, body: ChatBody::User { text: "hi".into(), attachments: Vec::new(), images: Vec::new(), peer: None } };
        assert_eq!(serde_json::to_value(&without).unwrap(), json!({ "seq": 1, "at": 2, "kind": "user", "text": "hi" }));
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
    fn ask_events_serialize_and_wait() {
        use ChatStatus::*;
        let ask = ChatBody::Ask {
            request_id: json!(3),
            message: "Pick".into(),
            schema: json!({ "type": "object", "properties": {} }),
            tool_call_id: Some("t1".into()),
        };
        assert_eq!(
            serde_json::to_value(&ask).unwrap(),
            json!({ "kind": "ask", "requestId": 3, "message": "Pick", "schema": { "type": "object", "properties": {} }, "toolCallId": "t1" })
        );
        let resolved = ChatBody::AskResolved { request_id: json!(3), action: "accept".into(), content: Some(json!({ "a": "b" })) };
        assert_eq!(
            serde_json::to_value(&resolved).unwrap(),
            json!({ "kind": "askResolved", "requestId": 3, "action": "accept", "content": { "a": "b" } })
        );
        // An open ask makes a turn wait, like an open permission.
        assert_eq!(next_status(Busy, &ask, true), Waiting);
        assert_eq!(next_status(Waiting, &resolved, false), Busy);
        assert_eq!(next_status(Idle, &ask, true), Idle);
    }

    #[test]
    fn status_follows_events() {
        use ChatStatus::*;
        let user = ChatBody::User { text: "hi".into(), attachments: Vec::new(), images: Vec::new(), peer: None };
        let update = ChatBody::Update { update: json!({ "sessionUpdate": "usage_update" }) };
        let permission = ChatBody::Permission { request_id: json!(1), tool_call: json!({}), options: json!([]) };
        let resolved = ChatBody::PermissionResolved { request_id: json!(1), option_id: None };
        let ext = ChatBody::Ext { method: "_x".into(), params: Value::Null };
        let turn_end = ChatBody::TurnEnd { stop_reason: "end_turn".into() };
        let error = ChatBody::Error { message: "boom".into(), limit: false };
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
        assert!(prompt_gate(ChatStatus::Idle, false).is_ok());
        for status in [ChatStatus::Busy, ChatStatus::Waiting, ChatStatus::Starting] {
            assert!(prompt_gate(status, false).unwrap_err().starts_with("agent_busy"), "{status:?}");
        }
        assert!(prompt_gate(ChatStatus::Exited, false).unwrap_err().starts_with("agent_exited"));
    }

    #[test]
    fn an_autonomous_turn_takes_a_prompt_unless_waiting() {
        assert!(prompt_gate(ChatStatus::Busy, true).is_ok());
        assert!(prompt_gate(ChatStatus::Waiting, true).unwrap_err().starts_with("agent_busy"));
        assert!(prompt_gate(ChatStatus::Starting, true).unwrap_err().starts_with("agent_busy"));
        assert!(prompt_gate(ChatStatus::Exited, true).unwrap_err().starts_with("agent_exited"));
    }

    #[test]
    fn the_agent_output_alone_starts_a_turn() {
        use ChatStatus::*;
        let upd = |v: Value| ChatBody::Update { update: v };
        for kind in ["agent_message_chunk", "agent_thought_chunk", "tool_call"] {
            let body = upd(json!({ "sessionUpdate": kind }));
            assert_eq!(next_status(Idle, &body, false), Busy, "{kind}");
            assert_eq!(next_status(Idle, &body, true), Waiting, "{kind}");
            // A null parent is still the main conversation.
            let main = upd(json!({ "sessionUpdate": kind, "_meta": { "claudeCode": { "parentToolUseId": null } } }));
            assert_eq!(next_status(Idle, &main, false), Busy, "{kind}");
            // A native subagent's output doesn't.
            let sub = upd(json!({ "sessionUpdate": kind, "_meta": { "claudeCode": { "parentToolUseId": "toolu_1" } } }));
            assert_eq!(next_status(Idle, &sub, false), Idle, "{kind}");
            // Nor while starting (history replay).
            assert_eq!(next_status(Starting, &body, false), Starting, "{kind}");
        }
        for kind in ["usage_update", "available_commands_update", "session_info_update", "tool_call_update", "current_mode_update"] {
            assert_eq!(next_status(Idle, &upd(json!({ "sessionUpdate": kind })), false), Idle, "{kind}");
        }
    }

    #[test]
    fn only_a_usage_update_with_an_origin_ends_an_autonomous_turn() {
        let usage = |meta: Value| ChatBody::Update { update: json!({ "sessionUpdate": "usage_update", "_meta": meta }) };
        assert!(is_autonomous_end_marker(&usage(json!({ "_claude/origin": { "kind": "task" } }))));
        assert!(!is_autonomous_end_marker(&usage(json!({}))));
        assert!(!is_autonomous_end_marker(&ChatBody::Update { update: json!({ "sessionUpdate": "usage_update" }) }));
        assert!(!is_autonomous_end_marker(&ChatBody::Update { update: json!({ "sessionUpdate": "agent_message_chunk", "_meta": { "_claude/origin": {} } }) }));
    }
}
