//! What chat agents do through Flowcode's MCP server (`chat_mcp.rs`): open a
//! page in the app, and delegate tasks to other agents.
//!
//! A delegated task is a real chat (a child) that receives only the prompt,
//! runs one turn and hands its last message back. It is an ordinary entry of
//! `ChatState::sessions`, owned by the window of the chat that asked (the
//! parent), so the window and the phones show it like any other chat. The
//! parent's log carries what happens to it (`_flowcode/delegate`, and the
//! child's permission requests and questions as `_flowcode/delegate_request`),
//! the child's log says whose task it is (`_flowcode/task`).
//!
//! Lock order: a child's events are mirrored to the parent only after the
//! child's log lock is released (`Chat::emit_when`), and `Task::state` is a
//! leaf lock - never held while emitting.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use super::{launch_command, start_blocking, Chat, ChatBody, ChatState, Extras};
use crate::chat_mcp::{self, Caller, ToolsConfig};
use crate::util::{lock, now_ms};

const DELEGATE_METHOD: &str = "_flowcode/delegate";
const REQUEST_METHOD: &str = "_flowcode/delegate_request";
const RESOLVED_METHOD: &str = "_flowcode/delegate_request_resolved";
const TASK_METHOD: &str = "_flowcode/task";
const OPEN_METHOD: &str = "_flowcode/open";

/// How long `delegate_task` and `get_task_result` wait for the child at most:
/// under the script's own timeout, which also covers the child's start.
const WAIT_MAX: Duration = Duration::from_secs(45);
/// The child's latest activity reaches the parent at most this often.
const ACTIVITY_EVERY_MS: u64 = 2000;
const TITLE_MAX: usize = 60;
const KEEP_FINISHED: usize = 3;

/// Who a delegated chat works for.
#[derive(Clone, Debug)]
pub(super) struct TaskLink {
    pub task_id: String,
    pub parent_chat_id: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum TaskStatus {
    Running,
    /// The child asks the user a permission or a question.
    WaitingForUser,
    Done,
    Failed,
    Cancelled,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Running => "running",
            TaskStatus::WaitingForUser => "waiting_for_user",
            TaskStatus::Done => "done",
            TaskStatus::Failed => "failed",
            TaskStatus::Cancelled => "cancelled",
        }
    }

    fn is_terminal(self) -> bool {
        matches!(self, TaskStatus::Done | TaskStatus::Failed | TaskStatus::Cancelled)
    }
}

struct TaskState {
    status: TaskStatus,
    result: Option<String>,
    error: Option<String>,
    ended_at: Option<u64>,
    /// Tool calls the child made.
    steps: u64,
    last_activity: Option<String>,
    /// When `last_activity` last reached the parent (ms), for the throttle.
    activity_sent_at: u64,
    /// The child's open permission requests and questions.
    open_requests: HashSet<String>,
    /// Its process was selected for cleanup; the task result remains available.
    retired: bool,
}

impl TaskState {
    fn new() -> Self {
        TaskState {
            status: TaskStatus::Running,
            result: None,
            error: None,
            ended_at: None,
            steps: 0,
            last_activity: None,
            activity_sent_at: 0,
            open_requests: HashSet::new(),
            retired: false,
        }
    }

    fn finish(&mut self, status: TaskStatus, now: u64) {
        self.status = status;
        self.ended_at = Some(now);
    }

    /// Moves the task along with an event of the child's chat; `true` when the
    /// parent must hear of it. `closed`: the child was shut down on purpose;
    /// `answer`: its text of the turn (only read when the turn ended). A task
    /// that has ended stays as it ended.
    fn apply(&mut self, body: &ChatBody, closed: bool, answer: &str, now: u64) -> bool {
        if self.status.is_terminal() {
            return false;
        }
        match body {
            ChatBody::TurnEnd { stop_reason } if stop_reason == "cancelled" => self.finish(TaskStatus::Cancelled, now),
            ChatBody::TurnEnd { .. } => {
                self.result = Some(answer.trim().to_string());
                self.error = None;
                self.finish(TaskStatus::Done, now);
            }
            ChatBody::Error { message } => {
                self.error = Some(message.clone());
                return false;
            }
            ChatBody::Exit { .. } if closed => self.finish(TaskStatus::Cancelled, now),
            ChatBody::Exit { code } => {
                self.error.get_or_insert_with(|| match code {
                    Some(code) => format!("the agent exited with code {code}"),
                    None => "the agent exited".to_string(),
                });
                self.finish(TaskStatus::Failed, now);
            }
            ChatBody::Permission { request_id, .. } | ChatBody::Ask { request_id, .. } => {
                self.open_requests.insert(request_id.to_string());
                return self.move_to(TaskStatus::WaitingForUser);
            }
            ChatBody::PermissionResolved { request_id, .. } | ChatBody::AskResolved { request_id, .. } => {
                self.open_requests.remove(&request_id.to_string());
                return self.open_requests.is_empty() && self.move_to(TaskStatus::Running);
            }
            ChatBody::Update { update } => return self.note_activity(update, now),
            _ => return false,
        }
        true
    }

    fn fail(&mut self, message: &str, now: u64) -> bool {
        if self.status.is_terminal() {
            return false;
        }
        self.error = Some(message.to_string());
        self.finish(TaskStatus::Failed, now);
        true
    }

