//! A running agent: the `Chat` and its reader/writer threads.

use super::*;

/// Whether `session/update` params name the session `stale` (one whose load
/// failed and was replaced). Updates without a `sessionId` are kept.
pub(super) fn is_stale_update(params: &Value, stale: Option<&str>) -> bool {
    stale.is_some_and(|stale| params.get("sessionId").and_then(Value::as_str) == Some(stale))
}

/// Most of an agent's answer kept for a delegated task: it goes back into another model's context.
pub(super) const MAX_ANSWER_BYTES: usize = 200_000;

/// Keeps `answer` as the text of the agent's messages in the current turn: a
/// prompt starts it over, thoughts and a native subagent's text are left out.
pub(super) fn accumulate_answer(answer: &mut String, body: &ChatBody) {
    match body {
        ChatBody::User { .. } => answer.clear(),
        ChatBody::Update { update } => {
            if let Some(("agent_message_chunk", _, text)) = text_chunk(update) {
                let from_subagent = update.pointer("/_meta/claudeCode/parentToolUseId").is_some_and(|id| !id.is_null());
                if !from_subagent && answer.len() < MAX_ANSWER_BYTES {
                    let room = MAX_ANSWER_BYTES - answer.len();
                    let mut end = text.len().min(room);
                    while !text.is_char_boundary(end) { end -= 1; }
                    answer.push_str(&text[..end]);
                }
            }
        }
        _ => {}
    }
}

/// Env var tagging the processes of a WSL chat's agent (carried in by WSLENV).
pub(super) const WSL_TAG_ENV: &str = "FLOWCODE_CHAT_TAG";

/// Everything about one running agent; shared by the commands and the
/// session's reader thread.
pub(super) struct Chat {
    pub(super) id: String,
    pub(super) app: AppHandle,
    /// Label of the window showing this chat - the only one events go to.
    pub(super) owner: String,
    pub(super) agent: String,
    pub(super) cwd: String,
    /// The agent runs inside WSL: it sees Linux paths, so attachments are linked as such.
    pub(super) wsl: bool,
    /// The WSL distro it runs in (`None` for a Windows chat, or when even the default one is unknown).
    pub(super) wsl_distro: Option<String>,
    pub(super) profile: Option<String>,
    /// The terminal shell the chat was started for (`wsl`, `wsl:<distro>`...): a delegated child runs in the same one.
    pub(super) shell: Option<String>,
    /// What the agent may do through Flowcode's MCP server (`chat_start`'s `tools`); a child inherits its parent's.
    pub(super) tools: ToolsConfig,
    /// The chat's token for that server, valid while the chat lives; `None` when it gets no tool.
    pub(super) token: Option<String>,
    /// Set on a chat that carries out a delegated task: who asked, and what for.
    pub(super) link: Option<TaskLink>,
    /// The text of the agent's messages in the current turn - a delegated task's answer (kept for children only).
    pub(super) answer: Mutex<String>,
    pub(super) final_answer: Mutex<String>,
    pub(super) child: Mutex<Child>,
    /// The agent's own job (Windows): emptied when the chat is reaped or
    /// killed, so what the agent started dies even if the agent exited first.
    pub(super) job: Mutex<Option<crate::process_job::TreeJob>>,
    pub(super) wsl_group: AtomicU32,
    pub(super) wsl_group_seen: AtomicBool,
    /// Value of `WSL_TAG_ENV` on every process of a WSL chat's agent, to sweep
    /// what the group kill misses.
    pub(super) wsl_tag: Option<String>,
    pub(super) writer: Mutex<ChildStdin>,
    /// Replies the reader thread owes the agent, written by the chat's own
    /// writer thread (`write_replies`): the reader must never block on the
    /// agent's stdin - an agent busy writing to a full stdout isn't reading
    /// it, and nobody would read that stdout. Bounded, unlike a thread per
    /// reply: an agent flooding requests gets replies dropped, not threads.
    pub(super) replies: mpsc::SyncSender<Value>,
    pub(super) next_id: AtomicU64,
    pub(super) pending: Mutex<HashMap<u64, Pending>>,
    /// Permission requests the agent is waiting on: the JSON text of the
    /// request id (a usable map key) -> the id itself.
    pub(super) permissions: Mutex<HashMap<String, Value>>,
    /// Form questions (`elicitation/create`) the agent is waiting on, keyed
    /// like `permissions`. They count as open permissions for the status.
    pub(super) asks: Mutex<HashMap<String, Value>>,
    pub(super) log: Mutex<Log>,
    /// Every event, as `emit` logs it, for the phones following this chat.
    pub(super) feed: broadcast::Sender<ChatEvent>,
    pub(super) status: Mutex<ChatStatus>,
    /// When `status` last changed (ms since the epoch), for the phones' list order.
    pub(super) status_at: AtomicU64,
    pub(super) stderr: Mutex<Vec<u8>>,
    pub(super) stderr_done: AtomicBool,
    /// The agent's stdout ended; set under the `pending` lock, so nothing is
    /// registered after the pending requests were failed.
    pub(super) exited: AtomicBool,
    /// The chat was closed on purpose: nobody is left to tell.
    pub(super) closed: AtomicBool,
    pub(super) session_id: OnceLock<String>,
    /// The `modes` the agent announced when the session started.
    pub(super) modes: OnceLock<Value>,
    pub(super) current_mode: Mutex<Option<String>>,
    /// The models the agent offers; unlike the modes they change after the
    /// start (`chat_set_model`, a `config_option_update`), hence the mutex.
    pub(super) models: Mutex<Option<ChatModels>>,
    /// The thinking levels the agent offers; they change like the models, and
    /// with them (a model switch brings its own levels).
    pub(super) thought: Mutex<Option<ThoughtLevels>>,
    /// A session whose `session/load` failed and was replaced by a new one:
    /// whatever history it still streams (a timed-out load may go on) is
    /// dropped. Set under the log lock, and checked under it (`emit_when`).
    pub(super) stale_session: Mutex<Option<String>>,
    /// Native subagents (`subagent_update`): each child session id, with the launch id (the `session_message` that opens it) once known.
    pub(super) children: Mutex<HashMap<String, Option<String>>>,
    /// OpenCode: `subagent` tool calls not yet matched to a child session, as (session that ran it, tool call id).
    pub(super) launches: Mutex<Vec<(String, String)>>,
    /// Cline: ids of the tool calls already seen (it sends a `tool_call` after the updates of the same call).
    pub(super) cline_tools: Mutex<std::collections::HashSet<String>>,
    /// Cline: the `spawn_agent` calls (sub-agents) seen and the ones still running.
    pub(super) cline_spawns: Mutex<cline::Spawns>,
    /// The agent announced it takes image blocks in a prompt (`promptCapabilities.image`).
    pub(super) prompt_images: AtomicBool,
    /// What the views were told about the chat's goal.
    pub(super) goal: Mutex<goal::GoalTrack>,
    /// The message to send by itself once the usage limit resets.
    pub(super) resume: Mutex<Option<ScheduledResume>>,
    /// Numbers the schedules, so a replaced one's timer gives up.
    pub(super) resume_gen: AtomicU64,
}

