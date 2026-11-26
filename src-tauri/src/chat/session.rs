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

/// `emit_when`'s gate for an event that only means something inside a turn.
fn in_turn(status: ChatStatus, _autonomous: bool) -> Result<(), String> {
    if matches!(status, ChatStatus::Busy | ChatStatus::Waiting) { Ok(()) } else { Err(String::new()) }
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
    /// Everything written to the agent's stdin (requests, notifications and
    /// the replies the reader owes), written in order by the chat's own writer
    /// thread (`write_replies`): neither the reader nor a caller may block on
    /// the agent's stdin - an agent busy writing to a full stdout isn't
    /// reading it, and nobody would read that stdout; a full pipe would also
    /// hold `session/cancel` behind the stuck write. Bounded, unlike a thread
    /// per message: a flood gets replies dropped or `send` refused.
    pub(super) replies: mpsc::SyncSender<Value>,
    /// A write to the agent's stdin failed: `send` refuses from then on.
    pub(super) write_failed: AtomicBool,
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
    /// The agent's session; replaced by `ChatState::renew` (`/clear` on the same process).
    pub(super) session_id: Mutex<Option<String>>,
    /// The `modes` the agent announced when the session started.
    pub(super) modes: Mutex<Option<Value>>,
    /// The agent announced `sessionCapabilities.close`: a session can be closed and replaced on the same process.
    pub(super) can_close: AtomicBool,
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
    /// The running turn was started by the agent itself (no prompt of ours): its end is the adapter's result
    /// marker, the `AUTONOMOUS_IDLE_MS` fallback, or a prompt merged into it. Written under the status lock.
    pub(super) autonomous: AtomicBool,
    /// When the last event came (ms), for the autonomous turn's fallback.
    pub(super) last_event_at: AtomicU64,
    /// A thread is watching the autonomous turn for the fallback.
    pub(super) autonomous_watch: AtomicBool,
    /// When the handshake ended (ms): output just after it is the agent's startup notices, not a turn.
    pub(super) ready_at: AtomicU64,
    /// The ACP version this agent process speaks, fixed for its life (a flagged chat that the agent refused
    /// to serve on v2 is restarted on v1 as a new `Chat`).
    pub(super) protocol: AcpProtocol,
    /// The v2 codec's state and the turn rules on top of it (untouched on v1).
    pub(super) v2: Mutex<v2_turn::V2Run>,
}