    fn move_to(&mut self, status: TaskStatus) -> bool {
        let moved = self.status != status;
        self.status = status;
        moved
    }

    /// Counts a tool call and remembers what the child is doing; `true` when
    /// that is news and the throttle lets it through.
    fn note_activity(&mut self, update: &Value, now: u64) -> bool {
        let (activity, is_step) = match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("tool_call") => {
                let title = update.get("title").and_then(Value::as_str).map(str::trim).filter(|t| !t.is_empty());
                (title.unwrap_or("tool").to_string(), true)
            }
            Some("agent_thought_chunk") => ("thinking".to_string(), false),
            _ => return false,
        };
        self.steps += u64::from(is_step);
        let news = is_step || self.last_activity.as_deref() != Some(activity.as_str());
        self.last_activity = Some(activity);
        let due = news && now.saturating_sub(self.activity_sent_at) >= ACTIVITY_EVERY_MS;
        if due {
            self.activity_sent_at = now;
        }
        due
    }
}

/// What a caller is told of a task.
struct Report {
    status: TaskStatus,
    result: Option<String>,
    error: Option<String>,
}

/// One delegated task.
pub(super) struct Task {
    id: String,
    parent_chat_id: String,
    /// Known once the child has started.
    child_chat_id: OnceLock<String>,
    /// The child's agent session id (known once it started), for the history to find the conversation again.
    child_session_id: OnceLock<String>,
    agent: String,
    title: String,
    prompt: String,
    started_at: u64,
    state: Mutex<TaskState>,
    /// Signalled whenever the status moves, for whoever waits for the end.
    changed: Condvar,
}

impl Task {
    fn new(id: String, parent_chat_id: String, agent: String, title: String, prompt: String) -> Self {
        Task {
            id,
            parent_chat_id,
            child_chat_id: OnceLock::new(),
            child_session_id: OnceLock::new(),
            agent,
            title,
            prompt,
            started_at: now_ms(),
            state: Mutex::new(TaskState::new()),
            changed: Condvar::new(),
        }
    }

    fn is_terminal(&self) -> bool {
        lock(&self.state).status.is_terminal()
    }

    /// The `_flowcode/delegate` params.
    pub(super) fn params(&self) -> Value {
        let state = lock(&self.state);
        let mut params = json!({
            "taskId": self.id,
            "childChatId": self.child_chat_id.get().cloned().unwrap_or_default(),
            "agent": self.agent,
            "title": self.title,
            "prompt": self.prompt,
            "status": state.status.as_str(),
            "startedAt": self.started_at,
            "steps": state.steps,
        });
        let optional = [
            ("childSessionId", self.child_session_id.get().cloned().map(Value::from)),
            ("endedAt", state.ended_at.map(Value::from)),
            ("result", state.result.clone().map(Value::from)),
            ("error", state.error.clone().map(Value::from)),
            ("lastActivity", state.last_activity.clone().map(Value::from)),
        ];
        for (key, value) in optional {
            if let Some(value) = value {
                params[key] = value;
            }
        }
        params
    }

    /// Waits until the task ends or `timeout` passes, then says where it stands.
    fn wait_terminal(&self, timeout: Duration) -> Report {
        let state = lock(&self.state);
        let (state, _) = self
            .changed
            .wait_timeout_while(state, timeout, |s| !s.status.is_terminal())
            .unwrap_or_else(|e| e.into_inner());
        Report { status: state.status, result: state.result.clone(), error: state.error.clone() }
    }
}

/// The tasks chats delegated, by id.
#[derive(Default)]
pub(super) struct Delegations {
    tasks: Mutex<HashMap<String, Arc<Task>>>,
}

impl Delegations {
    /// Registers a task, unless its parent already has `max` running: counted
    /// and inserted under one lock, so parallel `delegate_task` calls can't all pass.
    fn reserve(&self, task: &Arc<Task>, max: usize) -> Result<(), String> {
        let max = max.max(1);
        let mut tasks = lock(&self.tasks);
        // Keep recent results queryable without retaining every prompt forever.
        let mut retired: Vec<_> = tasks.values().filter_map(|old| {
            let state = lock(&old.state);
            (old.parent_chat_id == task.parent_chat_id && state.retired).then_some((old.started_at, old.id.clone()))
        }).collect();
        retired.sort();
        let excess = retired.len().saturating_sub(99);
        for (_, id) in retired.into_iter().take(excess) { tasks.remove(&id); }
        let running = tasks.values().filter(|t| t.parent_chat_id == task.parent_chat_id && !t.is_terminal()).count();
        if running >= max {
            return Err(format!("{running} tasks are already running (at most {max} at once): wait for one with get_task_result, or cancel one"));
        }
        tasks.insert(task.id.clone(), Arc::clone(task));
        Ok(())
    }

    fn get(&self, task_id: &str) -> Option<Arc<Task>> {
        lock(&self.tasks).get(task_id).cloned()
    }

    fn remove(&self, task_id: &str) {
        lock(&self.tasks).remove(task_id);
    }

    fn running(&self, parent_id: &str) -> usize {
        lock(&self.tasks).values().filter(|t| t.parent_chat_id == parent_id && !t.is_terminal()).count()
    }