/// A prompt Flowcode sends by itself when the plan's usage limit resets
/// (`chat_resume_schedule`), unless the user writes first or cancels it.
#[derive(Clone, Debug)]
pub(super) struct ScheduledResume {
    /// The reset time (ms); it goes out `RESUME_GRACE_MS` later.
    pub(super) at: u64,
    pub(super) text: String,
    pub(super) limit_id: String,
    pub(super) generation: u64,
}

impl Chat {
    /// Logs an event and sends it to the owner window and the phones.
    pub(super) fn emit(&self, body: ChatBody) {
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
    pub(super) fn emit_when(&self, body: ChatBody, allow: impl FnOnce(ChatStatus) -> Result<(), String>) -> Result<(), String> {
        let mut log = lock(&self.log);
        let (before, after) = {
            let mut status = lock(&self.status);
            let before = *status;
            allow(before)?;
            let permissions_pending = !lock(&self.permissions).is_empty() || !lock(&self.asks).is_empty();
            *status = next_status(before, &body, permissions_pending);
            if *status != before {
                self.status_at.store(now_ms(), Ordering::Relaxed);
            }
            (before, *status)
        };
        let live = is_live(before, &body);
        if self.link.is_some() {
            accumulate_answer(&mut lock(&self.answer), &body);
            let mut final_answer = lock(&self.final_answer);
            if matches!(&body, ChatBody::Update { update } if update.get("sessionUpdate").and_then(Value::as_str) == Some("tool_call") && update.pointer("/_meta/claudeCode/parentToolUseId").is_none_or(Value::is_null)) {
                final_answer.clear();
            }
            accumulate_answer(&mut final_answer, &body);
        }
        let event = log.push(body, now_ms());
        let _ = self.feed.send(event.clone());
        if before != ChatStatus::Starting && !self.closed.load(Ordering::Relaxed) {
            let _ = self.app.emit_to(&self.owner, "chat-event", json!({ "chatId": self.id, "event": event }));
        }
        drop(log);
        if after != before {
            self.changed();
        }
        if live {
            self.alert(&event.body);
        }
        // After the log lock is released: this emits on the parent chat, which takes its own.
        if self.link.is_some() {
            delegate::child_event(self, &event.body);
        }
        Ok(())
    }

    /// The handshake is done: the chat goes from starting to idle - only from
    /// starting, since the agent may already have exited and a dead chat must
    /// not look idle.
    pub(super) fn started(&self) {
        let moved = {
            let mut status = lock(&self.status);
            let moved = *status == ChatStatus::Starting;
            if moved {
                *status = ChatStatus::Idle;
                self.status_at.store(now_ms(), Ordering::Relaxed);
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
    pub(super) fn forget_session(&self, session_id: &str) {
        let mut log = lock(&self.log);
        *lock(&self.stale_session) = Some(session_id.to_string());
        log.reset();
        lock(&self.cline_tools).clear();
        *lock(&self.cline_spawns) = cline::Spawns::default();
    }

    /// The new session took the id of the one `forget_session` dropped (an
    /// agent that reuses ids): its updates are this chat's after all.
    pub(super) fn unforget_session(&self, session_id: &str) {
        let mut stale = lock(&self.stale_session);
        if stale.as_deref() == Some(session_id) {
            *stale = None;
        }
    }

    /// Whether a `session/update`'s params belong to a session `forget_session` dropped.
    pub(super) fn is_stale(&self, params: &Value) -> bool {
        is_stale_update(params, lock(&self.stale_session).as_deref())
    }

    /// Tells the remote access server the chat list or a status changed.
    pub(super) fn changed(&self) {
        if let Some(state) = self.app.try_state::<ChatState>() {
            state.changed();
        }
    }

    /// Raises an alert for the events a phone wants to hear about.
    pub(super) fn alert(&self, body: &ChatBody) {
        let kind = match body {
            ChatBody::Permission { tool_call, .. } => {
                AlertKind::Permission { tool: tool_call.get("title").and_then(Value::as_str).unwrap_or_default().to_string() }
            }
            ChatBody::Ask { message, .. } => AlertKind::Permission { tool: message.chars().take(120).collect() },
            ChatBody::TurnEnd { stop_reason } if stop_reason != "cancelled" => AlertKind::Done,
            _ => return,
        };
        let (Some(state), Some(session_id)) = (self.app.try_state::<ChatState>(), self.session_id.get()) else { return };
        let _ = state.alerts.send(ChatAlert { agent: self.agent.clone(), session_id: session_id.clone(), kind });
    }

    pub(super) fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(&lock(&self.stderr)).trim().to_string()
    }

    /// `base`, followed by what the agent last wrote to stderr.
    pub(super) fn with_tail(&self, base: &str) -> String {
        let tail = self.stderr_tail();
        if tail.is_empty() { base.to_string() } else { format!("{base}: {tail}") }
    }

    /// Writes one message line to the agent's stdin.
    pub(super) fn send(&self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_vec(message).map_err(|e| e.to_string())?;
        line.push(b'\n');
        let mut writer = lock(&self.writer);
        writer
            .write_all(&line)
            .and_then(|()| writer.flush())
            .map_err(|e| self.with_tail(&format!("the agent is not accepting input ({e})")))
    }

    pub(super) fn register(&self, pending: Pending) -> Result<u64, String> {
        let mut map = lock(&self.pending);
        if self.exited.load(Ordering::Acquire) {
            return Err(self.with_tail("the agent has exited"));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        map.insert(id, pending);
        Ok(id)
    }

    pub(super) fn send_request(&self, id: u64, method: &str, params: Value) -> Result<(), String> {
        let sent = self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        if sent.is_err() {
            lock(&self.pending).remove(&id);
        }
        sent
    }

    /// Sends a request and waits for its answer.
    pub(super) fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
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

    pub(super) fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
    }

    pub(super) fn session_id(&self) -> Result<&str, String> {
        self.session_id.get().map(String::as_str).ok_or_else(|| "chat not started".to_string())
    }

    /// Switches the agent to `model_id` (one it offers) through whichever API
    /// announced the models. Allowed mid-turn: ACP applies it from the next
    /// prompt. Every view hears of it through a `_flowcode/model` event, the
    /// phones' chat list through `changed`.
    pub(super) fn set_model(&self, model_id: &str) -> Result<(), String> {
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
        self.update_thought(|before| thought_after_set(before, &result, None));
        Ok(())
    }

    /// Switches the agent to the thinking level `value` (one it offers), with
    /// `session/set_config_option`. Every view hears of it through a
    /// `_flowcode/thought` event, as for `set_model`.
    pub(super) fn set_thought(&self, value: &str) -> Result<(), String> {
        let session_id = self.session_id()?.to_string();
        let config_id = {
            let thought = lock(&self.thought);
            let thought = thought.as_ref().ok_or_else(|| "the agent offers no thinking level to choose".to_string())?;
            if !thought.offers(value) {
                return Err(format!("unknown thinking level: {value}"));
            }
            thought.config_id.clone()
        };
        let result = self.request(
            "session/set_config_option",
            json!({ "sessionId": session_id, "configId": config_id, "value": value }),
            MODE_TIMEOUT,
        )?;
        self.update_thought(|before| thought_after_set(before, &result, Some(value)));
        Ok(())
    }

    /// Stores what `next` makes of the thinking levels, if they changed, and
    /// tells the views. `next` runs under the `thought` lock.
    pub(super) fn update_thought(&self, next: impl FnOnce(Option<&ThoughtLevels>) -> Option<Option<ThoughtLevels>>) {
        let next = {
            let mut thought = lock(&self.thought);
            let Some(next) = next(thought.as_ref()) else { return };
            *thought = next.clone();
            next
        };
        self.thought_changed(next.as_ref());
    }

    /// The agent pushed new config options: stores the model and thinking
    /// parts, if they moved.
    pub(super) fn config_options_changed(&self, options: &Value) {
        if let Some(mode) = options.as_array().and_then(|options| options.iter().find(|option| option.get("category").and_then(Value::as_str) == Some("mode"))) {
            *lock(&self.current_mode) = mode.get("currentValue").and_then(Value::as_str).map(str::to_string);
        }
        let next = {
            let mut models = lock(&self.models);
            let next = models_after_config_update(models.as_ref(), options);
            if let Some(next) = &next {
                *models = next.clone();
            }
            next
        };
        if let Some(next) = next {
            self.models_changed(next.as_ref());
        }
        self.update_thought(|before| thought_after_config_update(before, options));
    }

    /// Tells the views (an event, so a replay knows too) and the phones' list.
    /// Called without the `models` lock: `emit` takes the log lock.
    pub(super) fn models_changed(&self, models: Option<&ChatModels>) {
        let params = models.map_or_else(|| json!({ "currentModelId": null, "availableModels": [] }), ChatModels::to_json);
        self.emit(ChatBody::Ext { method: MODEL_EXT_METHOD.to_string(), params });
        self.changed();
    }

    /// As `models_changed`, for the thinking levels.
    pub(super) fn thought_changed(&self, thought: Option<&ThoughtLevels>) {
        let params = thought.map_or_else(|| json!({ "currentId": null, "available": [] }), ThoughtLevels::to_json);
        self.emit(ChatBody::Ext { method: THOUGHT_EXT_METHOD.to_string(), params });
        self.changed();
    }

    /// Tells the views the goal (`None`: there is none).
    pub(super) fn emit_goal(&self, goal: Option<&goal::Goal>) {
        let params = json!({ "goal": goal, "actions": goal::actions(&self.agent) });
        self.emit(ChatBody::Ext { method: GOAL_EXT_METHOD.to_string(), params });
    }

    /// Reads the goal where the agent keeps it and tells the views if it
    /// moved. Does file IO: call it with no lock held.
    pub(super) fn refresh_goal(&self) {
        self.refresh_goal_with(goal::GoalTrack::apply);
    }

    /// The first `refresh_goal` of a chat: a goal that already ended stays quiet (`GoalTrack::prime`).
    pub(super) fn refresh_goal_first(&self) {
        self.refresh_goal_with(goal::GoalTrack::prime);
    }

    pub(super) fn refresh_goal_with(&self, take: fn(&mut goal::GoalTrack, Option<Option<goal::Goal>>) -> Option<Option<goal::Goal>>) {
        if !goal::supported(&self.agent) || self.closed.load(Ordering::Relaxed) {
            return;
        }
        let Some(session_id) = self.session_id.get() else { return };
        let distro = if self.wsl { self.wsl_distro.as_deref() } else { None };
        let read = goal::read(&self.app, &self.agent, session_id, self.profile.as_deref(), distro);
        let next = take(&mut lock(&self.goal), read);
        if let Some(next) = next {
            self.emit_goal(next.as_ref());
        }
    }

    /// Shows what the user just asked for, before the agent's files say so.
    pub(super) fn goal_asked(&self, asked: &goal::PromptGoal) {
        let shown = lock(&self.goal).optimistic(asked, now_ms());
        if let Some(shown) = shown {
            self.emit_goal(shown.as_ref());
        }
    }

    /// A `refresh_goal` once the agent had time to write.
    pub(super) fn refresh_goal_soon(self: &Arc<Self>) {
        if !goal::supported(&self.agent) {
            return;
        }
        let chat = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(GOAL_SETTLE);
            if let Some(chat) = chat.upgrade() {
                chat.refresh_goal();
            }
        });
    }

    /// Pauses, resumes or clears the goal (`_session/goal`; works mid-turn).
    pub(super) fn goal_action(self: &Arc<Self>, action: &str) -> Result<(), String> {
        if !goal::actions(&self.agent).contains(&action) {
            return Err(format!("unsupported goal action: {action}"));
        }
        let session_id = self.session_id()?.to_string();
        self.request("_session/goal", json!({ "sessionId": session_id, "action": action }), MODE_TIMEOUT)?;
        self.goal_asked(&match action {
            "pause" => goal::PromptGoal::Pause,
            "resume" => goal::PromptGoal::Resume,
            _ => goal::PromptGoal::Clear,
        });
        self.refresh_goal_soon();
        Ok(())
    }

    pub(super) fn handle(self: &Arc<Self>, incoming: Incoming) {
        match incoming {
            Incoming::Response { id, result } => {
                let Some(pending) = lock(&self.pending).remove(&id) else { return };
                let limit = result.as_ref().err().is_some_and(is_limit_error);
                let gone = result.as_ref().err().is_some_and(is_session_gone);
                let result = result.map_err(|e| error_text(&e));
                match pending {
                    Pending::Waiter(tx) => {
                        let _ = tx.send(result);
                    }
                    Pending::Prompt => {
                        // The turn is over (ended, failed or cancelled): no spawn call is running any more.
                        if self.agent == "cline" {
                            lock(&self.cline_spawns).clear_active();
                        }
                        match result {
                            Ok(value) => {
                                let stop_reason = value.get("stopReason").and_then(Value::as_str).unwrap_or("end_turn");
                                self.emit(ChatBody::TurnEnd { stop_reason: stop_reason.to_string() });
                                self.refresh_goal_soon();
                            }
                            Err(message) => {
                                self.prompt_failed(message, limit);
                                if gone {
                                    self.end_dead_session();
                                }
                            }
                        }
                    }
                }
            }
            Incoming::Request { id, method, params } => {
                // A reply that could not be queued falls through to the prompt.
                let auto_allowed = (method == "session/request_permission")
                    .then(|| crate::chat_mcp::auto_allow(&self.tools, &self.cwd, &params))
                    .flatten()
                    .is_some_and(|option_id| {
                        let reply = json!({ "jsonrpc": "2.0", "id": id, "result": { "outcome": { "outcome": "selected", "optionId": option_id } } });
                        self.replies.try_send(reply).is_ok()
                    });
                if auto_allowed {
                    return;
                }
                if method == "session/request_permission" {
                    lock(&self.permissions).insert(id.to_string(), id.clone());
                    let mut tool_call = params.get("toolCall").cloned().unwrap_or(Value::Null);
                    crate::chat_images::stash_images(&mut tool_call);
                    self.emit(ChatBody::Permission {
                        request_id: id,
                        tool_call,
                        options: params.get("options").cloned().unwrap_or_else(|| json!([])),
                    });
                } else if method == "elicitation/create" && params.get("mode").and_then(Value::as_str).unwrap_or("form") == "form" {
                    // A missing mode means form.
                    lock(&self.asks).insert(id.to_string(), id.clone());
                    self.emit(ChatBody::Ask {
                        request_id: id,
                        message: params.get("message").and_then(Value::as_str).unwrap_or_default().to_string(),
                        schema: params.get("requestedSchema").cloned().unwrap_or(Value::Null),
                        tool_call_id: params.get("toolCallId").and_then(Value::as_str).map(str::to_string),
                    });
                } else if method == "elicitation/create" {
                    // Only the form mode was advertised; decline anything else.
                    let reply = json!({ "jsonrpc": "2.0", "id": id, "result": { "action": "decline" } });
                    let _ = self.replies.try_send(reply);
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
                        if update.get("sessionUpdate").and_then(Value::as_str) == Some("current_mode_update") && !self.is_stale(&params) {
                            *lock(&self.current_mode) = update.get("currentModeId").and_then(Value::as_str).map(str::to_string);
                        }
                        log_native_subagent(&self.id.to_string(), &params, update);
                        if self.agent == "opencode" {
                            let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
                            note_opencode_launch(&mut lock(&self.launches), &mut lock(&self.children), session, update);
                        }
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
                        // Pictures go to disk before the log lock is taken.
                        let mut update = update.clone();
                        if self.agent == "cline" {
                            cline::normalize_cline_tool(&mut update, &mut lock(&self.cline_tools));
                            cline::mark_spawns(&mut update, &mut lock(&self.cline_spawns));
                        }
                        if !route_child_update(&mut lock(&self.children), &params, &mut update) {
                            return;
                        }
                        crate::chat_images::stash_images(&mut update);
                        let _ = self.emit_when(ChatBody::Update { update }, stale);
                    }
                } else if method.trim_start_matches('_') == OPENCODE_CHILD_UPDATE {
                    // OpenCode (sub-agents): the children's work comes as extension notifications, not `session/update`.
                    let Some((child_params, mut update)) = opencode_child_update(&mut lock(&self.launches), &mut lock(&self.children), &params) else { return };
                    let stale = |_| if self.is_stale(&params) { Err(String::new()) } else { Ok(()) };
                    if !route_child_update(&mut lock(&self.children), &child_params, &mut update) {
                        return;
                    }
                    crate::chat_images::stash_images(&mut update);
                    let _ = self.emit_when(ChatBody::Update { update }, stale);
                } else if method == "$/cancel_request" {
                    if let Some(request_id) = params.get("requestId") {
                        self.withdraw_request(request_id);
                    }
                } else if method.starts_with('_') {
                    self.emit(ChatBody::Ext { method, params });
                }
            }
        }
    }

