//! The ACP v2 codec (experimental, opt-in; see `docs/design/acp-v2-plan.md`).
//!
//! v2 is a separate wire protocol, not "v1 + `state_update`". This module is
//! the only place that knows its shapes: it builds the v2 requests, reads the
//! v2 answers, and turns every v2 `session/update` into the v1-shaped events
//! Flowcode logs and every view renders today (plus the turn-state signals the
//! v2 `state_update` carries). It is pure: no I/O, no `Chat`, no wiring.
//!
//! Terminal folding does no timing: `translate` accumulates a terminal's
//! output and returns one `tool_call_update` for every terminal update, chunk
//! and exit. Coalescing them (the plan says at most one a second, and on exit)
//! is the caller's job; each update carries the whole output so far, so
//! dropping all but the last one of a burst loses nothing.
#![allow(dead_code)] // wired in phase 2

use std::collections::{HashMap, HashSet};

use base64::Engine as _;

use super::*;

/// Which ACP version a chat's agent speaks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum AcpProtocol {
    #[default]
    V1,
    V2,
}

impl AcpProtocol {
    /// The protocol version number, as `ChatStarted.acpVersion` tells it.
    pub(crate) fn version(self) -> u8 {
        match self {
            AcpProtocol::V1 => 1,
            AcpProtocol::V2 => 2,
        }
    }
}

pub(super) const V2_PROTOCOL_VERSION: u64 = 2;
/// The most terminal output kept per terminal; older bytes are dropped.
pub(super) const MAX_TERMINAL_BYTES: usize = 64 * 1024;
const TRUNCATED_NOTE: &str = "[earlier output truncated]\n";

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// `initialize`: no fs/terminal capabilities (v2 has no client fs or
/// terminals); the adapters turn on subagents, notices, compaction and plans
/// for every v2 client on their own.
pub(super) fn initialize_params(name: &str, version: &str) -> Value {
    json!({
        "protocolVersion": V2_PROTOCOL_VERSION,
        "info": { "name": name, "version": version },
        "capabilities": { "elicitation": { "form": {} }, "_meta": { "subagent-transcript": true } },
    })
}

/// v2 requires a `type` on every MCP server. Flowcode's v1 entries name none
/// (a v1 stdio server is recognised by its missing `type`): `command` means
/// stdio, `url` http. Anything else (v1 `sse`, which v2 has no transport for)
/// is dropped.
pub(super) fn tag_mcp_servers(servers: &Value) -> Value {
    let tagged = servers.as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(|server| {
        let mut entry = server.as_object()?.clone();
        let kind = match entry.get("type").and_then(Value::as_str) {
            Some(kind @ ("stdio" | "http")) => kind,
            Some(_) => return None,
            None if entry.contains_key("command") => "stdio",
            None if entry.contains_key("url") => "http",
            None => return None,
        };
        entry.insert("type".into(), json!(kind));
        Some(Value::Object(entry))
    });
    Value::Array(tagged.collect())
}

/// `session/new`.
pub(super) fn new_session_params(cwd: &str, mcp_servers: &Value) -> Value {
    json!({ "cwd": cwd, "mcpServers": tag_mcp_servers(mcp_servers) })
}

/// `session/resume` that replays the whole history (v1's `session/load`).
/// Without `replayFrom` the agent resumes silently.
pub(super) fn resume_params(session_id: &str, cwd: &str, mcp_servers: &Value) -> Value {
    json!({
        "sessionId": session_id,
        "cwd": cwd,
        "mcpServers": tag_mcp_servers(mcp_servers),
        "replayFrom": { "type": "start" },
    })
}

/// `session/set_config_option`: the value is tagged, `id` for a select (the
/// option's value id) and `boolean` for a switch.
pub(super) fn set_config_option_params(session_id: &str, config_id: &str, value: &Value) -> Value {
    let kind = if value.is_boolean() { "boolean" } else { "id" };
    json!({ "sessionId": session_id, "configId": config_id, "type": kind, "value": value })
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/// What the `initialize` answer says the agent can do, in the terms the chat
/// keeps (`prompt_images`, `can_close`, `can_load`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Caps {
    pub(super) prompt_images: bool,
    pub(super) can_close: bool,
    pub(super) can_load: bool,
}

/// Reads the `initialize` result. An agent that answers another version than
/// 2 is not served on v2: the error starts with `acp_v2_fallback` so the
/// caller restarts it on v1. `close`, `resume`, `list` and `cancel` are
/// baseline in v2 (no capability flag), capabilities are presence objects.
pub(super) fn caps_from_initialize(result: &Value) -> Result<Caps, String> {
    let version = result.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(V2_PROTOCOL_VERSION) {
        let got = version.map_or_else(|| "none".to_string(), |v| v.to_string());
        return Err(format!("acp_v2_fallback: the agent answered protocol version {got}, not {V2_PROTOCOL_VERSION}"));
    }
    let image = result.pointer("/capabilities/session/prompt/image");
    Ok(Caps { prompt_images: image.is_some_and(|v| !v.is_null()), can_close: true, can_load: true })
}

fn is_select_group(option: &Value) -> bool {
    option.get("groupId").is_some() || option.get("group").is_some()
}

/// A config option list in the v1 shape every reader of it (`models.rs`)
/// knows: `configId` is `id`, a select group's `groupId` is `group`.
pub(super) fn config_options_to_v1(options: &Value) -> Value {
    let Some(list) = options.as_array() else { return json!([]) };
    Value::Array(list.iter().map(option_to_v1).collect())
}

fn option_to_v1(option: &Value) -> Value {
    let Some(obj) = option.as_object() else { return option.clone() };
    let mut out = obj.clone();
    if let Some(id) = out.remove("configId") {
        out.insert("id".into(), id);
    }
    if let Some(choices) = out.get_mut("options").and_then(Value::as_array_mut) {
        for choice in choices.iter_mut().filter(|c| is_select_group(c)) {
            if let Some(group) = choice.as_object_mut() {
                if let Some(id) = group.remove("groupId") {
                    group.insert("group".into(), id);
                }
            }
        }
    }
    Value::Object(out)
}

/// A `session/set_config_option` answer in the v1 shape (`configOptions` renamed), which the
/// readers of it (`models_after_set`, `thought_after_set`) know.
pub(super) fn config_result_to_v1(result: &Value) -> Value {
    let mut out = result.clone();
    if let Some(options) = result.get("configOptions").filter(|o| o.is_array()) {
        out["configOptions"] = config_options_to_v1(options);
    }
    out
}

/// The select option of category `mode`, in v2 or v1 naming.
fn mode_option(options: &Value) -> Option<&Value> {
    options.as_array()?.iter().find(|o| o.get("category").and_then(Value::as_str) == Some("mode"))
}

/// The id to pass to `session/set_config_option` to change the mode.
pub(super) fn mode_config_id(options: &Value) -> Option<String> {
    let option = mode_option(options)?;
    option.get("configId").or_else(|| option.get("id")).and_then(Value::as_str).map(str::to_string)
}

/// v2 drops `modes`: the modes of a v1 session are synthesized from the select
/// option of category `mode`.
fn modes_from_options(options: &Value) -> Option<Value> {
    let option = mode_option(options)?;
    let current = option.get("currentValue").and_then(Value::as_str)?;
    let mut modes = Vec::new();
    for choice in option.get("options")?.as_array()? {
        // A grouped select lists its choices inside the groups.
        let inner = if is_select_group(choice) { choice.get("options").and_then(Value::as_array).cloned().unwrap_or_default() } else { vec![choice.clone()] };
        for mode in inner {
            let Some(id) = mode.get("value").and_then(Value::as_str) else { continue };
            let name = mode.get("name").and_then(Value::as_str).unwrap_or(id);
            let mut entry = json!({ "id": id, "name": name });
            if let Some(description) = mode.get("description").filter(|d| !d.is_null()) {
                entry["description"] = description.clone();
            }
            modes.push(entry);
        }
    }
    Some(json!({ "currentModeId": current, "availableModes": modes }))
}

/// A v2 command in the v1 shape (`type` tags dropped); `None` for a command
/// type that is not a plain one.
fn command_to_v1(command: &Value) -> Option<Value> {
    let mut out = command.as_object()?.clone();
    if out.remove("type").is_some_and(|t| t.as_str() != Some("command")) {
        return None;
    }
    if let Some(input) = out.get_mut("input").and_then(Value::as_object_mut) {
        input.remove("type");
    }
    Some(Value::Object(out))
}

fn commands_to_v1(commands: &Value) -> Value {
    Value::Array(commands.as_array().map(Vec::as_slice).unwrap_or_default().iter().filter_map(command_to_v1).collect())
}