    /// Removes the parent's tasks and settles those interrupted by its shutdown.
    pub(super) fn forget_parent(&self, parent_id: &str) -> Vec<Arc<Task>> {
        let mut cancelled = Vec::new();
        lock(&self.tasks).retain(|_, task| {
            if task.parent_chat_id != parent_id {
                return true;
            }
            let mut state = lock(&task.state);
            if !state.status.is_terminal() {
                state.finish(TaskStatus::Cancelled, now_ms());
                task.changed.notify_all();
                cancelled.push(Arc::clone(task));
            }
            false
        });
        cancelled
    }

    /// Selects each excess finished child once, oldest completion first.
    fn finished_to_close(&self, parent_id: &str) -> Vec<String> {
        let tasks = lock(&self.tasks);
        let mut finished: Vec<_> = tasks.values().filter_map(|task| {
            let state = lock(&task.state);
            (task.parent_chat_id == parent_id && state.status.is_terminal() && !state.retired)
                .then(|| task.child_chat_id.get().map(|child| (state.ended_at.unwrap_or(task.started_at), task.id.clone(), child.clone())))
                .flatten()
        }).collect();
        finished.sort();
        let excess = finished.len().saturating_sub(KEEP_FINISHED);
        finished.into_iter().take(excess).map(|(_, task_id, child)| {
            lock(&tasks[&task_id].state).retired = true;
            child
        }).collect()
    }
}

/// The parent-side events a child's permission request or question, and its
/// answer, turn into.
fn request_event(task: &Task, child_chat_id: &str, body: &ChatBody) -> Option<(&'static str, Value)> {
    let mut params = json!({ "taskId": task.id, "childChatId": child_chat_id });
    match body {
        ChatBody::Permission { request_id, tool_call, options } => {
            params["agent"] = json!(task.agent);
            params["title"] = json!(task.title);
            params["kind"] = json!("permission");
            params["requestId"] = request_id.clone();
            params["toolCall"] = tool_call.clone();
            params["options"] = options.clone();
            Some((REQUEST_METHOD, params))
        }
        ChatBody::Ask { request_id, message, schema, .. } => {
            params["agent"] = json!(task.agent);
            params["title"] = json!(task.title);
            params["kind"] = json!("ask");
            params["requestId"] = request_id.clone();
            params["message"] = json!(message);
            params["schema"] = schema.clone();
            Some((REQUEST_METHOD, params))
        }
        ChatBody::PermissionResolved { request_id, .. } | ChatBody::AskResolved { request_id, .. } => {
            params["requestId"] = request_id.clone();
            Some((RESOLVED_METHOD, params))
        }
        _ => None,
    }
}

fn emit_delegate(parent: &Chat, task: &Task) {
    parent.emit(ChatBody::Ext { method: DELEGATE_METHOD.to_string(), params: task.params() });
}

/// Called by a delegated chat after each event it emits: moves its task along
/// and tells the parent chat. Runs on the child's reader thread, with none of
/// the child's locks held.
pub(super) fn child_event(chat: &Chat, body: &ChatBody) {
    let (Some(link), Some(state)) = (&chat.link, chat.app.try_state::<ChatState>()) else { return };
    let Some(task) = state.delegations.get(&link.task_id) else { return };
    let answer = if matches!(body, ChatBody::TurnEnd { .. }) {
        let final_answer = lock(&chat.final_answer).clone();
        if final_answer.trim().is_empty() { lock(&chat.answer).clone() } else { final_answer }
    } else { String::new() };
    let changed = {
        let mut task_state = lock(&task.state);
        let changed = task_state.apply(body, chat.closed.load(Ordering::Relaxed), &answer, now_ms());
        if changed {
            task.changed.notify_all();
        }
        changed
    };
    let request = request_event(&task, &chat.id, body);
    if !changed && request.is_none() {
        return;
    }
    let Ok(parent) = state.get(&task.parent_chat_id) else { return };
    if changed {
        emit_delegate(&parent, &task);
    }
    if let Some((method, params)) = request {
        parent.emit(ChatBody::Ext { method: method.to_string(), params });
    }
    if changed && task.is_terminal() {
        prune_finished(&chat.app, &state, &task.parent_chat_id);
    }
}

/// A rejected session/prompt is fatal to this task; diagnostic Error events alone are not.
pub(super) fn prompt_failed(chat: &Chat, message: &str) {
    let (Some(link), Some(state)) = (&chat.link, chat.app.try_state::<ChatState>()) else { return };
    let Some(task) = state.delegations.get(&link.task_id) else { return };
    if !lock(&task.state).fail(message, now_ms()) {
        return;
    }
    task.changed.notify_all();
    if let Ok(parent) = state.get(&task.parent_chat_id) {
        emit_delegate(&parent, &task);
    }
    prune_finished(&chat.app, &state, &task.parent_chat_id);
}

/// Remove the session before killing it, with no map or task lock held while emitting or waiting.
fn close_child(state: &ChatState, child_id: &str) {
    let child = lock(&state.sessions).remove(child_id);
    if let Some(child) = child {
        child.chat.emit(ChatBody::Exit { code: None });
        state.changed();
        drop(child);
    }
}

fn prune_finished(app: &AppHandle, state: &ChatState, parent_id: &str) {
    let ids = state.delegations.finished_to_close(parent_id);
    if ids.is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<ChatState>();
        for id in ids {
            close_child(&state, &id);
        }
    });
}