    /// The agent withdrew a request it sent (`$/cancel_request`: codex-acp's
    /// async questions when their turn ends): close its card, no reply owed.
    fn withdraw_request(&self, request_id: &Value) {
        let key = request_id.to_string();
        let permission = lock(&self.permissions).remove(&key);
        if let Some(request_id) = permission {
            self.emit(ChatBody::PermissionResolved { request_id, option_id: None });
            return;
        }
        let ask = lock(&self.asks).remove(&key);
        if let Some(request_id) = ask {
            self.emit(ChatBody::AskResolved { request_id, action: "cancel".to_string(), content: None });
        }
    }

    /// Answers a pending permission request: `Some(option)` selects it, `None`
    /// cancels. Errs if there is no such request (any more).
    pub(super) fn resolve_permission(&self, request_id: &Value, option_id: Option<&str>) -> Result<(), String> {
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

    /// Answers a pending form question: `action` is "accept" (with the
    /// form's `content`), "decline" or "cancel". Errs if there is no such
    /// question (any more).
    pub(super) fn resolve_ask(&self, request_id: &Value, action: &str, content: Option<Value>) -> Result<(), String> {
        if !matches!(action, "accept" | "decline" | "cancel") {
            return Err(format!("invalid ask action: {action}"));
        }
        let id = lock(&self.asks)
            .remove(&request_id.to_string())
            .ok_or_else(|| "unknown ask request".to_string())?;
        let content = if action == "accept" { content } else { None };
        let mut result = json!({ "action": action });
        if let Some(content) = &content {
            result["content"] = content.clone();
        }
        let sent = self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }));
        self.emit(ChatBody::AskResolved { request_id: id, action: action.to_string(), content });
        sent
    }

    pub(super) fn cancel_permissions(&self) {
        let ids: Vec<Value> = lock(&self.permissions).values().cloned().collect();
        for id in ids {
            let _ = self.resolve_permission(&id, None);
        }
        let ids: Vec<Value> = lock(&self.asks).values().cloned().collect();
        for id in ids {
            let _ = self.resolve_ask(&id, "cancel", None);
        }
    }

    pub(super) fn prompt_failed(&self, message: String, limit: bool) {
        self.emit(ChatBody::Error { message: message.clone(), limit });
        delegate::prompt_failed(self, &message);
    }

    /// The agent's stdout ended: collect its exit code, fail everything still
    /// waiting on it and tell the window.
    pub(super) fn finish(&self) {
        let code = self.reap();
        // Linux processes in the distro survive the adapter's exit (and the
        // Windows job doesn't reach them): sweep them now it is gone.
        self.kill_wsl_group();
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
        let asks = std::mem::take(&mut *lock(&self.asks));
        for request_id in asks.into_values() {
            self.emit(ChatBody::AskResolved { request_id, action: "cancel".to_string(), content: None });
        }
        for pending in drained.into_values() {
            match pending {
                Pending::Waiter(tx) => {
                    let _ = tx.send(Err(message.clone()));
                }
                Pending::Prompt => self.emit(ChatBody::Error { message: message.clone(), limit: false }),
            }
        }
        self.emit(ChatBody::Exit { code });
        self.release_token();
        // Tasks it delegated have no one left to report to.
        if let Some(state) = self.app.try_state::<ChatState>() {
            state.close_children(self);
        }
    }

    /// Waits (briefly) for the process to be gone, killing it if it lingers -
    /// with what it started, as `kill` does: killing only `cmd` (Windows) or
    /// the `npx` shim would leave the real agent running.
    pub(super) fn reap(&self) -> Option<i32> {
        for _ in 0..40 {
            if let Ok(Some(status)) = lock(&self.child).try_wait() {
                return status.code();
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let mut child = lock(&self.child);
        kill_if_running(&mut child);
        let code = child.wait().ok().and_then(|status| status.code());
        // Whatever the agent left running (its own exit doesn't take it along).
        drop(lock(&self.job).take());
        code
    }

    /// The chat can no longer call Flowcode's tools.
    pub(super) fn release_token(&self) {
        if let Some(token) = &self.token {
            crate::chat_mcp::unregister(token);
        }
    }

    /// The `mcpServers` of this chat's session.
    pub(super) fn mcp_servers(&self) -> Value {
        match &self.token {
            Some(token) => crate::chat_mcp::servers(&self.app, &self.tools, self.depth(), token, self.wsl),
            None => json!([]),
        }
    }

    /// 0 for a chat of the user's, 1 for one that carries out a delegated task.
    pub(super) fn depth(&self) -> u8 {
        u8::from(self.link.is_some())
    }

    /// Kills the agent and what it started (an `npx` adapter runs the real
    /// agent as a child of its own). The reader thread reaps it.
    pub(super) fn kill(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.release_token();
        self.kill_wsl_group();
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
        drop(child);
        drop(lock(&self.job).take());
    }

    pub(super) fn announce_resume(&self, state: &str, resume: &ScheduledResume) {
        let params = json!({ "state": state, "at": resume.at, "text": resume.text, "limitId": resume.limit_id });
        self.emit(ChatBody::Ext { method: RESUME_EXT_METHOD.to_string(), params });
    }

    /// Drops the scheduled resume, if any, telling the views `state`.
    pub(super) fn drop_resume(&self, state: &str) {
        let taken = lock(&self.resume).take();
        if let Some(resume) = taken {
            self.announce_resume(state, &resume);
        }
    }

    /// Ends an agent whose session is gone (see `is_session_gone`). Unlike
    /// `kill` the chat isn't closed: the reader thread hears the agent end and
    /// tells the views it exited, so they show the session-ended pond.
    pub(super) fn end_dead_session(&self) {
        self.kill_wsl_group();
        kill_if_running(&mut lock(&self.child));
    }

    pub(super) fn kill_wsl_group(&self) {
        #[cfg(target_os = "windows")]
        if self.wsl {
            let group = self.wsl_group.swap(0, Ordering::AcqRel);
            if group > 1 {
                let mut cmd = Command::new("wsl.exe");
                if let Some(distro) = &self.wsl_distro { cmd.arg("-d").arg(distro); }
                cmd.args(["--exec", "kill", "-KILL", "--", &format!("-{group}")]);
                let _ = crate::system::run_wsl(cmd);
            }
            // Also by tag: the group line may never have been read (killed
            // early, stderr noisy), and children that left the group (setsid)
            // escape the group kill.
            if let Some(tag) = &self.wsl_tag {
                crate::system::kill_wsl_tagged(self.wsl_distro.as_deref(), WSL_TAG_ENV, tag);
            }
        }
    }
}

/// The timer of a scheduled resume: once due (and the chat idle) it sends the
/// message as the user's. Gives up when the chat ends or the schedule was
/// replaced, cancelled or already sent.
pub(super) fn send_resume_when_due(chat: Weak<Chat>, generation: u64) {
    loop {
        std::thread::sleep(RESUME_TICK);
        let Some(current) = chat.upgrade() else { return };
        if current.closed.load(Ordering::Relaxed) || current.exited.load(Ordering::Acquire) {
            return;
        }
        let peeked = lock(&current.resume).clone().filter(|r| r.generation == generation);
        let Some(resume) = peeked else { return };
        if crate::util::now_ms() < resume.at.saturating_add(RESUME_GRACE_MS) {
            continue;
        }
        let (id, app) = (current.id.clone(), current.app.clone());
        drop(current);
        let Some(state) = app.try_state::<ChatState>() else { return };
        // The resume is only consumed (and announced as sent) by the prompt
        // itself, once the chat accepts it.
        match state.prompt_resume(&id, generation, &resume.text) {
            Ok(()) => return,
            // Busy: try again on the next tick. Changed: the user edited the
            // text since it was read; the next tick sends the new one.
            Err(e) if e.starts_with("agent_busy") || e == "resume_changed" => continue,
            Err(e) if e == "resume_gone" || e.starts_with("agent_exited") => return,
            Err(e) => {
                eprintln!("chat {id}: the scheduled resume could not be sent: {e}");
                return;
            }
        }
    }
}

/// The decision of `ChatState::prompt_resume`'s gate, under the status lock:
/// the chat must accept a prompt (`prompt_gate`) and the slot must still hold
/// the resume of `generation` with exactly `text`. On success the resume is
/// taken out of the slot, so it is consumed atomically with the turn starting.
/// Nothing is touched on error.
pub(super) fn take_resume_for_prompt(status: ChatStatus, slot: &mut Option<ScheduledResume>, generation: u64, text: &str) -> Result<ScheduledResume, String> {
    prompt_gate(status)?;
    match slot {
        Some(r) if r.generation == generation => {
            if r.text != text {
                return Err("resume_changed".into());
            }
        }
        _ => return Err("resume_gone".into()),
    }
    slot.take().ok_or_else(|| "resume_gone".to_string())
}

/// `kill_tree` plus `Child::kill`, only while the child hasn't been reaped:
/// once `wait` collected it its pid is free for the OS to hand to an
/// unrelated process, which `taskkill /T` would then kill with its children.
pub(super) fn kill_if_running(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        kill_tree(child.id());
        let _ = child.kill();
    }
}