/// An autonomous turn with no event for this long is ended (the adapter sent no end marker).
const AUTONOMOUS_IDLE_MS: u64 = 120_000;
/// Output this soon after the handshake opens no turn: Vibe, for one, sends its MCP/auth notices as agent text then.
const STARTUP_GRACE_MS: u64 = 5_000;

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
        let _ = self.emit_when(body, |_, _| Ok(()));
    }

    /// Ends a turn the agent started by itself: no prompt response will come for it. Only if the chat is
    /// still in one - checked under the log lock, so the marker, the fallback timer and a cancel can't
    /// each end it.
    pub(super) fn end_autonomous(&self, stop_reason: &str) {
        let _ = self.emit_when(ChatBody::TurnEnd { stop_reason: stop_reason.into() }, |_, autonomous| if autonomous { Ok(()) } else { Err(String::new()) });
    }

    /// Starts the thread that ends an autonomous turn the agent leaves hanging, unless one already runs.
    pub(super) fn watch_autonomous(self: &Arc<Self>) {
        // On v2 the agent says when its work ends: no fallback timer.
        if self.protocol == AcpProtocol::V1 && self.autonomous.load(Ordering::Acquire) && !self.autonomous_watch.swap(true, Ordering::AcqRel) {
            let weak = Arc::downgrade(self);
            std::thread::spawn(move || watch_autonomous_turn(weak));
        }
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
    pub(super) fn emit_when(&self, body: ChatBody, allow: impl FnOnce(ChatStatus, bool) -> Result<(), String>) -> Result<(), String> {
        let mut log = lock(&self.log);
        let (before, after, opened_autonomous) = {
            let mut status = lock(&self.status);
            let before = *status;
            allow(before, self.autonomous.load(Ordering::Acquire))?;
            let permissions_pending = !lock(&self.permissions).is_empty() || !lock(&self.asks).is_empty();
            // A delegated child works only on its task's prompt: an update before that prompt must not open a
            // turn of its own, whose synthetic end would finish the task early.
            // (v1 only: on v2 an update never opens a turn, so there is nothing to guard.)
            let idle_update = self.protocol == AcpProtocol::V1 && before == ChatStatus::Idle && matches!(body, ChatBody::Update { .. });
            let startup_notice = idle_update && now_ms().saturating_sub(self.ready_at.load(Ordering::Relaxed)) < STARTUP_GRACE_MS;
            *status = if idle_update && (self.link.is_some() || startup_notice) { before } else { next_status(before, &body, permissions_pending, self.protocol) };
            if *status != before {
                self.status_at.store(now_ms(), Ordering::Relaxed);
            }
            // A turn begun by an update alone is the agent's own; a prompt, the turn's end, an error or the exit close that.
            let opened = matches!(body, ChatBody::Update { .. }) && before == ChatStatus::Idle && *status != ChatStatus::Idle;
            match &body {
                ChatBody::Update { .. } if opened => self.autonomous.store(true, Ordering::Release),
                ChatBody::User { .. } | ChatBody::TurnEnd { .. } | ChatBody::Error { .. } | ChatBody::Exit { .. } => self.autonomous.store(false, Ordering::Release),
                _ => {}
            }
            (before, *status, opened)
        };
        self.last_event_at.store(now_ms(), Ordering::Relaxed);
        // The adapter's result of an autonomous cycle; with a prompt of ours pending, its response ends the turn instead.
        let ends_autonomous = self.protocol == AcpProtocol::V1
            && self.autonomous.load(Ordering::Acquire)
            && is_autonomous_end_marker(&body)
            && !lock(&self.pending).values().any(|p| matches!(p, Pending::Prompt));
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
        // No subscriber (the common case for a chat nobody streams) = no clone.
        if self.feed.receiver_count() > 0 {
            let _ = self.feed.send(event.clone());
        }
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
        if opened_autonomous {
            self.emit(ChatBody::Ext { method: AUTONOMOUS_EXT_METHOD.into(), params: json!({}) });
        }
        if ends_autonomous {
            self.end_autonomous("end_turn");
        }
        // A turn ended (its end, an error, an autonomous turn's end): a message from another tab may go now.
        // After the log lock: delivery prompts this very chat.
        if after == ChatStatus::Idle && before != ChatStatus::Idle && self.link.is_none() {
            let limit = matches!(&event.body, ChatBody::Error { limit: true, .. });
            crate::agent_messages::on_idle(&self.app, &self.id, limit);
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
                self.ready_at.store(now_ms(), Ordering::Relaxed);
            }
            moved
        };
        if moved {
            self.changed();
            if self.link.is_none() {
                crate::agent_messages::on_idle(&self.app, &self.id, false);
            }
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

    /// `/clear` on the running agent: `old` is being closed and replaced. Whatever it still streams or asks is
    /// dropped from now on, its turn's late answer ends nothing, and the log starts over with a `_flowcode/cleared`
    /// marker that empties every view. Call it after cancelling the turn, with no lock held.
    pub(super) fn begin_renew(&self, old: &str) {
        {
            // Lock order: log first (see `emit_when`).
            let mut log = lock(&self.log);
            *lock(&self.stale_session) = Some(old.to_string());
            // Until the new session exists, a prompt (from a phone) fails instead of reaching the closed one.
            *lock(&self.session_id) = None;
            lock(&self.pending).retain(|_, pending| !matches!(pending, Pending::Prompt | Pending::PromptV2));
            lock(&self.v2).reset();
            log.reset();
            lock(&self.cline_tools).clear();
            *lock(&self.cline_spawns) = cline::Spawns::default();
            lock(&self.children).clear();
            lock(&self.launches).clear();
            *lock(&self.goal) = goal::GoalTrack::default();
            *lock(&self.status) = ChatStatus::Idle;
            self.autonomous.store(false, Ordering::Release);
            self.status_at.store(now_ms(), Ordering::Relaxed);
        }
        self.emit(ChatBody::Ext { method: CLEARED_EXT_METHOD.into(), params: json!({}) });
        self.changed();
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
        let (Some(state), Some(session_id)) = (self.app.try_state::<ChatState>(), lock(&self.session_id).clone()) else { return };
        let _ = state.alerts.send(ChatAlert { agent: self.agent.clone(), session_id, kind });
    }

    pub(super) fn stderr_tail(&self) -> String {
        String::from_utf8_lossy(&lock(&self.stderr)).trim().to_string()
    }

    /// `base`, followed by what the agent last wrote to stderr.
    pub(super) fn with_tail(&self, base: &str) -> String {
        let tail = self.stderr_tail();
        if tail.is_empty() { base.to_string() } else { format!("{base}: {tail}") }
    }

    /// Queues one message for the agent's stdin; the writer thread sends the
    /// queue in order, so this never blocks on a full pipe.
    pub(super) fn send(&self, message: &Value) -> Result<(), String> {
        if self.write_failed.load(Ordering::Acquire) {
            return Err(self.with_tail("the agent is not accepting input"));
        }
        match self.replies.try_send(message.clone()) {
            Ok(()) => Ok(()),
            Err(mpsc::TrySendError::Full(_)) => Err(self.with_tail("the agent is not reading its input")),
            Err(mpsc::TrySendError::Disconnected(_)) => Err(self.with_tail("the agent is not accepting input")),
        }
    }

    /// Writes one message line to the agent's stdin (the writer thread's job).
    fn write_now(&self, message: &Value) -> Result<(), String> {
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

    pub(super) fn session_id(&self) -> Result<String, String> {
        lock(&self.session_id).clone().ok_or_else(|| "chat not started".to_string())
    }

    /// Switches the agent to `model_id` (one it offers) through whichever API
    /// announced the models. Allowed mid-turn: ACP applies it from the next
    /// prompt. Every view hears of it through a `_flowcode/model` event, the
    /// phones' chat list through `changed`.
    pub(super) fn set_model(&self, model_id: &str) -> Result<(), String> {
        let session_id = self.session_id()?;
        let via = {
            let models = lock(&self.models);
            let models = models.as_ref().ok_or_else(|| "the agent offers no model to choose".to_string())?;
            if !models.offers(model_id) {
                return Err(format!("unknown model: {model_id}"));
            }
            models.via.clone()
        };
        let result = match &via {
            // v2 has no `session/set_model`: its models are a config option.
            ModelVia::Models if self.protocol == AcpProtocol::V2 => return Err("the agent offers no model option to change".to_string()),
            ModelVia::Models => self.request(
                "session/set_model",
                json!({ "sessionId": session_id, "modelId": model_id }),
                MODE_TIMEOUT,
            )?,
            ModelVia::ConfigOption { config_id } => self.set_config_option(&session_id, config_id, json!(model_id))?,
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

    /// `session/set_config_option`; the answer is in the v1 shape either way (v2's value is tagged and
    /// its options are named `configId`/`groupId`, see `acp_v2`).
    pub(super) fn set_config_option(&self, session_id: &str, config_id: &str, value: Value) -> Result<Value, String> {
        if self.protocol == AcpProtocol::V2 {
            let result = self.request("session/set_config_option", acp_v2::set_config_option_params(session_id, config_id, &value), MODE_TIMEOUT)?;
            return Ok(acp_v2::config_result_to_v1(&result));
        }
        self.request("session/set_config_option", json!({ "sessionId": session_id, "configId": config_id, "value": value }), MODE_TIMEOUT)
    }

    /// Asks the agent to switch to the mode `mode_id`: `session/set_mode`, or on v2 (which has none) the
    /// config option of category `mode`. The caller records and announces the change.
    pub(super) fn request_mode(&self, mode_id: &str) -> Result<(), String> {
        let session_id = self.session_id()?;
        if self.protocol == AcpProtocol::V2 {
            let config_id = lock(&self.v2).mode_config.clone().ok_or_else(|| "the agent offers no mode to choose".to_string())?;
            self.set_config_option(&session_id, &config_id, json!(mode_id))?;
        } else {
            self.request("session/set_mode", json!({ "sessionId": session_id, "modeId": mode_id }), MODE_TIMEOUT)?;
        }
        Ok(())
    }

    /// Switches the agent to the thinking level `value` (one it offers), with
    /// `session/set_config_option`. Every view hears of it through a
    /// `_flowcode/thought` event, as for `set_model`.
    pub(super) fn set_thought(&self, value: &str) -> Result<(), String> {
        let session_id = self.session_id()?;
        let config_id = {
            let thought = lock(&self.thought);
            let thought = thought.as_ref().ok_or_else(|| "the agent offers no thinking level to choose".to_string())?;
            if !thought.offers(value) {
                return Err(format!("unknown thinking level: {value}"));
            }
            thought.config_id.clone()
        };
        let result = self.set_config_option(&session_id, &config_id, json!(value))?;
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
        if self.protocol == AcpProtocol::V2 {
            if let Some(id) = acp_v2::mode_config_id(options) {
                lock(&self.v2).mode_config = Some(id);
            }
        }
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
        let params = json!({ "goal": goal, "actions": goal::actions(&self.agent, self.protocol) });
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
        let Some(session_id) = lock(&self.session_id).clone() else { return };
        let distro = if self.wsl { self.wsl_distro.as_deref() } else { None };
        let read = goal::read(&self.app, &self.agent, &session_id, self.profile.as_deref(), distro);
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
        if !goal::actions(&self.agent, self.protocol).contains(&action) {
            return Err(format!("unsupported goal action: {action}"));
        }
        let session_id = self.session_id()?;
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
                let error_code = result.as_ref().err().map(|e| e.code);
                let limit = result.as_ref().err().is_some_and(is_limit_error);
                let gone = result.as_ref().err().is_some_and(is_session_gone);
                let result = result.map_err(|e| error_text(&e));
                match pending {
                    Pending::Waiter(tx) => {
                        let _ = tx.send(result);
                    }
                    Pending::PromptV2 => self.prompt_v2_answered(result, error_code, limit, gone),
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
                // v2 words the request differently (`subject.toolCall`, a `title`): the code below reads v1's.
                let params = if self.protocol == AcpProtocol::V2 && method == "session/request_permission" { acp_v2::permission_params(&params) } else { params };
                // Asked by the session `/clear` replaced: nobody is left to answer.
                if matches!(method.as_str(), "session/request_permission" | "elicitation/create") && self.is_stale(&params) {
                    let result = if method == "elicitation/create" { json!({ "action": "cancel" }) } else { json!({ "outcome": { "outcome": "cancelled" } }) };
                    let _ = self.replies.try_send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
                    return;
                }
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
                        if self.protocol == AcpProtocol::V2 {
                            self.handle_v2_update(&params, update);
                        } else {
                            self.handle_update(&params, update);
                        }
                    }
                } else if method.trim_start_matches('_') == OPENCODE_CHILD_UPDATE {
                    // OpenCode (sub-agents): the children's work comes as extension notifications, not `session/update`.
                    let Some((child_params, mut update)) = opencode_child_update(&mut lock(&self.launches), &mut lock(&self.children), &params) else { return };
                    let stale = |_, _| if self.is_stale(&params) { Err(String::new()) } else { Ok(()) };
                    if !route_child_update(&mut lock(&self.children), &child_params, &mut update) {
                        return;
                    }
                    crate::chat_images::stash_images(&mut update);
                    let _ = self.emit_when(ChatBody::Update { update }, stale);
                    self.watch_autonomous();
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

    /// One v1-shaped `session/update` of the chat (a v2 one arrives translated, see `handle_v2_update`):
    /// logged, shown, and the config/mode/subagent bookkeeping it carries.
    fn handle_update(self: &Arc<Self>, params: &Value, update: &Value) {
        // A native subagent's own config chatter (v2 always has them) must not move the chat's model or mode.
        let of_child = self.protocol == AcpProtocol::V2
            && params.get("sessionId").and_then(Value::as_str).is_some_and(|session| lock(&self.children).contains_key(session));
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("current_mode_update") && !self.is_stale(params) && !of_child {
            *lock(&self.current_mode) = update.get("currentModeId").and_then(Value::as_str).map(str::to_string);
        }
        log_native_subagent(&self.id.to_string(), params, update);
        if self.agent == "opencode" {
            let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
            note_opencode_launch(&mut lock(&self.launches), &mut lock(&self.children), session, update);
        }
        if update.get("sessionUpdate").and_then(Value::as_str) == Some("config_option_update")
            && !self.is_stale(params)
            && !of_child
        {
            if let Some(options) = update.get("configOptions") {
                self.config_options_changed(options);
            }
        }
        // The staleness is checked under the log lock, so a
        // late update can't pass it, then land after the
        // `forget_session` that emptied the log.
        let stale = |_, _| if self.is_stale(params) { Err(String::new()) } else { Ok(()) };
        // Pictures go to disk before the log lock is taken.
        let mut update = update.clone();
        if self.agent == "cline" {
            cline::normalize_cline_tool(&mut update, &mut lock(&self.cline_tools));
            cline::mark_spawns(&mut update, &mut lock(&self.cline_spawns));
        }
        if !route_child_update(&mut lock(&self.children), params, &mut update) {
            return;
        }
        if let Some(session) = params.get("sessionId").and_then(Value::as_str) {
            crate::context::note_agent_window(session, &update);
        }
        crate::chat_images::stash_images(&mut update);
        let _ = self.emit_when(ChatBody::Update { update }, stale);
        self.watch_autonomous();
    }

    // --- ACP v2 ------------------------------------------------------------------------------------------

    /// A v2 `session/update`: translated by the codec into the v1-shaped updates the rest of the chat reads,
    /// plus the agent's own turn states, which alone move the turn (see `v2_turn`).
    fn handle_v2_update(self: &Arc<Self>, params: &Value, update: &Value) {
        // History a replaced session still streams.
        if self.is_stale(params) {
            return;
        }
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
        let outs = acp_v2::translate(&mut lock(&self.v2).state, session, update);
        let terminal_output = matches!(update.get("sessionUpdate").and_then(Value::as_str), Some("terminal_update" | "terminal_output_chunk"))
            && update.get("exitStatus").is_none_or(Value::is_null);
        for out in outs {
            match out {
                acp_v2::Out::Update(translated) => {
                    let call_id = translated.get("toolCallId").and_then(Value::as_str).map(str::to_string);
                    let Some(call_id) = call_id else {
                        self.handle_update(params, &translated);
                        continue;
                    };
                    let now = now_ms();
                    if !terminal_output {
                        // Another update of the call (status, exit) supersedes the output held back.
                        lock(&self.v2).throttle.sent(&call_id, now);
                        self.handle_update(params, &translated);
                        continue;
                    }
                    let offered = lock(&self.v2).throttle.offer(&call_id, params.clone(), translated, now);
                    match offered {
                        v2_turn::Offer::Now(params, translated) => self.handle_update(&params, &translated),
                        v2_turn::Offer::Held { first: true, wait_ms } => {
                            let weak = Arc::downgrade(self);
                            std::thread::spawn(move || {
                                std::thread::sleep(Duration::from_millis(wait_ms));
                                if let Some(chat) = weak.upgrade() {
                                    let held = lock(&chat.v2).throttle.take(&call_id, now_ms());
                                    if let Some((params, translated)) = held {
                                        chat.handle_update(&params, &translated);
                                    }
                                }
                            });
                        }
                        v2_turn::Offer::Held { first: false, .. } => {}
                    }
                }
                acp_v2::Out::Running => {
                    lock(&self.v2).running = true;
                    self.open_agent_turn();
                }
                acp_v2::Out::RequiresAction => lock(&self.v2).running = true,
                acp_v2::Out::Idle { stop_reason, error, background } => self.v2_idle(stop_reason, error, background),
                acp_v2::Out::Background(params) => self.emit(ChatBody::Ext { method: BACKGROUND_EXT_METHOD.to_string(), params }),
            }
        }
    }

    /// The agent says it started work: a turn of its own (no prompt of ours) opens, as the views' working
    /// state, exactly where `emit_when` would have opened one from the agent's output on v1. Nothing when a
    /// turn is already open (our prompt's) or the chat is still starting (`v2_started` looks again then).
    /// Under the log lock, as `emit_when`, so no event slips between the status move and its marker.
    pub(super) fn open_agent_turn(&self) {
        if self.protocol != AcpProtocol::V2 {
            return;
        }
        let mut log = lock(&self.log);
        {
            let mut status = lock(&self.status);
            if *status != ChatStatus::Idle {
                return;
            }
            let permissions_pending = !lock(&self.permissions).is_empty() || !lock(&self.asks).is_empty();
            *status = if permissions_pending { ChatStatus::Waiting } else { ChatStatus::Busy };
            self.autonomous.store(true, Ordering::Release);
            self.status_at.store(now_ms(), Ordering::Relaxed);
        }
        self.last_event_at.store(now_ms(), Ordering::Relaxed);
        let event = log.push(ChatBody::Ext { method: AUTONOMOUS_EXT_METHOD.into(), params: json!({}) }, now_ms());
        if self.feed.receiver_count() > 0 {
            let _ = self.feed.send(event.clone());
        }
        if !self.closed.load(Ordering::Relaxed) {
            let _ = self.app.emit_to(&self.owner, "chat-event", json!({ "chatId": self.id, "event": event }));
        }
        drop(log);
        self.changed();
    }

    /// The handshake is over: work the agent was already doing (a resume's snapshot said `running`) opens its turn now.
    pub(super) fn v2_started(&self) {
        if self.protocol == AcpProtocol::V2 && lock(&self.v2).running {
            self.open_agent_turn();
        }
    }

    /// Stops one piece of the agent's background work (v2 only): `terminal/cancel` or `tool_call/cancel`, whichever the
    /// item advertised. A v1 chat, or an item that did not advertise it, is an error.
    pub(super) fn cancel_background(&self, terminal_id: Option<&str>, tool_call_id: Option<&str>) -> Result<(), String> {
        if self.protocol != AcpProtocol::V2 {
            return Err("this chat has no way to stop background work".to_string());
        }
        let (method, params) = lock(&self.v2).state.cancel_request(terminal_id, tool_call_id)?;
        self.request(method, params, Duration::from_secs(10)).map(|_| ())
    }

    /// A v2 setup answer (`session/new`, `session/resume`): remembers the session and its mode for the codec and returns the
    /// setup in the v1 shape. v2 sends the commands in the answer, v1 as an update: that update is made here.
    pub(super) fn v2_setup(&self, result: &Value, session_id: &str) -> Value {
        let setup = acp_v2::setup_from_response(result);
        {
            let mut run = lock(&self.v2);
            run.state.main = Some(session_id.to_string());
            run.state.observe_setup(&setup);
        }
        if setup.get("availableCommands").and_then(Value::as_array).is_some_and(|commands| !commands.is_empty()) {
            self.emit(ChatBody::Update { update: json!({ "sessionUpdate": "available_commands_update", "availableCommands": setup["availableCommands"] }) });
        }
        setup
    }

    /// A `state_update` idle. A stop reason ends the turn (unless background subagents hold it, see `Hold`), an error fails
    /// it, a snapshot or repeat means nothing.
    fn v2_idle(self: &Arc<Self>, stop_reason: Option<String>, error: Option<RpcError>, background: Option<Vec<Value>>) {
        let step = {
            let mut run = lock(&self.v2);
            if stop_reason.is_some() || error.is_some() {
                run.running = false;
            }
            if error.is_some() {
                run.hold.observe(background.as_deref());
                None
            } else {
                Some(run.hold.on_idle(stop_reason.as_deref(), background.as_deref()))
            }
        };
        match (error, step) {
            (Some(error), _) => self.v2_fail(&error),
            (None, Some(v2_turn::IdleStep::End(reason, released))) => {
                if released {
                    eprintln!("chat {}: acp v2 turn released after its background subagents ({reason})", self.id);
                }
                self.v2_end_turn(&reason);
            }
            (None, Some(v2_turn::IdleStep::Held)) => eprintln!("chat {}: acp v2 idle held for background subagents", self.id),
            _ => {}
        }
    }

    /// Ends the turn the agent's `idle` ended: only a chat still in one (a late idle after a forced end, or after the
    /// failed prompt's own error, ends nothing).
    pub(super) fn v2_end_turn(self: &Arc<Self>, stop_reason: &str) {
        let ended = self.emit_when(ChatBody::TurnEnd { stop_reason: stop_reason.to_string() }, in_turn);
        lock(&self.v2).turn_over();
        if ended.is_ok() {
            self.refresh_goal_soon();
        }
    }

    /// The turn failed (`idle` with an `error`): shown as a failed prompt on v1 is; an agent whose session is gone is ended.
    fn v2_fail(&self, error: &RpcError) {
        let (message, limit) = (error_text(error), is_limit_error(error));
        let shown = self.emit_when(ChatBody::Error { message: message.clone(), limit }, in_turn);
        lock(&self.v2).turn_over();
        if shown.is_ok() {
            delegate::prompt_failed(self, &message);
        }
        if is_session_gone(error) {
            self.end_dead_session();
        }
    }

    /// The answer of a v2 `session/prompt`: `{messageId}` only says the agent took it in.
    fn prompt_v2_answered(&self, result: Result<Value, String>, error_code: Option<i64>, limit: bool, gone: bool) {
        let running = lock(&self.v2).running;
        match v2_turn::prompt_v2_outcome(error_code, running) {
            v2_turn::PromptV2::Inserted | v2_turn::PromptV2::WaitForIdle => {}
            v2_turn::PromptV2::EndCancelled => {
                let _ = self.emit_when(ChatBody::TurnEnd { stop_reason: "cancelled".into() }, in_turn);
                lock(&self.v2).turn_over();
            }
            v2_turn::PromptV2::Failed { reopen } => {
                let message = result.err().unwrap_or_else(|| "the prompt failed".to_string());
                self.prompt_failed(message, limit);
                lock(&self.v2).turn_over();
                if gone {
                    self.end_dead_session();
                } else if reopen {
                    // The prompt was refused but the agent still works on its own: the views keep showing it.
                    self.open_agent_turn();
                }
            }
        }
    }

    /// After a v2 `session/cancel`: the agent's `idle cancelled` ends the turn. Should it not come in `CANCEL_GRACE_MS`
    /// (the agent had nothing to stop) the turn is ended here. An agent already idle, its turn only held for background
    /// subagents, has nothing to answer: ended at once.
    pub(super) fn v2_cancelled(self: &Arc<Self>) {
        let (generation, held) = {
            let mut run = lock(&self.v2);
            (run.arm_cancel(), run.hold.is_held())
        };
        if held {
            self.v2_end_turn("cancelled");
            return;
        }
        let weak = Arc::downgrade(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(v2_turn::CANCEL_GRACE_MS));
            if let Some(chat) = weak.upgrade() {
                if lock(&chat.v2).cancel == Some(generation) {
                    eprintln!("chat {}: acp v2 cancel got no idle, ending the turn", chat.id);
                    chat.v2_end_turn("cancelled");
                }
            }
        });
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
                Pending::Prompt | Pending::PromptV2 => self.emit(ChatBody::Error { message: message.clone(), limit: false }),
            }
        }
        self.emit(ChatBody::Exit { code });
        self.release_token();
        // Tasks it delegated have no one left to report to.
        if let Some(state) = self.app.try_state::<ChatState>() {
            state.close_children(self);
        }
        // Messages waiting for it fail, and their senders are told.
        crate::agent_messages::on_closed(&self.app, &crate::chat_mcp::Owner::Chat(self.id.clone()));
    }

    /// Waits (briefly) for the process to be gone, killing it if it lingers -
    /// with what it started, as `kill` does: killing only `cmd` (Windows) or
    /// the `npx` shim would leave the real agent running.
    pub(super) fn reap(&self) -> Option<i32> {
        for _ in 0..40 {
            if let Ok(Some(status)) = lock(&self.child).try_wait() {
                // The agent is gone but what it started may not be.
                drop(lock(&self.job).take());
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

/// Ends the autonomous turn of a chat that goes quiet for `AUTONOMOUS_IDLE_MS`
/// (no end marker came), checking every 10 s. Gives up with the turn, the
/// chat's exit or its close. A turn waiting on a permission isn't hung.
fn watch_autonomous_turn(chat: Weak<Chat>) {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(10));
        let Some(chat) = chat.upgrade() else { return };
        if chat.closed.load(Ordering::Relaxed) || chat.exited.load(Ordering::Acquire) || !chat.autonomous.load(Ordering::Acquire) {
            chat.autonomous_watch.store(false, Ordering::Release);
            // A new autonomous turn may have begun after the check: keep watching it if nobody else started.
            if chat.autonomous.load(Ordering::Acquire) && !chat.closed.load(Ordering::Relaxed) && !chat.autonomous_watch.swap(true, Ordering::AcqRel) {
                continue;
            }
            return;
        }
        let quiet = now_ms().saturating_sub(chat.last_event_at.load(Ordering::Relaxed)) >= AUTONOMOUS_IDLE_MS;
        if quiet && *lock(&chat.status) == ChatStatus::Busy {
            chat.end_autonomous("end_turn");
        }
    }
}

/// The decision of `ChatState::prompt_resume`'s gate, under the status lock:
/// the chat must accept a prompt (`prompt_gate`) and the slot must still hold
/// the resume of `generation` with exactly `text`. On success the resume is
/// taken out of the slot, so it is consumed atomically with the turn starting.
/// Nothing is touched on error.
pub(super) fn take_resume_for_prompt(status: ChatStatus, autonomous: bool, slot: &mut Option<ScheduledResume>, generation: u64, text: &str) -> Result<ScheduledResume, String> {
    prompt_gate(status, autonomous)?;
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
        if let Err(e) = chat.write_now(&reply) {
            chat.write_failed.store(true, Ordering::Release);
            eprintln!("chat {}: {e}", chat.id);
        }
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
        let user = ChatBody::User { text: "go".into(), attachments: Vec::new(), images: Vec::new(), peer: None };
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
        assert!(take_resume_for_prompt(ChatStatus::Busy, false, &mut slot, 1, "go").unwrap_err().starts_with("agent_busy"));
        assert!(slot.is_some());
        // Another schedule replaced it: gone, untouched.
        assert_eq!(take_resume_for_prompt(ChatStatus::Idle, false, &mut slot, 2, "go").unwrap_err(), "resume_gone");
        assert!(slot.is_some());
        // Edited between the peek and the acquisition: changed, untouched.
        assert_eq!(take_resume_for_prompt(ChatStatus::Idle, false, &mut slot, 1, "old text").unwrap_err(), "resume_changed");
        assert_eq!(slot.as_ref().unwrap().text, "go");
        // Nothing scheduled.
        assert_eq!(take_resume_for_prompt(ChatStatus::Idle, false, &mut None, 1, "go").unwrap_err(), "resume_gone");
        // Accepted: handed out and the slot emptied.
        let taken = take_resume_for_prompt(ChatStatus::Idle, false, &mut slot, 1, "go").unwrap();
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