/// Why a chat may not delegate to `agent`. `ready`: its adapter can start.
/// (The cap on running tasks is checked when the task is registered.)
fn check_delegation(cfg: &ToolsConfig, depth: u8, agent: &str, ready: bool) -> Result<(), String> {
    if !cfg.enabled || !cfg.delegate {
        return Err("delegation is turned off in Flowcode's settings".into());
    }
    if depth > 0 {
        return Err("a delegated agent cannot delegate further".into());
    }
    if !cfg.delegate_agents.iter().any(|a| a == agent) {
        return Err(format!("agent `{agent}` is not allowed for delegation; allowed: {}", cfg.delegate_agents.join(", ")));
    }
    if !ready {
        return Err(format!("agent `{agent}` is not available (not installed, or its adapter is not ready)"));
    }
    Ok(())
}

fn agent_ready(app: &AppHandle, agent: &str) -> bool {
    launch_command(agent).is_some() && super::chat_adapter_ready(app.clone(), agent.to_string())
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).ok_or_else(|| format!("`{key}` is required"))
}

/// The task's title: the model's, one line of at most `TITLE_MAX` characters; else the start of the prompt.
fn clean_title(title: Option<&str>, prompt: &str) -> String {
    let line = |text: &str| text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(TITLE_MAX).collect::<String>();
    let title = line(title.unwrap_or(""));
    if title.is_empty() { line(prompt) } else { title }
}

/// What a caller reads of a task.
fn describe(task_id: &str, report: &Report) -> String {
    match report.status {
        TaskStatus::Done => {
            let answer = report.result.as_deref().filter(|r| !r.is_empty()).unwrap_or("(the agent returned no text)");
            format!("Task {task_id} is done. The agent's final answer:\n\n{answer}")
        }
        TaskStatus::Failed => format!("Task {task_id} failed: {}", report.error.as_deref().unwrap_or("unknown error")),
        TaskStatus::Cancelled => format!("Task {task_id} was cancelled."),
        TaskStatus::WaitingForUser => format!(
            "Task {task_id} is waiting: the agent needs the user to answer a question or a permission request in Flowcode. Call get_task_result again to keep waiting."
        ),
        TaskStatus::Running => format!("Task {task_id} is still running. Call get_task_result with this task_id to wait for it."),
    }
}

/// Runs a tool call of a chat; see `chat_mcp::dispatch`. The chat must be live
/// and have been given the tool - the caller's word is not enough.
pub(crate) fn mcp_call(app: &AppHandle, caller: &Caller, tool: &str, args: &Value, deadline_ms: Option<u64>) -> Result<String, String> {
    let state = app.state::<ChatState>();
    let chat = state.get(&caller.chat_id).map_err(|_| "this chat is closed".to_string())?;
    if !chat_mcp::enabled_tools(&chat.tools, caller.depth).contains(&tool) {
        return Err(format!("the tool `{tool}` is turned off for this chat"));
    }
    match tool {
        chat_mcp::OPEN => open_in_browser(&chat, args),
        chat_mcp::LIST_AGENTS => Ok(list_agents(app, &state, &chat)),
        chat_mcp::DELEGATE_TASK => delegate_task(app, &state, &chat, args, deadline_ms),
        chat_mcp::GET_TASK_RESULT => get_task_result(&state, &chat, args),
        chat_mcp::CANCEL_TASK => {
            let task = owned_task(&state, &chat, args)?;
            cancel(app, &task)?;
            Ok(format!("Task {} cancelled.", task.id))
        }
        _ => Err(format!("unknown tool `{tool}`")),
    }
}

/// Opens `target` where the user's settings say, by telling the app (`_flowcode/open`).
fn open_in_browser(chat: &Chat, args: &Value) -> Result<String, String> {
    let mut homes: Vec<String> = crate::fs::user_home().map(|p| p.to_string_lossy().into_owned()).into_iter().collect();
    if chat.wsl {
        homes.extend(homes.clone().iter().filter_map(|home| super::to_wsl_path(home)));
        if let Some(home) = chat.wsl_distro.as_deref().and_then(crate::util::wsl_home) {
            homes.push(home);
        }
    }
    let target = chat_mcp::open_target(string_arg(args, "target")?, &chat.cwd, &homes, chat.wsl.then_some(chat.wsl_distro.as_deref().unwrap_or("")))?;
    chat.emit(ChatBody::Ext { method: OPEN_METHOD.to_string(), params: json!({ "target": target, "cwd": chat.cwd }) });
    Ok("Sent to Flowcode. External links require user confirmation before opening.".to_string())
}

fn list_agents(app: &AppHandle, state: &ChatState, chat: &Chat) -> String {
    let mut lines: Vec<String> = chat
        .tools
        .delegate_agents
        .iter()
        .map(|agent| format!("- {agent}: {}", if agent_ready(app, agent) { "available" } else { "not available (not installed)" }))
        .collect();
    lines.push(format!("Tasks running now: {} (at most {} at once).", state.delegations.running(&chat.id), chat.tools.max_parallel.max(1)));
    lines.join("\n")
}

fn owned_task(state: &ChatState, chat: &Chat, args: &Value) -> Result<Arc<Task>, String> {
    let id = string_arg(args, "task_id")?;
    state.delegations.get(id).filter(|t| t.parent_chat_id == chat.id).ok_or_else(|| format!("unknown task_id `{id}`"))
}