/// The chat's writer thread: sends the queued replies (see `Chat::replies`)
/// until the chat is gone - its sender dropped with it.
pub(super) fn write_replies(chat: Weak<Chat>, replies: mpsc::Receiver<Value>) {
    while let Ok(reply) = replies.recv() {
        let Some(chat) = chat.upgrade() else { return };
        let _ = chat.send(&reply);
    }
}

/// The chat's goal watcher: while the goal may change (a control is pending,
/// the goal is live) it re-reads it every few seconds; a chat without a goal
/// costs nothing (a goal is only ever set by a prompt, which makes it pending,
/// and turn ends are read anyway). Holds the chat only while looking, so the
/// chat can drop.
pub(super) fn watch_goal(chat: Weak<Chat>) {
    loop {
        std::thread::sleep(GOAL_POLL);
        let Some(chat) = chat.upgrade() else { return };
        if chat.closed.load(Ordering::Relaxed) || chat.exited.load(Ordering::Relaxed) {
            return;
        }
        if lock(&chat.goal).wants_poll() {
            chat.refresh_goal();
        }
    }
}

/// Reads one `\n`-terminated line into `buf` (cleared first), keeping at most
/// `max` bytes of it: the rest of a longer line is read and thrown away.
/// `Ok(None)` at the end of the stream, `Ok(Some(false))` for a cut line.
pub(super) fn read_line_capped(reader: &mut impl BufRead, buf: &mut Vec<u8>, max: usize) -> std::io::Result<Option<bool>> {
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
    let Ok(mut taskkill) = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    // Bounded: it runs under the chat's `child` lock and on teardown threads.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while matches!(taskkill.try_wait(), Ok(None)) {
        if std::time::Instant::now() >= deadline {
            let _ = taskkill.kill();
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let _ = taskkill.wait();
}

/// The agent is spawned as the leader of its own process group (see
/// `spawn_agent`), so the whole group can be signalled.
#[cfg(not(target_os = "windows"))]
pub(crate) fn kill_tree(pid: u32) {
    let killed_group = Command::new("kill")
        .args(["-KILL", "--", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status().is_ok_and(|status| status.success());
    if !killed_group {
        use sysinfo::{Pid, System};
        let sys = System::new_all();
        let mut descendants = vec![Pid::from_u32(pid)];
        let mut index = 0;
        while index < descendants.len() {
            let parent = descendants[index];
            for (id, process) in sys.processes() {
                if process.parent() == Some(parent) && !descendants.contains(id) { descendants.push(*id); }
            }
            index += 1;
        }
        for id in descendants.into_iter().rev() {
            if let Some(process) = sys.process(id) { process.kill(); }
        }
    }
}

pub(super) fn read_stdout(chat: Arc<Chat>, stdout: impl Read) {
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
                chat.emit(ChatBody::Ext { method: "_flowcode/warning".into(), params: json!({ "message": format!("the agent sent a message over {} MiB; it was skipped", MAX_LINE_BYTES >> 20) }) });
            }
        }
    }
    chat.finish();
}