/// What a `session/new` / `session/resume` result tells, as v1's would:
/// `{modes, configOptions, availableCommands}`. `modes` and `configOptions`
/// are left out when the agent offers none; `availableCommands` (v1 sent it as
/// an update after the setup) is always there.
pub(super) fn setup_from_response(result: &Value) -> Value {
    let mut setup = serde_json::Map::new();
    if let Some(options) = result.get("configOptions").filter(|o| o.is_array()) {
        if let Some(modes) = modes_from_options(options) {
            setup.insert("modes".into(), modes);
        }
        setup.insert("configOptions".into(), config_options_to_v1(options));
    }
    setup.insert("availableCommands".into(), result.get("availableCommands").map_or_else(|| json!([]), commands_to_v1));
    Value::Object(setup)
}

/// `session/request_permission` params as v1 sends them, so the code that reads
/// `params.toolCall` and `options` keeps working. The tool call is
/// `subject.toolCall` with the request's `title` when the patch names none
/// (Codex moves the title up; Claude keeps both). A `command` subject (v2's
/// other kind, no adapter sends it yet) becomes an `execute` tool call. The
/// request's `description` has no v1 home and is dropped.
pub(super) fn permission_params(params: &Value) -> Value {
    let subject = params.get("subject");
    let mut tool_call = match subject.and_then(|s| s.get("type")).and_then(Value::as_str) {
        Some("command") => {
            let s = subject.unwrap();
            let id = s.get("toolCallId").and_then(Value::as_str).unwrap_or("permission");
            json!({ "toolCallId": id, "kind": "execute", "rawInput": { "command": s.get("command"), "cwd": s.get("cwd") } })
        }
        _ => subject.and_then(|s| s.get("toolCall")).cloned().unwrap_or_else(|| json!({})),
    };
    if let Some(obj) = tool_call.as_object_mut() {
        obj.retain(|k, v| !v.is_null() && k != "capabilities" && k != "sessionUpdate");
        if let Some(items) = obj.get("content").and_then(Value::as_array) {
            let (folded, _) = fold_content(items);
            obj.insert("content".into(), Value::Array(folded));
        }
        if !obj.get("title").is_some_and(|t| t.as_str().is_some_and(|t| !t.is_empty())) {
            if let Some(title) = params.get("title").filter(|t| t.is_string()) {
                obj.insert("title".into(), title.clone());
            }
        }
        obj.entry("toolCallId").or_insert_with(|| json!("permission"));
    }
    json!({
        "sessionId": params.get("sessionId").cloned().unwrap_or(Value::Null),
        "toolCall": tool_call,
        "options": params.get("options").cloned().unwrap_or_else(|| json!([])),
    })
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/// What one v2 update means for Flowcode.
pub(super) enum Out {
    /// A v1-shaped `session/update` body to log and show.
    Update(Value),
    /// `state_update` running: foreground work started (a prompt's turn or work the agent began).
    Running,
    /// `state_update` requires_action: the whole foreground waits on a permission or question.
    RequiresAction,
    /// `state_update` idle. `stop_reason` is `None` for a snapshot/repeat (never a completion);
    /// `error` is the JSON-RPC error v1 would have answered the prompt with; `background` is the
    /// complete list of background work when the agent reports one (items `{type:"terminal"|"tool_call"|"subagent", ...}`).
    Idle { stop_reason: Option<String>, error: Option<RpcError>, background: Option<Vec<Value>> },
}

#[derive(Default)]
struct Call {
    /// The content of the call without its terminal item, already v1.
    base: Vec<Value>,
    /// The terminal that shows this call's output.
    terminal: Option<String>,
}

#[derive(Default)]
struct Term {
    buf: Vec<u8>,
    truncated: bool,
    /// The tool call that shows it.
    call: Option<String>,
    exit: Option<Exit>,
}

#[derive(Clone)]
struct Exit {
    code: Option<i64>,
    signal: Option<String>,
}

/// What `translate` keeps between updates of one connection.
#[derive(Default)]
pub(super) struct V2State {
    /// The chat's own session; a `state_update` of any other session is a child's and is dropped.
    /// When unset, only sessions announced by a `subagent_update` count as children.
    pub(super) main: Option<String>,
    /// True while a `session/resume` replay runs: a `user_message` is history then, and becomes
    /// chunks; live it is the echo of our own prompt (Flowcode logs `User` itself) and is dropped.
    pub(super) replaying: bool,
    children: HashSet<String>,
    calls: HashMap<(String, String), Call>,
    terminals: HashMap<(String, String), Term>,
    /// The mode value last seen, to synthesize `current_mode_update` when it moves.
    mode: Option<String>,
}

impl V2State {
    pub(super) fn new(main_session: &str) -> Self {
        Self { main: Some(main_session.to_string()), ..Self::default() }
    }

    /// Remembers the mode a setup response (`setup_from_response`) reported.
    pub(super) fn observe_setup(&mut self, setup: &Value) {
        if let Some(mode) = setup.pointer("/modes/currentModeId").and_then(Value::as_str) {
            self.mode = Some(mode.to_string());
        }
    }

    fn is_child(&self, session_id: &str) -> bool {
        self.children.contains(session_id) || self.main.as_deref().is_some_and(|main| main != session_id)
    }
}

fn update_out(value: Value) -> Vec<Out> {
    vec![Out::Update(value)]
}

fn as_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Translates one v2 `session/update` of `session_id`. Unknown kinds (and the
/// ones v1 views have no use for) give nothing, so nothing v2-only reaches the log.
pub(super) fn translate(state: &mut V2State, session_id: &str, update: &Value) -> Vec<Out> {
    let Some(kind) = as_str(update, "sessionUpdate") else { return vec![] };
    match kind {
        // A native subagent's own session chatter (its config, commands, plan, usage...) is not the chat's: it would
        // move the model, mode, command list or plan of the main chat. Dropped here, before it can change `state.mode`.
        "config_option_update" | "available_commands_update" | "plan_update" | "plan_removed" | "usage_update" | "session_info_update"
        | "compaction_update" | "compaction_summary_chunk"
            if state.is_child(session_id) =>
        {
            vec![]
        }
        "state_update" => state_update(state, session_id, update),
        "tool_call" | "tool_call_update" => tool_call(state, session_id, update),
        "terminal_update" => terminal_update(state, session_id, update),
        "terminal_output_chunk" => terminal_chunk(state, session_id, update),
        "plan_update" => plan_update(update),
        "plan_removed" => update_out(json!({ "sessionUpdate": "plan", "entries": [] })),
        "user_message" if state.replaying => message_chunks(update, "user_message_chunk"),
        "agent_message" => message_chunks(update, "agent_message_chunk"),
        "agent_thought" => message_chunks(update, "agent_thought_chunk"),
        "config_option_update" => config_update(state, update),
        "available_commands_update" => {
            let commands = update.get("availableCommands").map_or_else(|| json!([]), commands_to_v1);
            update_out(json!({ "sessionUpdate": "available_commands_update", "availableCommands": commands }))
        }
        "subagent_update" => {
            if let Some(child) = as_str(update, "sessionId") {
                state.children.insert(child.to_string());
            }
            // `capabilities` (what the child session can do, e.g. cancel) is v2-only: nothing reads it.
            let mut announced = update.clone();
            if let Some(object) = announced.as_object_mut() {
                object.remove("capabilities");
            }
            update_out(announced)
        }
        "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" | "usage_update" | "session_info_update"
        | "compaction_update" | "compaction_summary_chunk" | "session_message" => update_out(update.clone()),
        // user_message (live echo), current_mode_update (v2 has none), notice, session_message_chunk,
        // tool_call_content_chunk, `_`-prefixed extensions (Codex `_subagent_update`, `_async_task_*`), unknown.
        _ => vec![],
    }
}

fn state_update(state: &V2State, session_id: &str, update: &Value) -> Vec<Out> {
    if state.is_child(session_id) {
        return vec![];
    }
    match as_str(update, "state") {
        Some("running") => vec![Out::Running],
        Some("requires_action") => vec![Out::RequiresAction],
        Some("idle") => {
            let stop_reason = as_str(update, "stopReason").filter(|r| !r.is_empty()).map(str::to_string);
            let error = update.get("error").filter(|e| e.is_object()).map(|e| RpcError {
                code: e.get("code").and_then(Value::as_i64).unwrap_or(-32603),
                message: as_str(e, "message").unwrap_or("unknown error").to_string(),
                data: e.get("data").filter(|d| !d.is_null()).cloned(),
            });
            let background = update.get("background").and_then(Value::as_array).cloned();
            vec![Out::Idle { stop_reason, error, background }]
        }
        _ => vec![],
    }
}

// --- messages ---------------------------------------------------------------

/// A full v2 message as one v1 chunk per block; an empty one only clears the
/// message (the adapters send it before replayed chunks) and gives nothing.
fn message_chunks(update: &Value, chunk_kind: &str) -> Vec<Out> {
    let message_id = update.get("messageId").cloned().unwrap_or(Value::Null);
    update
        .get("content")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|block| Out::Update(json!({ "sessionUpdate": chunk_kind, "messageId": message_id, "content": block })))
        .collect()
}

// --- config / mode ------------------------------------------------------------

fn config_update(state: &mut V2State, update: &Value) -> Vec<Out> {
    let options = update.get("configOptions").cloned().unwrap_or_else(|| json!([]));
    let mut out = vec![Out::Update(json!({ "sessionUpdate": "config_option_update", "configOptions": config_options_to_v1(&options) }))];
    let mode = mode_option(&options).and_then(|o| o.get("currentValue")).and_then(Value::as_str).map(str::to_string);
    if let Some(mode) = mode {
        if state.mode.as_deref() != Some(&mode) {
            out.push(Out::Update(json!({ "sessionUpdate": "current_mode_update", "currentModeId": mode })));
            state.mode = Some(mode);
        }
    }
    out
}

// --- plans --------------------------------------------------------------------

fn plan_update(update: &Value) -> Vec<Out> {
    let plan = update.get("plan");
    let entries = match plan.and_then(|p| as_str(p, "type")) {
        Some("items") => plan.and_then(|p| p.get("entries")).cloned().unwrap_or_else(|| json!([])),
        Some("markdown") => Value::Array(checklist_entries(plan.and_then(|p| as_str(p, "content")).unwrap_or(""))),
        _ => return vec![],
    };
    if entries.as_array().is_some_and(Vec::is_empty) && plan.and_then(|p| as_str(p, "type")) == Some("markdown") {
        return vec![]; // prose without a checklist: nothing to show as a plan
    }
    update_out(json!({ "sessionUpdate": "plan", "entries": entries }))
}

/// One plan entry per markdown checklist line (`- [ ] todo`, `- [x] done`,
/// `- [~] working`).
fn checklist_entries(markdown: &str) -> Vec<Value> {
    markdown
        .lines()
        .filter_map(|line| {
            let rest = line.trim_start().strip_prefix(['-', '*', '+'])?.strip_prefix(' ')?.trim_start();
            let mark = rest.strip_prefix('[')?.chars().next()?;
            let text = rest.get(1 + mark.len_utf8()..)?.strip_prefix(']')?.trim();
            if text.is_empty() {
                return None;
            }
            let status = match mark {
                'x' | 'X' => "completed",
                '~' | '-' | '/' | '>' => "in_progress",
                _ => "pending",
            };
            Some(json!({ "content": text, "priority": "medium", "status": status }))
        })
        .collect()
}

// --- tool calls ---------------------------------------------------------------

const CALL_FIELDS: [&str; 8] = ["name", "title", "kind", "status", "content", "locations", "rawInput", "rawOutput"];

fn text_block(text: &str) -> Value {
    json!({ "type": "content", "content": { "type": "text", "text": text } })
}

/// v2 tool content as v1: diffs folded, a `terminal` item taken out (its id is
/// returned; the output goes in as text, see `terminal_block`).
fn fold_content(items: &[Value]) -> (Vec<Value>, Option<String>) {
    let mut base = Vec::new();
    let mut terminal = None;
    for item in items {
        match as_str(item, "type") {
            Some("diff") => base.extend(fold_diff(item)),
            Some("terminal") => terminal = as_str(item, "terminalId").map(str::to_string),
            _ => base.push(item.clone()),
        }
    }
    (base, terminal)
}

/// `tool_call_update` / `tool_call`. The first report of a call is a v1
/// `tool_call`, later ones `tool_call_update`; `null` fields (v2: "clear")
/// are left out (v1: "unchanged"); a report that nulls two or more fields of a
/// call already known is a re-announce (Claude's `v2RestartedToolCall`) and
/// starts the call over as a fresh `tool_call`. `capabilities` (cancel) has no v1
/// meaning and is dropped, `paused` is shown as `in_progress`.
fn tool_call(state: &mut V2State, session_id: &str, update: &Value) -> Vec<Out> {
    let Some(obj) = update.as_object() else { return vec![] };
    let Some(id) = obj.get("toolCallId").and_then(Value::as_str) else { return vec![] };
    let key = (session_id.to_string(), id.to_string());
    let nulls = CALL_FIELDS.iter().filter(|f| obj.get(**f).is_some_and(Value::is_null)).count();
    let restarted = state.calls.contains_key(&key) && nulls >= 2;
    if restarted {
        state.calls.remove(&key);
        for (term_key, term) in state.terminals.iter_mut() {
            if term_key.0 == session_id && term.call.as_deref() == Some(id) {
                term.call = None;
            }
        }
    }
    let first = !state.calls.contains_key(&key);
    let mut out: serde_json::Map<String, Value> = obj
        .iter()
        .filter(|(k, v)| !v.is_null() && !matches!(k.as_str(), "sessionUpdate" | "capabilities" | "content"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    if out.get("status").and_then(Value::as_str) == Some("paused") {
        out.insert("status".into(), json!("in_progress"));
    }
    state.calls.entry(key.clone()).or_default();

    if let Some(items) = obj.get("content").and_then(Value::as_array) {
        let (base, terminal) = fold_content(items);
        let call = state.calls.get_mut(&key).expect("inserted above");
        call.base = base;
        call.terminal = terminal.clone();
        if let Some(terminal) = terminal {
            state.terminals.entry((session_id.to_string(), terminal)).or_default().call = Some(id.to_string());
        }
        out.insert("content".into(), Value::Array(call_content(state, &key)));
        // The terminal exited before this report named it (Codex sends the terminal first).
        if let Some(exit) = linked_exit(state, &key) {
            add_exit_fields(&mut out, &exit);
        }
    }

    if !first && !restarted && out.keys().all(|k| k == "toolCallId" || k == "_meta") {
        return vec![]; // a cancel advert, a metadata reset...: nothing v1 shows
    }
    let kind = if first || restarted { "tool_call" } else { "tool_call_update" };
    out.insert("sessionUpdate".into(), json!(kind));
    if kind == "tool_call" && !out.contains_key("title") {
        let title = out.get("name").and_then(Value::as_str).unwrap_or(id).to_string();
        out.insert("title".into(), json!(title));
    }
    update_out(Value::Object(out))
}

/// The call's content: what it lists plus its terminal's output so far as text.
fn call_content(state: &V2State, key: &(String, String)) -> Vec<Value> {
    let Some(call) = state.calls.get(key) else { return vec![] };
    let mut content = call.base.clone();
    if let Some(term) = call.terminal.as_ref().and_then(|t| state.terminals.get(&(key.0.clone(), t.clone()))) {
        if !term.buf.is_empty() {
            let mut text = String::new();
            if term.truncated {
                text.push_str(TRUNCATED_NOTE);
            }
            text.push_str(&String::from_utf8_lossy(&term.buf));
            content.push(text_block(&text));
        }
    }
    content
}

fn linked_exit(state: &V2State, key: &(String, String)) -> Option<Exit> {
    let terminal = state.calls.get(key)?.terminal.as_ref()?;
    state.terminals.get(&(key.0.clone(), terminal.clone()))?.exit.clone()
}

/// The exit status as the call's `status` (0 completed, anything else failed;
/// left alone when the exit names neither) and `rawOutput.exitCode`.
fn add_exit_fields(out: &mut serde_json::Map<String, Value>, exit: &Exit) {
    match (exit.code, &exit.signal) {
        (Some(0), None) => {
            out.insert("status".into(), json!("completed"));
        }
        (Some(_), _) | (_, Some(_)) => {
            out.insert("status".into(), json!("failed"));
        }
        (None, None) => {}
    }
    let mut raw = serde_json::Map::new();
    if let Some(code) = exit.code {
        raw.insert("exitCode".into(), json!(code));
    }
    if let Some(signal) = &exit.signal {
        raw.insert("signal".into(), json!(signal));
    }
    if !raw.is_empty() {
        out.insert("rawOutput".into(), Value::Object(raw));
    }
}

// --- terminals ----------------------------------------------------------------

fn decode(data: &str) -> Vec<u8> {
    base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default()
}

fn append(term: &mut Term, bytes: &[u8]) {
    if term.buf.len() + bytes.len() > MAX_TERMINAL_BYTES {
        term.truncated = true;
    }
    push_tail(&mut term.buf, bytes, MAX_TERMINAL_BYTES);
}

/// `terminal_update`: `output` is a replacement snapshot, `exitStatus` ends it.
fn terminal_update(state: &mut V2State, session_id: &str, update: &Value) -> Vec<Out> {
    let Some(terminal_id) = as_str(update, "terminalId") else { return vec![] };
    let key = (session_id.to_string(), terminal_id.to_string());
    let term = state.terminals.entry(key.clone()).or_default();
    let mut changed = false;
    if let Some(data) = update.pointer("/output/data").and_then(Value::as_str) {
        term.buf.clear();
        term.truncated = false;
        append(term, &decode(data));
        changed = true;
    }
    if let Some(exit) = update.get("exitStatus").filter(|e| e.is_object()) {
        term.exit = Some(Exit { code: exit.get("exitCode").and_then(Value::as_i64), signal: as_str(exit, "signal").map(str::to_string) });
        changed = true;
    }
    if changed { terminal_out(state, &key) } else { vec![] }
}

/// `terminal_output_chunk`: appends to the output.
fn terminal_chunk(state: &mut V2State, session_id: &str, update: &Value) -> Vec<Out> {
    let (Some(terminal_id), Some(data)) = (as_str(update, "terminalId"), as_str(update, "data")) else { return vec![] };
    let key = (session_id.to_string(), terminal_id.to_string());
    append(state.terminals.entry(key.clone()).or_default(), &decode(data));
    terminal_out(state, &key)
}

/// The `tool_call_update` that shows a terminal's output in its call; nothing
/// while no call shows it yet (the output comes with the call's content then).
/// A terminal named like a tool call (Claude does that) is linked to it.
fn terminal_out(state: &mut V2State, key: &(String, String)) -> Vec<Out> {
    let call_id = match state.terminals.get(key).and_then(|t| t.call.clone()) {
        Some(call) => call,
        None if state.calls.contains_key(key) => {
            state.terminals.get_mut(key).expect("inserted by the caller").call = Some(key.1.clone());
            state.calls.get_mut(key).expect("checked").terminal = Some(key.1.clone());
            key.1.clone()
        }
        None => return vec![],
    };
    let call_key = (key.0.clone(), call_id.clone());
    if !state.calls.contains_key(&call_key) {
        return vec![];
    }
    let mut out = serde_json::Map::new();
    out.insert("sessionUpdate".into(), json!("tool_call_update"));
    out.insert("toolCallId".into(), json!(call_id));
    out.insert("content".into(), Value::Array(call_content(state, &call_key)));
    if let Some(exit) = state.terminals.get(key).and_then(|t| t.exit.clone()) {
        add_exit_fields(&mut out, &exit);
    }
    update_out(Value::Object(out))
}

// --- diffs ----------------------------------------------------------------------

#[derive(Default)]
struct Section {
    head: String,
    old: Vec<String>,
    new: Vec<String>,
    has_hunks: bool,
}

/// Splits a git patch into its files and the old/new lines of their hunks.
/// Hunks of one file are joined as they come (the gaps between them are not
/// in the patch), so the v1 diff shows the changed regions only.
fn parse_patch(text: &str) -> Vec<Section> {
    let mut sections: Vec<Section> = Vec::new();
    let mut in_hunk = false;
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    for line in lines {
        if line.starts_with("diff --git ") {
            sections.push(Section { head: line.to_string(), ..Section::default() });
            in_hunk = false;
            continue;
        }
        if sections.is_empty() {
            sections.push(Section::default());
        }
        let section = sections.last_mut().expect("pushed above");
        if line.starts_with("@@") {
            in_hunk = true;
            section.has_hunks = true;
        } else if !in_hunk {
            section.head.push('\n');
            section.head.push_str(line);
        } else {
            match line.chars().next() {
                Some('-') => section.old.push(line[1..].to_string()),
                Some('+') => section.new.push(line[1..].to_string()),
                Some(' ') => {
                    section.old.push(line[1..].to_string());
                    section.new.push(line[1..].to_string());
                }
                None => {
                    section.old.push(String::new());
                    section.new.push(String::new());
                }
                _ => {} // "\ No newline at end of file"
            }
        }
    }
    sections
}

fn mentions(head: &str, path: &str) -> bool {
    head.contains(path) || head.contains(&path.replace('\\', "\\\\")) || head.contains(path.trim_start_matches('/'))
}

/// A v2 diff (`changes` + `patch`, no old/new text) as v1 diffs
/// `{type:"diff", path, oldText, newText}`, one per change, built from the
/// patch hunks (an approximation: changed regions only). A change with no
/// hunks (a binary file, a move, a missing patch) becomes a text line.
fn fold_diff(item: &Value) -> Vec<Value> {
    let changes = item.get("changes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
    let sections = item.pointer("/patch/text").and_then(Value::as_str).map(parse_patch).unwrap_or_default();
    changes
        .iter()
        .enumerate()
        .map(|(i, change)| {
            let path = as_str(change, "path").unwrap_or("");
            let operation = as_str(change, "operation").unwrap_or("modify");
            let section = if sections.len() == changes.len() { sections.get(i) } else { sections.iter().find(|s| mentions(&s.head, path)) };
            match section.filter(|s| s.has_hunks) {
                Some(section) => json!({
                    "type": "diff",
                    "path": path,
                    "oldText": if operation == "add" { Value::Null } else { json!(section.old.join("\n")) },
                    "newText": if operation == "delete" { String::new() } else { section.new.join("\n") },
                }),
                None => {
                    let text = match operation {
                        "add" => format!("Created {path}"),
                        "delete" => format!("Deleted {path}"),
                        "move" => format!("Moved {} to {path}", as_str(change, "oldPath").unwrap_or("?")),
                        "copy" => format!("Copied {} to {path}", as_str(change, "oldPath").unwrap_or("?")),
                        _ => format!("Edited {path}"),
                    };
                    text_block(&text)
                }
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE_FIXTURE: &str = include_str!("fixtures/acp_v2_claude.jsonl");
    const CODEX_FIXTURE: &str = include_str!("fixtures/acp_v2_codex.jsonl");

    /// The kinds `src/chat/chatModel.ts` `applyUpdate` handles (lines ~720-760) plus `usage_update`
    /// (cacheWarning.ts) and `session_info_update` (the backend's own `log_native_subagent` list).
    const KNOWN_KINDS: &[&str] = &[
        "user_message_chunk", "agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "subagent_update",
        "session_message", "compaction_update", "compaction_summary_chunk", "plan", "available_commands_update",
        "current_mode_update", "config_option_update", "usage_update", "session_info_update",
    ];

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    fn updates(out: Vec<Out>) -> Vec<Value> {
        out.into_iter().filter_map(|o| if let Out::Update(v) = o { Some(v) } else { None }).collect()
    }

    fn one(out: Vec<Out>) -> Value {
        let mut list = updates(out);
        assert_eq!(list.len(), 1, "expected one update, got {list:?}");
        list.remove(0)
    }

    fn run(state: &mut V2State, update: Value) -> Vec<Out> {
        translate(state, "s1", &update)
    }

    fn state() -> V2State {
        V2State::new("s1")
    }

    #[test]
    fn builds_the_v2_requests() {
        let init = initialize_params("flowcode", "1.2.3");
        assert_eq!(init["protocolVersion"], 2);
        assert_eq!(init["info"], json!({ "name": "flowcode", "version": "1.2.3" }));
        assert!(init.get("clientInfo").is_none() && init.get("clientCapabilities").is_none());
        assert!(init["capabilities"].get("fs").is_none() && init["capabilities"].get("terminal").is_none());

        let mcp = json!([{ "name": "flowcode", "command": "node", "args": ["x.cjs"], "env": [{ "name": "A", "value": "b" }] }]);
        let resume = resume_params("sess", "/w", &mcp);
        assert_eq!(resume["replayFrom"], json!({ "type": "start" }));
        assert_eq!(resume["sessionId"], "sess");
        assert_eq!(resume["mcpServers"][0]["type"], "stdio");
        assert_eq!(new_session_params("/w", &mcp)["mcpServers"][0]["type"], "stdio");
        assert!(new_session_params("/w", &mcp).get("replayFrom").is_none());

        assert_eq!(set_config_option_params("s", "model", &json!("opus")), json!({ "sessionId": "s", "configId": "model", "type": "id", "value": "opus" }));
        assert_eq!(set_config_option_params("s", "brief", &json!(true)), json!({ "sessionId": "s", "configId": "brief", "type": "boolean", "value": true }));
    }

    #[test]
    fn tags_mcp_servers_by_transport() {
        let tagged = tag_mcp_servers(&json!([
            { "name": "a", "command": "node", "args": [] },
            { "name": "b", "url": "https://x", "headers": [] },
            { "name": "c", "type": "sse", "url": "https://y" },
            { "name": "d", "type": "http", "url": "https://z" },
            { "name": "e" },
        ]));
        let types: Vec<&str> = tagged.as_array().unwrap().iter().map(|s| s["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["stdio", "http", "http"]);
        assert_eq!(tag_mcp_servers(&Value::Null), json!([]));
    }

    #[test]
    fn reads_initialize_capabilities_and_checks_the_version() {
        let ok = json!({ "protocolVersion": 2, "capabilities": { "session": { "prompt": { "image": {}, "embeddedContext": {} } } } });
        assert_eq!(caps_from_initialize(&ok), Ok(Caps { prompt_images: true, can_close: true, can_load: true }));
        let no_images = json!({ "protocolVersion": 2, "capabilities": { "session": { "prompt": {} } } });
        assert!(!caps_from_initialize(&no_images).unwrap().prompt_images);
        assert!(!caps_from_initialize(&json!({ "protocolVersion": 2 })).unwrap().prompt_images);
        for bad in [json!({ "protocolVersion": 1, "agentCapabilities": {} }), json!({}), json!({ "protocolVersion": 3 })] {
            assert!(caps_from_initialize(&bad).unwrap_err().starts_with("acp_v2_fallback"));
        }
    }

    fn setup_result() -> Value {
        json!({
            "sessionId": "s1",
            "configOptions": [
                { "configId": "mode", "type": "select", "name": "Mode", "category": "mode", "currentValue": "default",
                  "options": [{ "value": "default", "name": "Default", "description": "Asks" }, { "value": "plan", "name": "Plan" }] },
                { "configId": "effort", "type": "select", "name": "Thinking", "category": "thought_level", "currentValue": "low",
                  "options": [{ "groupId": "std", "name": "Standard", "options": [{ "value": "low", "name": "Low" }] }] },
            ],
            "availableCommands": [
                { "type": "command", "name": "compact", "description": "Compact", "input": { "type": "text", "hint": "focus" } },
                { "type": "command", "name": "init", "description": "Init" },
                { "type": "_custom", "name": "x" },
            ],
        })
    }

    #[test]
    fn setup_response_becomes_the_v1_shape() {
        let setup = setup_result();
        let v1 = setup_from_response(&setup);
        let options = &v1["configOptions"];
        assert_eq!(options[0]["id"], "mode");
        assert!(options[0].get("configId").is_none());
        assert_eq!(options[1]["options"][0]["group"], "std");
        assert!(options[1]["options"][0].get("groupId").is_none());
        // The renamed options are what models.rs reads.
        assert_eq!(thought_from_config_options(options).unwrap().config_id, "effort");
        assert_eq!(v1["modes"]["currentModeId"], "default");
        assert_eq!(v1["modes"]["availableModes"], json!([{ "id": "default", "name": "Default", "description": "Asks" }, { "id": "plan", "name": "Plan" }]));
        assert_eq!(v1["availableCommands"], json!([{ "name": "compact", "description": "Compact", "input": { "hint": "focus" } }, { "name": "init", "description": "Init" }]));
        assert_eq!(mode_config_id(&setup["configOptions"]).as_deref(), Some("mode"));

        let bare = setup_from_response(&json!({ "sessionId": "s" }));
        assert_eq!(bare, json!({ "availableCommands": [] }));
    }

    #[test]
    fn tool_calls_upsert_and_drop_nulls() {
        let mut st = state();
        let first = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "name": "Bash", "title": "ls", "kind": "execute", "status": "pending",
            "content": null, "locations": null, "capabilities": { "cancel": {} }, "_meta": { "claudeCode": { "toolName": "Bash" } } })));
        assert_eq!(first["sessionUpdate"], "tool_call");
        assert_eq!(first["toolCallId"], "t1");
        assert_eq!(first["title"], "ls");
        assert!(first.get("content").is_none() && first.get("locations").is_none() && first.get("capabilities").is_none());
        assert_eq!(first["_meta"]["claudeCode"]["toolName"], "Bash");

        let next = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed", "rawOutput": null })));
        assert_eq!(next, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed" }));

        // A capabilities-only report (cancel advert) or a metadata reset shows nothing.
        assert!(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "capabilities": { "cancel": {} } })).is_empty());
        assert!(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "_meta": null })).is_empty());

        // paused is shown as in progress.
        let paused = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "paused" })));
        assert_eq!(paused["status"], "in_progress");

        // The same id on another session is another call.
        let other = one(translate(&mut st, "child", &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "x" })));
        assert_eq!(other["sessionUpdate"], "tool_call");
    }

    #[test]
    fn a_reannounced_call_starts_over() {
        let mut st = state();
        run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Bash", "kind": "execute", "status": "completed", "rawOutput": "old" }));
        // Claude's v2RestartedToolCall: omitted fields are null.
        let again = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "t1", "title": "Bash", "kind": "execute", "status": "pending",
            "content": null, "locations": null, "rawInput": null, "rawOutput": null })));
        assert_eq!(again["sessionUpdate"], "tool_call");
        assert_eq!(again["title"], "Bash");
        assert!(again.get("rawOutput").is_none() && again.get("content").is_none());
    }

    #[test]
    fn diffs_are_rebuilt_from_the_patch_hunks() {
        let mut st = state();
        let patch = "diff --git /w/a.ts /w/a.ts\n--- /w/a.ts\n+++ /w/a.ts\n@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n\n@@ -9,2 +9,3 @@\n nine\n+ten\n";
        let call = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e1", "title": "Edit", "kind": "edit",
            "content": [{ "type": "diff", "changes": [{ "operation": "modify", "path": "/w/a.ts", "fileType": "text" }], "patch": { "format": "git_patch", "text": patch } }] })));
        assert_eq!(call["content"], json!([{ "type": "diff", "path": "/w/a.ts", "oldText": "one\ntwo\nthree\n\nnine", "newText": "one\nTWO\nthree\n\nnine\nten" }]));

        // add: no old text; delete: no new text; two files in one diff, paired in order.
        let add = "diff --git /w/n.ts /w/n.ts\nnew file mode 100644\n--- /dev/null\n+++ /w/n.ts\n@@ -0,0 +1,2 @@\n+a\n+b\n";
        let del = "diff --git /w/o.ts /w/o.ts\n--- /w/o.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n";
        let multi = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e2", "title": "Patch",
            "content": [{ "type": "diff", "changes": [{ "operation": "add", "path": "/w/n.ts" }, { "operation": "delete", "path": "/w/o.ts" }],
                          "patch": { "format": "git_patch", "text": format!("{add}{del}") } }] })));
        assert_eq!(multi["content"][0], json!({ "type": "diff", "path": "/w/n.ts", "oldText": null, "newText": "a\nb" }));
        assert_eq!(multi["content"][1], json!({ "type": "diff", "path": "/w/o.ts", "oldText": "gone", "newText": "" }));

        // Counts differ: matched by path. No patch: a text line.
        let by_path = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "e3", "title": "Patch",
            "content": [{ "type": "diff", "changes": [{ "operation": "modify", "path": "/w/o.ts" }, { "operation": "move", "oldPath": "/w/x", "path": "/w/y" }],
                          "patch": { "format": "git_patch", "text": del } }] })));
        assert_eq!(by_path["content"][0]["oldText"], "gone");
        assert_eq!(by_path["content"][1]["content"]["text"], "Moved /w/x to /w/y");
    }

    #[test]
    fn terminal_output_is_folded_into_the_call() {
        let mut st = state();
        let call = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "b1", "title": "ls", "kind": "execute",
            "content": [{ "type": "content", "content": { "type": "text", "text": "note" } }, { "type": "terminal", "terminalId": "term1" }] })));
        // No output yet: the terminal item is gone, the rest stays.
        assert_eq!(call["content"], json!([{ "type": "content", "content": { "type": "text", "text": "note" } }]));

        let chunk = one(run(&mut st, json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "term1", "data": b64("a\n") })));
        assert_eq!(chunk["sessionUpdate"], "tool_call_update");
        assert_eq!(chunk["toolCallId"], "b1");
        assert_eq!(chunk["content"][1]["content"]["text"], "a\n");
        let more = one(run(&mut st, json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "term1", "data": b64("b\n") })));
        assert_eq!(more["content"][1]["content"]["text"], "a\nb\n");
        // A snapshot replaces what came before.
        let snap = one(run(&mut st, json!({ "sessionUpdate": "terminal_update", "terminalId": "term1", "output": { "data": b64("fresh\n") } })));
        assert_eq!(snap["content"][1]["content"]["text"], "fresh\n");
        assert!(snap.get("status").is_none());
        // Command-only / capability-only updates show nothing.
        assert!(run(&mut st, json!({ "sessionUpdate": "terminal_update", "terminalId": "term1", "command": "ls", "capabilities": { "cancel": {} } })).is_empty());

        let exit = one(run(&mut st, json!({ "sessionUpdate": "terminal_update", "terminalId": "term1", "exitStatus": { "exitCode": 2, "signal": null } })));
        assert_eq!(exit["status"], "failed");
        assert_eq!(exit["rawOutput"], json!({ "exitCode": 2 }));
        let ok = {
            run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "b2", "title": "true", "content": [{ "type": "terminal", "terminalId": "term2" }] }));
            one(run(&mut st, json!({ "sessionUpdate": "terminal_update", "terminalId": "term2", "exitStatus": { "exitCode": 0 } })))
        };
        assert_eq!((ok["status"].as_str(), ok["rawOutput"]["exitCode"].as_i64()), (Some("completed"), Some(0)));
    }

    #[test]
    fn terminal_before_its_call_and_terminal_named_like_the_call() {
        let mut st = state();
        // Codex sends the terminal first: nothing to show yet, the call's content carries the output.
        assert!(run(&mut st, json!({ "sessionUpdate": "terminal_update", "terminalId": "c1", "command": "npm test" })).is_empty());
        assert!(run(&mut st, json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "c1", "data": b64("x\n") })).is_empty());
        assert!(run(&mut st, json!({ "sessionUpdate": "terminal_update", "terminalId": "c1", "output": { "data": b64("x\ny\n") }, "exitStatus": { "exitCode": 1, "signal": null } })).is_empty());
        let call = one(run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call", "title": "npm test", "content": [{ "type": "terminal", "terminalId": "c1" }] })));
        assert_eq!(call["content"][0]["content"]["text"], "x\ny\n");
        assert_eq!(call["status"], "failed");
        assert_eq!(call["rawOutput"]["exitCode"], 1);

        // A terminal named after its tool call (Claude) links without a content item.
        run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "toolu_9", "title": "ls" }));
        let out = one(run(&mut st, json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "toolu_9", "data": b64("hi") })));
        assert_eq!((out["toolCallId"].as_str(), out["content"][0]["content"]["text"].as_str()), (Some("toolu_9"), Some("hi")));
    }

    #[test]
    fn terminal_output_is_capped_to_the_last_64_kib() {
        let mut st = state();
        run(&mut st, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "b", "title": "x", "content": [{ "type": "terminal", "terminalId": "t" }] }));
        let line = format!("{}\n", "x".repeat(1023));
        let mut last = Value::Null;
        for _ in 0..100 {
            last = one(run(&mut st, json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "t", "data": b64(&line) })));
        }
        let text = last["content"][0]["content"]["text"].as_str().unwrap();
        assert!(text.starts_with(TRUNCATED_NOTE));
        assert_eq!(text.len(), MAX_TERMINAL_BYTES + TRUNCATED_NOTE.len());
        assert!(text.ends_with(&line));
        // A snapshot starts a fresh buffer.
        let snap = one(run(&mut st, json!({ "sessionUpdate": "terminal_update", "terminalId": "t", "output": { "data": b64("ok") } })));
        assert_eq!(snap["content"][0]["content"]["text"], "ok");
        // Bad base64 is ignored, not fatal.
        run(&mut st, json!({ "sessionUpdate": "terminal_output_chunk", "terminalId": "t", "data": "%%%" }));
    }

    #[test]
    fn plans_items_markdown_and_removed() {
        let mut st = state();
        let entries = json!([{ "content": "a", "priority": "medium", "status": "pending" }]);
        let items = one(run(&mut st, json!({ "sessionUpdate": "plan_update", "plan": { "type": "items", "planId": "plan", "entries": entries } })));
        assert_eq!(items, json!({ "sessionUpdate": "plan", "entries": entries }));

        let md = one(run(&mut st, json!({ "sessionUpdate": "plan_update", "plan": { "type": "markdown", "planId": "p", "content": "# Plan\n\n- [ ] first\n- [x] second\n  * [~] third\nplain text\n- [ ]\n" } })));
        let statuses: Vec<(&str, &str)> = md["entries"].as_array().unwrap().iter().map(|e| (e["content"].as_str().unwrap(), e["status"].as_str().unwrap())).collect();
        assert_eq!(statuses, [("first", "pending"), ("second", "completed"), ("third", "in_progress")]);

        // Prose with no checklist is dropped; removal clears the plan.
        assert!(run(&mut st, json!({ "sessionUpdate": "plan_update", "plan": { "type": "markdown", "planId": "p", "content": "just words" } })).is_empty());
        assert_eq!(one(run(&mut st, json!({ "sessionUpdate": "plan_removed", "planId": "p" }))), json!({ "sessionUpdate": "plan", "entries": [] }));
    }

    #[test]
    fn user_and_agent_messages_replay_but_the_live_echo_is_dropped() {
        let mut st = state();
        let echo = json!({ "sessionUpdate": "user_message", "messageId": "m1", "content": [{ "type": "text", "text": "hi" }] });
        assert!(run(&mut st, echo.clone()).is_empty(), "live echo is dropped");

        st.replaying = true;
        // The empty message that clears, then the chunks, then a full message.
        assert!(run(&mut st, json!({ "sessionUpdate": "user_message", "messageId": "m1", "content": [] })).is_empty());
        let replayed = updates(run(&mut st, echo));
        assert_eq!(replayed, vec![json!({ "sessionUpdate": "user_message_chunk", "messageId": "m1", "content": { "type": "text", "text": "hi" } })]);
        let chunk = json!({ "sessionUpdate": "agent_message_chunk", "messageId": "a1", "content": { "type": "text", "text": "yo" } });
        assert_eq!(one(run(&mut st, chunk.clone())), chunk);
        assert!(run(&mut st, json!({ "sessionUpdate": "agent_message", "messageId": "a1", "content": [] })).is_empty());
        let full = updates(run(&mut st, json!({ "sessionUpdate": "agent_message", "messageId": "a2", "content": [{ "type": "text", "text": "one" }, { "type": "text", "text": "two" }] })));
        assert_eq!(full.len(), 2);
        assert_eq!(full[1], json!({ "sessionUpdate": "agent_message_chunk", "messageId": "a2", "content": { "type": "text", "text": "two" } }));
        let thought = one(run(&mut st, json!({ "sessionUpdate": "agent_thought", "messageId": "t1", "content": [{ "type": "text", "text": "hm" }] })));
        assert_eq!(thought["sessionUpdate"], "agent_thought_chunk");
    }

    #[test]
    fn config_updates_are_renamed_and_synthesize_the_mode_update() {
        let mut st = state();
        st.observe_setup(&setup_from_response(&setup_result()));
        let options = |mode: &str| json!([
            { "configId": "mode", "type": "select", "category": "mode", "currentValue": mode, "options": [{ "value": "default", "name": "D" }, { "value": "plan", "name": "P" }] },
            { "configId": "model", "type": "select", "category": "model", "currentValue": "opus", "options": [{ "groupId": "g", "name": "G", "options": [{ "value": "opus", "name": "Opus" }] }] },
        ]);
        // The mode did not move: only the renamed config update.
        let same = updates(run(&mut st, json!({ "sessionUpdate": "config_option_update", "configOptions": options("default") })));
        assert_eq!(same.len(), 1);
        assert_eq!(same[0]["configOptions"][0]["id"], "mode");
        assert_eq!(same[0]["configOptions"][1]["options"][0]["group"], "g");
        // The mode moved: the config update, then a current_mode_update; once.
        let moved = updates(run(&mut st, json!({ "sessionUpdate": "config_option_update", "configOptions": options("plan") })));
        assert_eq!(moved.len(), 2);
        assert_eq!(moved[1], json!({ "sessionUpdate": "current_mode_update", "currentModeId": "plan" }));
        assert_eq!(updates(run(&mut st, json!({ "sessionUpdate": "config_option_update", "configOptions": options("plan") }))).len(), 1);
        // v2 never sends current_mode_update; one that arrives is dropped.
        assert!(run(&mut st, json!({ "sessionUpdate": "current_mode_update", "currentModeId": "x" })).is_empty());
    }

    #[test]
    fn permission_requests_are_rewritten_to_v1() {
        let options = json!([{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }]);
        let params = json!({ "sessionId": "s1", "title": "Make edits?", "description": "d", "options": options,
            "subject": { "type": "tool_call", "toolCall": { "toolCallId": "t1", "kind": "edit", "rawInput": { "path": "/w/a" }, "content": [
                { "type": "diff", "changes": [{ "operation": "modify", "path": "/w/a" }], "patch": { "format": "git_patch", "text": "@@ -1 +1 @@\n-a\n+b\n" } }], "capabilities": null } } });
        let v1 = permission_params(&params);
        assert_eq!(v1["sessionId"], "s1");
        assert_eq!(v1["options"], options);
        assert_eq!(v1["toolCall"]["title"], "Make edits?");
        assert_eq!(v1["toolCall"]["toolCallId"], "t1");
        assert_eq!(v1["toolCall"]["rawInput"]["path"], "/w/a");
        assert_eq!(v1["toolCall"]["content"][0], json!({ "type": "diff", "path": "/w/a", "oldText": "a", "newText": "b" }));
        assert!(v1["toolCall"].get("capabilities").is_none() && v1.get("subject").is_none() && v1.get("title").is_none());

        // A title the tool call has wins over the request's.
        let kept = permission_params(&json!({ "sessionId": "s1", "title": "Run?", "options": [], "subject": { "type": "tool_call", "toolCall": { "toolCallId": "t", "title": "rm -rf x" } } }));
        assert_eq!(kept["toolCall"]["title"], "rm -rf x");
        // A command subject becomes an execute tool call.
        let cmd = permission_params(&json!({ "sessionId": "s1", "title": "Run command?", "options": [], "subject": { "type": "command", "command": "ls", "cwd": "/w", "toolCallId": "c" } }));
        assert_eq!((cmd["toolCall"]["kind"].as_str(), cmd["toolCall"]["rawInput"]["command"].as_str(), cmd["toolCall"]["title"].as_str()), (Some("execute"), Some("ls"), Some("Run command?")));
    }

    #[test]
    fn state_updates_drive_the_turn() {
        let mut st = state();
        assert!(matches!(run(&mut st, json!({ "sessionUpdate": "state_update", "state": "running" })).as_slice(), [Out::Running]));
        assert!(matches!(run(&mut st, json!({ "sessionUpdate": "state_update", "state": "requires_action", "background": [] })).as_slice(), [Out::RequiresAction]));

        let done = run(&mut st, json!({ "sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn", "background": [{ "type": "subagent", "sessionId": "c" }, { "type": "terminal", "terminalId": "t" }] }));
        let [Out::Idle { stop_reason, error, background }] = done.as_slice() else { panic!("not idle") };
        assert_eq!(stop_reason.as_deref(), Some("end_turn"));
        assert!(error.is_none());
        assert_eq!(background.as_ref().map(Vec::len), Some(2));

        // idle without a stop reason is a snapshot: never a completion. No background key = None.
        let snapshot = run(&mut st, json!({ "sessionUpdate": "state_update", "state": "idle" }));
        assert!(matches!(snapshot.as_slice(), [Out::Idle { stop_reason: None, error: None, background: None }]));
        let empty = run(&mut st, json!({ "sessionUpdate": "state_update", "state": "idle", "background": [] }));
        assert!(matches!(empty.as_slice(), [Out::Idle { stop_reason: None, background: Some(b), .. }] if b.is_empty()));

        // Other states and unknown ones give nothing.
        assert!(run(&mut st, json!({ "sessionUpdate": "state_update", "state": "unknown" })).is_empty());
        // A child's own state_update is dropped (the parent's subagent_update mirror carries it).
        assert!(translate(&mut st, "child", &json!({ "sessionUpdate": "state_update", "state": "running" })).is_empty());
        let mut loose = V2State::default();
        translate(&mut loose, "s1", &json!({ "sessionUpdate": "subagent_update", "sessionId": "kid", "state": { "state": "running" } }));
        assert!(translate(&mut loose, "kid", &json!({ "sessionUpdate": "state_update", "state": "idle", "stopReason": "end_turn" })).is_empty());
        assert!(matches!(translate(&mut loose, "s1", &json!({ "sessionUpdate": "state_update", "state": "running" })).as_slice(), [Out::Running]));
    }

    #[test]
    fn an_idle_error_becomes_an_rpc_error_that_is_a_limit() {
        let mut st = state();
        let out = run(&mut st, json!({ "sessionUpdate": "state_update", "state": "idle", "stopReason": "error",
            "error": { "code": -32603, "message": "Internal error: You've hit your 5-hour limit", "data": { "errorKind": "rate_limit" } } }));
        let [Out::Idle { stop_reason, error: Some(error), .. }] = out.as_slice() else { panic!("no error") };
        assert_eq!(stop_reason.as_deref(), Some("error"));
        assert_eq!(error.code, -32603);
        assert!(is_limit_error(error));
        assert_eq!(error_text(error), "You've hit your 5-hour limit");

        // Codex: no data, the wording says it.
        let codex = run(&mut st, json!({ "sessionUpdate": "state_update", "state": "idle", "stopReason": "error", "error": { "code": -32603, "message": "You've hit your usage limit. Try again at 3:45 PM." } }));
        let [Out::Idle { error: Some(error), .. }] = codex.as_slice() else { panic!("no error") };
        assert!(is_limit_error(error));
        // A session that is gone is told apart too.
        let gone = run(&mut st, json!({ "sessionUpdate": "state_update", "state": "idle", "stopReason": "error", "error": { "code": -32603, "message": "Internal error: The Claude Agent session has ended. Please start a new session." } }));
        let [Out::Idle { error: Some(error), .. }] = gone.as_slice() else { panic!("no error") };
        assert!(is_session_gone(error) && !is_limit_error(error));
    }

    #[test]
    fn passes_known_kinds_and_drops_unknown_ones() {
        let mut st = state();
        for kind in ["usage_update", "session_info_update", "compaction_update", "compaction_summary_chunk", "session_message"] {
            let update = json!({ "sessionUpdate": kind, "x": 1 });
            assert_eq!(one(run(&mut st, update.clone())), update, "{kind}");
        }
        let sub = json!({ "sessionUpdate": "subagent_update", "sessionId": "kid", "title": "Explore", "state": { "state": "running" } });
        assert_eq!(one(run(&mut st, sub.clone())), sub);
        for kind in ["notice", "tool_call_content_chunk", "_subagent_update", "_async_task_state_update", "something_new", "current_mode_update"] {
            assert!(run(&mut st, json!({ "sessionUpdate": kind })).is_empty(), "{kind}");
        }
        assert!(run(&mut st, json!({ "nothing": true })).is_empty());
        assert!(run(&mut st, json!({ "sessionUpdate": "tool_call_update" })).is_empty(), "no toolCallId");

        let commands = one(run(&mut st, json!({ "sessionUpdate": "available_commands_update", "availableCommands": [{ "type": "command", "name": "c", "description": "d", "input": { "type": "text", "hint": "h" } }] })));
        assert_eq!(commands["availableCommands"], json!([{ "name": "c", "description": "d", "input": { "hint": "h" } }]));
    }

    /// Replays a hand-built (source-derived, not recorded) stream: the agent's side goes through the codec.
    fn replay(fixture: &str) -> (Vec<Value>, Vec<Out>, usize) {
        let mut st = V2State::default();
        let mut updates = Vec::new();
        let mut states = Vec::new();
        let mut resume_id = None;
        let mut permissions = 0;
        for line in fixture.lines().filter(|l| !l.trim().is_empty()) {
            let msg: Value = serde_json::from_str(line).unwrap_or_else(|e| panic!("bad fixture line ({e}): {line}"));
            if msg.get("_comment").is_some() {
                continue;
            }
            if msg.get("_dir").and_then(Value::as_str) == Some("c2a") {
                if msg.get("method").and_then(Value::as_str) == Some("session/resume") {
                    st.replaying = true;
                    resume_id = msg.get("id").cloned();
                }
                continue;
            }
            match msg.get("method").and_then(Value::as_str) {
                Some("session/update") => {
                    let params = &msg["params"];
                    let sid = params["sessionId"].as_str().unwrap();
                    for out in translate(&mut st, sid, &params["update"]) {
                        match out {
                            Out::Update(v) => updates.push(v),
                            other => states.push(other),
                        }
                    }
                }
                Some("session/request_permission") => {
                    let v1 = permission_params(&msg["params"]);
                    assert!(v1["toolCall"]["toolCallId"].is_string() && v1["toolCall"]["title"].is_string() && v1["options"].is_array());
                    permissions += 1;
                }
                _ => {
                    let result = &msg["result"];
                    if resume_id.as_ref() == msg.get("id") && msg.get("id").is_some() {
                        st.replaying = false;
                        resume_id = None;
                    }
                    if result.pointer("/capabilities/session").is_some() {
                        assert!(caps_from_initialize(result).unwrap().prompt_images);
                    }
                    if result.get("configOptions").is_some() {
                        let setup = setup_from_response(result);
                        assert!(setup["configOptions"][0].get("id").is_some());
                        assert!(setup["modes"]["availableModes"].as_array().is_some_and(|m| !m.is_empty()));
                        st.observe_setup(&setup);
                        if st.main.is_none() {
                            st.main = result.get("sessionId").and_then(Value::as_str).map(str::to_string);
                        }
                    }
                }
            }
        }
        (updates, states, permissions)
    }

    fn assert_only_known_kinds(updates: &[Value]) {
        assert!(!updates.is_empty());
        for update in updates {
            let kind = update["sessionUpdate"].as_str().unwrap_or("?");
            assert!(KNOWN_KINDS.contains(&kind), "{kind} is not handled by chatModel.ts: {update}");
            let text = update.to_string();
            for v2_only in ["\"changes\"", "\"patch\"", "\"configId\"", "\"groupId\"", "\"capabilities\"", "\"terminalId\""] {
                assert!(!text.contains(v2_only), "v2-only field {v2_only} leaked: {text}");
            }
        }
    }

    fn stop_reasons(states: &[Out]) -> Vec<Option<String>> {
        states.iter().filter_map(|s| if let Out::Idle { stop_reason, .. } = s { Some(stop_reason.clone()) } else { None }).collect()
    }

    #[test]
    fn replays_the_claude_fixture_into_known_kinds_only() {
        let (updates, states, permissions) = replay(CLAUDE_FIXTURE);
        assert_only_known_kinds(&updates);
        assert_eq!(permissions, 1);
        let kinds: HashSet<&str> = updates.iter().map(|u| u["sessionUpdate"].as_str().unwrap()).collect();
        for kind in ["tool_call", "tool_call_update", "plan", "agent_message_chunk", "user_message_chunk", "subagent_update", "usage_update"] {
            assert!(kinds.contains(kind), "no {kind} in the output");
        }
        // The Edit became a v1 diff, the Bash output was folded into its call.
        assert!(updates.iter().any(|u| u["content"][0]["type"] == "diff" && u["content"][0]["oldText"] == "// foo\nconst a = 1;\nexport {};" && u["content"][0]["newText"] == "// foo\nconst a = 2;\nexport {};"));
        assert!(updates.iter().any(|u| u["toolCallId"] == "toolu_bash" && u["content"][0]["content"]["text"] == "total 0\nfoo.ts\n" && u["status"] == "completed"));
        // Exactly one end_turn per turn and the cancel, the error and the repeat idles are told apart.
        let reasons = stop_reasons(&states);
        assert!(reasons.contains(&Some("end_turn".into())) && reasons.contains(&Some("cancelled".into())) && reasons.contains(&Some("error".into())));
        assert!(reasons.contains(&None), "the snapshot idle has no stop reason");
        assert!(states.iter().any(|s| matches!(s, Out::Idle { background: Some(b), .. } if b.iter().any(|i| i["type"] == "subagent"))));
        assert!(states.iter().any(|s| matches!(s, Out::Idle { error: Some(e), .. } if is_limit_error(e))));
        assert!(states.iter().any(|s| matches!(s, Out::RequiresAction)));
        // The child's own state_update never became a turn signal: running only comes from the main session.
        let running = states.iter().filter(|s| matches!(s, Out::Running)).count();
        assert_eq!(running, 7);
        // Replayed history: the user's message is back as a chunk, once.
        assert_eq!(updates.iter().filter(|u| u["sessionUpdate"] == "user_message_chunk").count(), 2);
    }

    /// What the chat shows of a fixture: every update translated, then routed like `Chat::handle_update` does
    /// (`route_child_update`). `(session, update)`.
    fn routed(fixture: &str) -> Vec<(String, Value)> {
        let mut st = V2State::default();
        let mut children = std::collections::HashMap::new();
        let mut shown = Vec::new();
        for line in fixture.lines().filter(|l| !l.trim().is_empty()) {
            let msg: Value = serde_json::from_str(line).unwrap();
            if msg.get("_dir").is_some() || msg.get("_comment").is_some() {
                continue;
            }
            if msg.get("method").and_then(Value::as_str) == Some("session/update") {
                let params = &msg["params"];
                let sid = params["sessionId"].as_str().unwrap();
                for out in translate(&mut st, sid, &params["update"]) {
                    if let Out::Update(mut update) = out {
                        if crate::chat::state::route_child_update(&mut children, params, &mut update) {
                            shown.push((sid.to_string(), update));
                        }
                    }
                }
            } else if st.main.is_none() && msg.pointer("/result/configOptions").is_some() {
                st.main = msg.pointer("/result/sessionId").and_then(Value::as_str).map(str::to_string);
            }
        }
        shown
    }

    #[test]
    fn a_claude_subagent_nests_under_its_launch_and_never_moves_the_chat() {
        let shown = routed(CLAUDE_FIXTURE);
        // Nothing of the child's session chatter reaches the chat.
        for (session, update) in &shown {
            let kind = update["sessionUpdate"].as_str().unwrap();
            if session == "sess-child" {
                assert!(!["config_option_update", "current_mode_update", "available_commands_update", "usage_update", "plan", "session_message"].contains(&kind), "child {kind} leaked");
            }
        }
        // The child's tool call and text stay, under the launch id.
        let call = shown.iter().find(|(_, u)| u["toolCallId"] == "toolu_child_ls").expect("child tool call");
        assert_eq!(call.1["_meta"]["claudeCode"]["parentToolUseId"], "toolu_task");
        let text = shown.iter().find(|(s, u)| s == "sess-child" && u["sessionUpdate"] == "agent_message_chunk").expect("child text");
        assert_eq!(text.1["_meta"]["claudeCode"]["parentToolUseId"], "toolu_task");
        // The model of the main chat never changed to the child's.
        assert!(!shown.iter().any(|(_, u)| u.to_string().contains("haiku")));
        // The parent's announcement, launch message, end state and reply do pass.
        for want in ["subagent_update", "session_message"] {
            assert!(shown.iter().any(|(s, u)| s == "sess-1" && u["sessionUpdate"] == want));
        }
        assert!(shown.iter().any(|(_, u)| u["sessionUpdate"] == "subagent_update" && u["state"]["state"] == "idle"));
    }

    #[test]
    fn a_codex_standard_subagent_is_announced_nested_and_silent_about_its_config() {
        let shown = routed(CODEX_FIXTURE);
        for (session, update) in &shown {
            let kind = update["sessionUpdate"].as_str().unwrap();
            if session == "thr-kid2" {
                assert!(!["config_option_update", "current_mode_update", "available_commands_update", "usage_update", "plan", "session_message"].contains(&kind), "child {kind} leaked");
            }
        }
        assert!(!shown.iter().any(|(_, u)| u.to_string().contains("gpt-5.4") || u.to_string().contains("kid-only") || u.to_string().contains("kid step")));
        // Launch: announce, then the message naming the launch id; the child's own work nests under it.
        let at = |kind: &str| shown.iter().position(|(s, u)| s == "thr-1" && u["sessionUpdate"] == kind && u["sessionId"].as_str().is_none_or(|c| c == "thr-kid2")).unwrap();
        assert!(at("subagent_update") < at("session_message"));
        let call = shown.iter().find(|(_, u)| u["toolCallId"] == "kid_exec").expect("child tool call");
        assert_eq!(call.1["_meta"]["claudeCode"]["parentToolUseId"], "call_spawn");
        // Its end comes through the parent's subagent_update; the child's own state_update never became a turn signal.
        assert!(shown.iter().any(|(s, u)| s == "thr-1" && u["sessionUpdate"] == "subagent_update" && u["sessionId"] == "thr-kid2" && u["state"]["state"] == "idle"));
    }

    #[test]
    fn replays_the_codex_fixture_into_known_kinds_only() {
        let (updates, states, permissions) = replay(CODEX_FIXTURE);
        assert_only_known_kinds(&updates);
        assert_eq!(permissions, 1);
        assert!(updates.iter().any(|u| u["toolCallId"] == "call_exec" && u["status"] == "failed" && u["rawOutput"]["exitCode"] == 1
            && u["content"][0]["content"]["text"].as_str().is_some_and(|t| t.contains("FAIL 1 test"))));
        assert!(updates.iter().any(|u| u["content"][0]["type"] == "diff" && u["content"][0]["path"] == "/work/app/src/lib.rs"));
        assert!(updates.iter().any(|u| u["sessionUpdate"] == "plan" && u["entries"].as_array().is_some_and(|e| e.len() == 2)));
        // Codex's `_subagent_update` / `_async_task_*` are dropped.
        assert!(!updates.iter().any(|u| u.to_string().contains("_subagent")));
        let reasons = stop_reasons(&states);
        assert!(reasons.contains(&Some("end_turn".into())) && reasons.contains(&Some("cancelled".into())));
        assert!(states.iter().any(|s| matches!(s, Out::Idle { error: Some(e), .. } if is_limit_error(e))));
        // An agent-started turn: running with no prompt before it, then its own idle.
        assert!(states.iter().filter(|s| matches!(s, Out::Running)).count() >= 2);
    }
}