fn get_task_result(state: &ChatState, chat: &Chat, args: &Value) -> Result<String, String> {
    let task = owned_task(state, chat, args)?;
    let wait = args.get("wait_seconds").and_then(Value::as_f64).map_or(WAIT_MAX, |s| Duration::from_secs_f64(s.clamp(0.0, WAIT_MAX.as_secs_f64())));
    Ok(describe(&task.id, &task.wait_terminal(wait)))
}

/// Starts the child chat of `task` and gives it its prompt.
fn start_child(app: &AppHandle, state: &ChatState, parent: &Chat, task: &Task, deadline_ms: Option<u64>) -> Result<(), String> {
    let parent_live = || state.get(&parent.id).is_ok() && !parent.closed.load(Ordering::Relaxed) && !parent.exited.load(Ordering::Acquire);
    let check = || {
        chat_mcp::check_deadline(deadline_ms, now_ms())?;
        if !parent_live() || task.is_terminal() {
            return Err("the chat that asked for this task was closed or the task was cancelled".to_string());
        }
        Ok(())
    };
    check()?;
    // Same CLI: same account; another one never gets the parent's profile.
    let profile = parent.profile.clone().filter(|_| parent.agent == task.agent);
    let link = TaskLink { task_id: task.id.clone(), parent_chat_id: parent.id.clone() };
    let extras = Extras { tools: parent.tools.clone(), link: Some(link) };
    let (child, _) =
        start_blocking(app.clone(), parent.owner.clone(), task.agent.clone(), parent.cwd.clone(), profile, None, false, parent.shell.clone(), extras)?;
    // The parent or the script may have gone away while the adapter started.
    if let Err(error) = check() {
        child.kill();
        return Err(error);
    }
    let inherited = inherited_mode(parent.agent == child.agent, lock(&parent.current_mode).as_deref(), child.modes.get());
    let inherit = inherited.and_then(|mode| {
        if let Some(mode) = mode {
            child.request("session/set_mode", json!({ "sessionId": child.session_id()?, "modeId": mode }), super::MODE_TIMEOUT)?;
            *lock(&child.current_mode) = Some(mode.clone());
            child.emit(ChatBody::Update { update: json!({ "sessionUpdate": "current_mode_update", "currentModeId": mode }) });
        }
        Ok(())
    });
    if let Err(error) = inherit { child.kill(); return Err(error); }
    state.adopt(app, Arc::clone(&child))?;
    if let Err(error) = check() {
        close_child(state, &child.id);
        return Err(error);
    }
    let _ = task.child_chat_id.set(child.id.clone());
    if let Some(session_id) = child.session_id.get() {
        let _ = task.child_session_id.set(session_id.clone());
    }
    let params = json!({
        "taskId": task.id,
        "parentChatId": parent.id,
        "parentAgent": parent.agent,
        "parentTitle": Value::Null,
        "prompt": task.prompt,
    });
    child.emit(ChatBody::Ext { method: TASK_METHOD.to_string(), params });
    emit_delegate(parent, task);
    if let Err(e) = state.prompt(&child.id, task.prompt.clone(), Vec::new()) {
        prompt_failed(&child, &e);
        close_child(state, &child.id);
        return Err(e);
    }
    // Cancellation can race the final check and the prompt write. Never leave that turn running.
    if !parent_live() || lock(&task.state).status == TaskStatus::Cancelled || chat_mcp::check_deadline(deadline_ms, now_ms()).is_err() {
        close_child(state, &child.id);
        return Err("the task was interrupted while starting".into());
    }
    Ok(())
}

fn delegate_task(app: &AppHandle, state: &ChatState, parent: &Arc<Chat>, args: &Value, deadline_ms: Option<u64>) -> Result<String, String> {
    let agent = string_arg(args, "agent")?;
    let prompt = string_arg(args, "prompt")?;
    check_delegation(&parent.tools, parent.depth(), agent, agent_ready(app, agent))?;
    let title = clean_title(args.get("title").and_then(Value::as_str), prompt);
    let task = Arc::new(Task::new(uuid::Uuid::new_v4().to_string(), parent.id.clone(), agent.to_string(), title, prompt.to_string()));
    state.delegations.reserve(&task, parent.tools.max_parallel)?;
    if let Err(e) = start_child(app, state, parent, &task, deadline_ms) {
        if lock(&task.state).fail(&e, now_ms()) {
            task.changed.notify_all();
            emit_delegate(parent, &task);
        }
        state.delegations.remove(&task.id);
        return Err(format!("could not start {agent}: {e}"));
    }
    emit_delegate(parent, &task);
    // Back at once: the agent can start more tasks in parallel, then wait with get_task_result.
    Ok(format!("task_id: {}\nStarted. Wait for the answer with get_task_result.", task.id))
}

/// Ends a task: its status moves to cancelled first, so the turn end the
/// cancellation causes doesn't make it look done.
fn cancel(app: &AppHandle, task: &Task) -> Result<(), String> {
    let state = app.state::<ChatState>();
    {
        let mut task_state = lock(&task.state);
        if task_state.status.is_terminal() {
            return Ok(());
        }
        task_state.finish(TaskStatus::Cancelled, now_ms());
        task.changed.notify_all();
    }
    if let Ok(parent) = state.get(&task.parent_chat_id) {
        emit_delegate(&parent, task);
    }
    let result = match task.child_chat_id.get() {
        Some(child) => {
            let result = state.cancel(child);
            close_child(&state, child);
            result
        }
        None => Ok(()),
    };
    prune_finished(app, &state, &task.parent_chat_id);
    result
}