/// Keeps the tail of the agent's stderr. Holds the chat weakly: a grandchild
/// that outlived the agent (and so escaped `kill_tree`) can keep the pipe -
/// and this thread - open indefinitely, and must not keep the chat alive.
pub(super) fn read_stderr(chat: Weak<Chat>, mut stderr: impl Read) {
    let mut buf = [0u8; 2048];
    loop {
        match stderr.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let Some(chat) = chat.upgrade() else { return };
                let mut tail = lock(&chat.stderr);
                push_tail(&mut tail, &buf[..n], STDERR_TAIL);
                if chat.wsl && !chat.wsl_group_seen.load(Ordering::Acquire) {
                    let text = String::from_utf8_lossy(&tail);
                    if let Some(group) = text.split("FLOWCODE_PROCESS_GROUP=").nth(1).and_then(|text| text.split_once('\n')).and_then(|(pid, _)| pid.trim().parse::<u32>().ok()).filter(|pid| *pid > 1) {
                        chat.wsl_group.store(group, Ordering::Release);
                        chat.wsl_group_seen.store(true, Ordering::Release);
                    }
                }
                drop(tail);
                if chat.closed.load(Ordering::Acquire) { chat.kill_wsl_group(); }
            }
        }
    }
    if let Some(chat) = chat.upgrade() {
        chat.stderr_done.store(true, Ordering::Release);
    }
}

/// A chat in `ChatState`; dropping it kills the agent.
pub(super) struct ChatSession {
    pub(super) chat: Arc<Chat>,
}

impl Drop for ChatSession {
    fn drop(&mut self) {
        self.chat.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tasks_answer_is_the_agents_text_of_the_last_turn() {
        let text = |kind: &str, text: &str| ChatBody::Update { update: json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }) };
        let user = ChatBody::User { text: "go".into(), attachments: Vec::new(), images: Vec::new() };
        let mut answer = String::new();
        accumulate_answer(&mut answer, &text("agent_message_chunk", "Hel"));
        accumulate_answer(&mut answer, &text("agent_thought_chunk", "hmm"));
        accumulate_answer(&mut answer, &text("agent_message_chunk", "lo"));
        accumulate_answer(&mut answer, &ChatBody::Update { update: json!({ "sessionUpdate": "tool_call", "title": "Read" }) });
        let nested = ChatBody::Update {
            update: json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "SUB" }, "_meta": { "claudeCode": { "parentToolUseId": "t" } } }),
        };
        accumulate_answer(&mut answer, &nested);
        assert_eq!(answer, "Hello");
        // The next prompt starts over.
        accumulate_answer(&mut answer, &user);
        assert_eq!(answer, "");
        accumulate_answer(&mut answer, &text("agent_message_chunk", &"x".repeat(MAX_ANSWER_BYTES + 5)));
        accumulate_answer(&mut answer, &text("agent_message_chunk", "more"));
        assert_eq!(answer.len(), MAX_ANSWER_BYTES, "the cap also bounds a single oversized chunk");
    }

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

    fn sample_resume(generation: u64, text: &str) -> Option<ScheduledResume> {
        Some(ScheduledResume { at: 1, text: text.to_string(), limit_id: "l".into(), generation })
    }

    #[test]
    fn a_resume_is_taken_only_by_the_prompt_that_starts_the_turn() {
        // Busy: refused, the resume stays.
        let mut slot = sample_resume(1, "go");
        assert!(take_resume_for_prompt(ChatStatus::Busy, &mut slot, 1, "go").unwrap_err().starts_with("agent_busy"));
        assert!(slot.is_some());
        // Another schedule replaced it: gone, untouched.
        assert_eq!(take_resume_for_prompt(ChatStatus::Idle, &mut slot, 2, "go").unwrap_err(), "resume_gone");
        assert!(slot.is_some());
        // Edited between the peek and the acquisition: changed, untouched.
        assert_eq!(take_resume_for_prompt(ChatStatus::Idle, &mut slot, 1, "old text").unwrap_err(), "resume_changed");
        assert_eq!(slot.as_ref().unwrap().text, "go");
        // Nothing scheduled.
        assert_eq!(take_resume_for_prompt(ChatStatus::Idle, &mut None, 1, "go").unwrap_err(), "resume_gone");
        // Accepted: handed out and the slot emptied.
        let taken = take_resume_for_prompt(ChatStatus::Idle, &mut slot, 1, "go").unwrap();
        assert_eq!((taken.generation, taken.text.as_str()), (1, "go"));
        assert!(slot.is_none());
    }

    #[test]
    fn updates_of_a_forgotten_session_are_stale() {
        let params = json!({ "sessionId": "old", "update": {} });
        assert!(is_stale_update(&params, Some("old")));
        assert!(!is_stale_update(&params, Some("new")));
        assert!(!is_stale_update(&params, None));
        assert!(!is_stale_update(&json!({ "update": {} }), Some("old")));
    }
}