fn inherited_mode(same_agent: bool, parent: Option<&str>, modes: Option<&Value>) -> Result<Option<String>, String> {
    let available: Vec<&str> = modes.and_then(|m| m.get("availableModes")).and_then(Value::as_array)
        .into_iter().flatten().filter_map(|m| m.get("id").and_then(Value::as_str)).collect();
    if same_agent {
        if let Some(mode) = parent {
            if available.contains(&mode) { return Ok(Some(mode.to_string())); }
        } else if modes.is_none() { return Ok(None); }
    }
    for safe in ["read-only", "readonly", "read_only", "plan", "architect"] {
        if available.contains(&safe) { return Ok(Some(safe.to_string())); }
    }
    Err("delegation refused: the child's permission mode cannot preserve the parent's restrictions".into())
}

/// Stops a delegated task (the "Interrompi" of its chat): cancels the child's turn.
#[tauri::command]
pub async fn delegate_cancel(app: AppHandle, task_id: String) -> Result<(), String> {
    crate::blocking(move || {
        let task = app.state::<ChatState>().delegations.get(&task_id).ok_or_else(|| "unknown task".to_string())?;
        cancel(&app, &task)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn children_preserve_modes_or_fail_closed() {
        let modes = json!({ "availableModes": [{ "id": "default" }, { "id": "plan" }, { "id": "bypassPermissions" }] });
        assert_eq!(inherited_mode(true, Some("plan"), Some(&modes)).unwrap().as_deref(), Some("plan"));
        assert_eq!(inherited_mode(false, Some("default"), Some(&modes)).unwrap().as_deref(), Some("plan"));
        let unsafe_only = json!({ "availableModes": [{ "id": "bypassPermissions" }] });
        assert!(inherited_mode(false, Some("plan"), Some(&unsafe_only)).is_err());
        assert!(inherited_mode(true, Some("read-only"), Some(&unsafe_only)).is_err());
        assert_eq!(inherited_mode(true, None, None).unwrap(), None);
    }

    fn on() -> ToolsConfig {
        ToolsConfig { enabled: true, open: true, open_auto_allow: true, delegate: true, delegate_agents: vec!["codex".into(), "gemini".into()], max_parallel: 2 }
    }

    fn task(id: &str, parent: &str) -> Arc<Task> {
        Arc::new(Task::new(id.into(), parent.into(), "codex".into(), "Check".into(), "do it".into()))
    }

    fn update(body: Value) -> ChatBody {
        ChatBody::Update { update: body }
    }

    #[test]
    fn delegation_rules() {
        let cfg = on();
        assert!(check_delegation(&cfg, 0, "codex", true).is_ok());
        assert!(check_delegation(&ToolsConfig::default(), 0, "codex", true).unwrap_err().contains("turned off"));
        assert!(check_delegation(&ToolsConfig { delegate: false, ..on() }, 0, "codex", true).unwrap_err().contains("turned off"));
        assert!(check_delegation(&ToolsConfig { enabled: false, ..on() }, 0, "codex", true).unwrap_err().contains("turned off"));
        assert!(check_delegation(&cfg, 1, "codex", true).unwrap_err().contains("cannot delegate further"));
        let err = check_delegation(&cfg, 0, "claude", true).unwrap_err();
        assert!(err.contains("not allowed") && err.contains("codex, gemini"), "{err}");
        assert!(check_delegation(&cfg, 0, "codex", false).unwrap_err().contains("not available"));
    }

    #[test]
    fn running_tasks_are_capped_per_parent() {
        let tasks = Delegations::default();
        assert!(tasks.reserve(&task("1", "p"), 2).is_ok());
        assert!(tasks.reserve(&task("2", "p"), 2).is_ok());
        assert!(tasks.reserve(&task("3", "p"), 2).unwrap_err().contains("at most 2"));
        // Another parent has its own budget; a finished task frees one.
        assert!(tasks.reserve(&task("4", "q"), 2).is_ok());
        let first = tasks.get("1").unwrap();
        lock(&first.state).finish(TaskStatus::Done, 1);
        assert!(tasks.reserve(&task("5", "p"), 2).is_ok());
        assert_eq!(tasks.running("p"), 2);
        // Never below one.
        assert!(tasks.reserve(&task("6", "r"), 0).is_ok());
        assert!(tasks.reserve(&task("7", "r"), 0).is_err());
        tasks.forget_parent("p");
        assert!(tasks.get("2").is_none() && tasks.get("4").is_some());
    }

    #[test]
    fn a_turn_end_makes_the_task_done_with_the_answer() {
        let mut state = TaskState::new();
        assert!(state.apply(&ChatBody::TurnEnd { stop_reason: "end_turn".into() }, false, "  the answer \n", 10));
        assert_eq!((state.status, state.result.as_deref(), state.ended_at), (TaskStatus::Done, Some("the answer"), Some(10)));
        // Whatever follows leaves it as it ended.
        assert!(!state.apply(&ChatBody::Exit { code: Some(1) }, false, "", 20));
        assert_eq!(state.status, TaskStatus::Done);
    }

    #[test]
    fn errors_exits_and_cancellations_end_it_otherwise() {
        let mut state = TaskState::new();
        assert!(!state.apply(&ChatBody::Error { message: "boom".into() }, false, "", 1));
        assert_eq!(state.status, TaskStatus::Running);
        assert!(state.apply(&ChatBody::Exit { code: Some(1) }, false, "", 2));
        assert_eq!((state.status, state.error.as_deref()), (TaskStatus::Failed, Some("boom")));
        let mut state = TaskState::new();
        assert!(state.apply(&ChatBody::Exit { code: Some(2) }, false, "", 1));
        assert_eq!((state.status, state.error.as_deref()), (TaskStatus::Failed, Some("the agent exited with code 2")));
        let mut state = TaskState::new();
        assert!(state.apply(&ChatBody::Exit { code: None }, true, "", 1));
        assert_eq!(state.status, TaskStatus::Cancelled);
        let mut state = TaskState::new();
        assert!(state.apply(&ChatBody::TurnEnd { stop_reason: "cancelled".into() }, false, "partial", 1));
        assert_eq!((state.status, state.result), (TaskStatus::Cancelled, None));
    }

    #[test]
    fn diagnostic_errors_do_not_end_a_turn_but_prompt_failure_does() {
        let mut state = TaskState::new();
        assert!(!state.apply(&ChatBody::Error { message: "oversized message skipped".into() }, false, "", 1));
        assert!(state.apply(&ChatBody::TurnEnd { stop_reason: "end_turn".into() }, false, "answer", 2));
        assert_eq!((state.status, state.result.as_deref(), state.error.as_deref()), (TaskStatus::Done, Some("answer"), None));
        let mut state = TaskState::new();
        assert!(state.fail("prompt rejected", 3));
        assert_eq!((state.status, state.error.as_deref(), state.ended_at), (TaskStatus::Failed, Some("prompt rejected"), Some(3)));
        assert!(!state.fail("second failure", 4));
        assert!(!state.apply(&ChatBody::TurnEnd { stop_reason: "end_turn".into() }, false, "late answer", 5));
    }

    #[test]
    fn parent_shutdown_cancels_live_tasks_and_preserves_completed_results() {
        let tasks = Delegations::default();
        let done = task("done", "p");
        lock(&done.state).result = Some("answer".into());
        lock(&done.state).finish(TaskStatus::Done, 1);
        tasks.reserve(&done, 3).unwrap();
        let live = task("live", "p");
        tasks.reserve(&live, 3).unwrap();
        tasks.reserve(&task("other", "q"), 3).unwrap();
        let cancelled = tasks.forget_parent("p");
        assert_eq!(cancelled.len(), 1);
        assert_eq!(cancelled[0].params()["status"], "cancelled");
        assert!(cancelled[0].params()["endedAt"].is_u64());
        assert_eq!(done.params()["result"], "answer");
        assert!(tasks.get("live").is_none() && tasks.get("other").is_some());
        assert!(tasks.forget_parent("p").is_empty());
    }

    #[test]
    fn only_three_finished_children_are_kept_and_cleanup_keeps_the_results() {
        let tasks = Delegations::default();
        for i in 0..5 {
            let task = task(&i.to_string(), "p");
            task.child_chat_id.set(format!("child-{i}")).unwrap();
            lock(&task.state).finish(TaskStatus::Done, i);
            tasks.reserve(&task, 3).unwrap();
        }
        tasks.reserve(&task("running", "p"), 3).unwrap();
        let other = task("other", "q");
        other.child_chat_id.set("other-child".into()).unwrap();
        lock(&other.state).finish(TaskStatus::Done, 0);
        tasks.reserve(&other, 3).unwrap();
        assert_eq!(tasks.finished_to_close("p"), ["child-0", "child-1"]);
        assert!(tasks.finished_to_close("p").is_empty());
        assert!(tasks.finished_to_close("q").is_empty());
        assert_eq!(tasks.get("0").unwrap().params()["status"], "done");
        assert_eq!(tasks.running("p"), 1);
    }

    #[test]
    fn waiting_for_the_user_follows_the_childs_open_requests() {
        let mut state = TaskState::new();
        let ask = |id: i64| ChatBody::Ask { request_id: json!(id), message: "?".into(), schema: Value::Null, tool_call_id: None };
        assert!(state.apply(&ChatBody::Permission { request_id: json!(1), tool_call: Value::Null, options: json!([]) }, false, "", 1));
        assert_eq!(state.status, TaskStatus::WaitingForUser);
        // A second request changes nothing for the parent; one answer is not enough.
        assert!(!state.apply(&ask(2), false, "", 2));
        assert!(!state.apply(&ChatBody::PermissionResolved { request_id: json!(1), option_id: None }, false, "", 3));
        assert_eq!(state.status, TaskStatus::WaitingForUser);
        assert!(state.apply(&ChatBody::AskResolved { request_id: json!(2), action: "accept".into(), content: None }, false, "", 4));
        assert_eq!(state.status, TaskStatus::Running);
    }

    #[test]
    fn activity_counts_steps_and_is_throttled() {
        let mut state = TaskState::new();
        let call = |title: &str| update(json!({ "sessionUpdate": "tool_call", "title": title }));
        assert!(state.apply(&call("Read a.rs"), false, "", 5_000));
        // Within 2 s: counted, not sent.
        assert!(!state.apply(&call("Read b.rs"), false, "", 5_500));
        assert_eq!((state.steps, state.last_activity.as_deref()), (2, Some("Read b.rs")));
        assert!(state.apply(&call("Edit"), false, "", 7_000));
        assert!(state.apply(&update(json!({ "sessionUpdate": "agent_thought_chunk" })), false, "", 9_500));
        assert_eq!(state.last_activity.as_deref(), Some("thinking"));
        // More thinking is no news.
        assert!(!state.apply(&update(json!({ "sessionUpdate": "agent_thought_chunk" })), false, "", 20_000));
        assert!(!state.apply(&update(json!({ "sessionUpdate": "agent_message_chunk" })), false, "", 30_000));
        assert_eq!(state.steps, 3);
    }

    #[test]
    fn waiting_ends_with_the_task() {
        let task = Task::new("t".into(), "p".into(), "codex".into(), "Check".into(), "do it".into());
        let task = Arc::new(task);
        let waiter = {
            let task = Arc::clone(&task);
            std::thread::spawn(move || task.wait_terminal(Duration::from_secs(20)))
        };
        std::thread::sleep(Duration::from_millis(50));
        {
            let mut state = lock(&task.state);
            state.result = Some("ok".into());
            state.finish(TaskStatus::Done, 1);
            task.changed.notify_all();
        }
        let report = waiter.join().unwrap();
        assert_eq!((report.status, report.result.as_deref()), (TaskStatus::Done, Some("ok")));
        // A task still running gives up at the timeout.
        let report = Task::new("u".into(), "p".into(), "codex".into(), "t".into(), "p".into()).wait_terminal(Duration::from_millis(10));
        assert_eq!(report.status, TaskStatus::Running);
    }

    #[test]
    fn the_parent_gets_the_documented_params() {
        let task = task("t1", "p");
        task.child_chat_id.set("c1".into()).unwrap();
        let params = task.params();
        assert!(params.get("childSessionId").is_none());
        task.child_session_id.set("s1".into()).unwrap();
        assert_eq!(task.params()["childSessionId"], "s1");
        assert_eq!(params["taskId"], "t1");
        assert_eq!(params["childChatId"], "c1");
        assert_eq!((params["agent"].as_str(), params["status"].as_str(), params["steps"].as_u64()), (Some("codex"), Some("running"), Some(0)));
        assert!(params.get("endedAt").is_none() && params.get("result").is_none() && params.get("lastActivity").is_none());
        {
            let mut state = lock(&task.state);
            state.result = Some("42".into());
            state.last_activity = Some("thinking".into());
            state.finish(TaskStatus::Done, 99);
        }
        let params = task.params();
        assert_eq!((params["status"].as_str(), params["endedAt"].as_u64(), params["result"].as_str(), params["lastActivity"].as_str()), (Some("done"), Some(99), Some("42"), Some("thinking")));
    }

    #[test]
    fn child_requests_are_mirrored_with_what_answers_them() {
        let task = task("t1", "p");
        let permission = ChatBody::Permission { request_id: json!(7), tool_call: json!({ "title": "Run ls" }), options: json!([{ "optionId": "a" }]) };
        let (method, params) = request_event(&task, "c1", &permission).unwrap();
        assert_eq!(method, "_flowcode/delegate_request");
        assert_eq!(
            params,
            json!({ "taskId": "t1", "childChatId": "c1", "agent": "codex", "title": "Check", "kind": "permission", "requestId": 7, "toolCall": { "title": "Run ls" }, "options": [{ "optionId": "a" }] })
        );
        let ask = ChatBody::Ask { request_id: json!("r"), message: "Which?".into(), schema: json!({ "type": "object" }), tool_call_id: None };
        let (_, params) = request_event(&task, "c1", &ask).unwrap();
        assert_eq!((params["kind"].as_str(), params["message"].as_str(), params["schema"]["type"].as_str()), (Some("ask"), Some("Which?"), Some("object")));
        let (method, params) = request_event(&task, "c1", &ChatBody::AskResolved { request_id: json!("r"), action: "cancel".into(), content: None }).unwrap();
        assert_eq!((method, params), ("_flowcode/delegate_request_resolved", json!({ "taskId": "t1", "childChatId": "c1", "requestId": "r" })));
        assert!(request_event(&task, "c1", &ChatBody::TurnEnd { stop_reason: "end_turn".into() }).is_none());
    }

    #[test]
    fn titles_are_one_short_line() {
        assert_eq!(clean_title(Some("  Review the diff \nignored"), "p"), "Review the diff");
        assert_eq!(clean_title(Some(&"x".repeat(100)), "p").chars().count(), 60);
        assert_eq!(clean_title(None, "\nFind the bug in parser.rs\nmore"), "Find the bug in parser.rs");
        assert_eq!(clean_title(Some("  "), "Do it"), "Do it");
    }

    #[test]
    fn results_read_for_the_model() {
        let report = |status, result: Option<&str>, error: Option<&str>| Report { status, result: result.map(String::from), error: error.map(String::from) };
        assert!(describe("t", &report(TaskStatus::Done, Some("42"), None)).ends_with("\n\n42"));
        assert!(describe("t", &report(TaskStatus::Done, Some(""), None)).contains("returned no text"));
        assert!(describe("t", &report(TaskStatus::Failed, None, Some("boom"))).ends_with("failed: boom"));
        assert!(describe("t", &report(TaskStatus::Cancelled, None, None)).contains("cancelled"));
        assert!(describe("t", &report(TaskStatus::WaitingForUser, None, None)).contains("get_task_result again"));
        assert!(describe("t", &report(TaskStatus::Running, None, None)).contains("still running"));
    }
}
