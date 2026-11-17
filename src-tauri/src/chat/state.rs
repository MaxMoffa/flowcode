//! `ChatState`: the chats of the app, and how an agent is started.

use super::*;

pub struct ChatState {
    pub(super) sessions: Mutex<HashMap<String, ChatSession>>,
    /// Counts the chats started or ended and the status changes, so the
    /// remote access server hears of them.
    pub(super) changes: watch::Sender<u64>,
    pub(super) alerts: broadcast::Sender<ChatAlert>,
    /// The tasks chats delegated to other agents.
    pub(super) delegations: Delegations,
}

impl Default for ChatState {
    fn default() -> Self {
        ChatState {
            sessions: Mutex::new(HashMap::new()),
            changes: watch::channel(0).0,
            alerts: broadcast::channel(32).0,
            delegations: Delegations::default(),
        }
    }
}

impl ChatState {
    pub(crate) fn shutdown(&self) {
        let sessions = std::mem::take(&mut *lock(&self.sessions));
        for session in sessions.values() { self.delegations.forget_parent(&session.chat.id); }
        drop(sessions);
    }
    pub(super) fn changed(&self) {
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
                thought: lock(&s.chat.thought).as_ref().map(ThoughtLevels::to_json),
                wsl_distro: if s.chat.wsl { s.chat.wsl_distro.clone() } else { None },
                status: *lock(&s.chat.status),
                status_at: s.chat.status_at.load(Ordering::Relaxed),
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
        // The user wrote first: the resume scheduled for the limit's reset is moot.
        self.prompt_with(chat_id, text, attachments, prompt_gate, |chat| chat.drop_resume("cancelled"))
    }

    /// Sends the scheduled resume of `generation` as the user's prompt. As
    /// `prompt`, and in the same atomic step as the turn starting, the resume
    /// slot must still hold that generation with exactly `text`
    /// (`resume_gone` / `resume_changed` otherwise, nothing sent) and is
    /// consumed, then announced as sent. Order rule with `update_resume`: an
    /// edit accepted before the turn is acquired wins (the gate sees the new
    /// text and refuses, so the timer retries with it); after that the edit
    /// finds no resume scheduled.
    pub(crate) fn prompt_resume(&self, chat_id: &str, generation: u64, text: &str) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        let taken: std::cell::RefCell<Option<ScheduledResume>> = std::cell::RefCell::new(None);
        let resume_slot = &chat.resume;
        // Lock order: log, status (held by `emit_when`), then resume; nothing
        // holds `resume` while taking those or while announcing.
        self.prompt_with(
            chat_id,
            text.to_string(),
            Vec::new(),
            |status| {
                let resume = take_resume_for_prompt(status, &mut lock(resume_slot), generation, text)?;
                *taken.borrow_mut() = Some(resume);
                Ok(())
            },
            |chat| {
                if let Some(resume) = taken.borrow().as_ref() {
                    chat.announce_resume("sent", resume);
                }
            },
        )
    }

    /// The body of `prompt`: `gate` decides under `emit_when` whether the chat
    /// takes the prompt, `after_user` runs right after the `User` event is out
    /// (before the request is registered and sent).
    pub(super) fn prompt_with(
        &self,
        chat_id: &str,
        text: String,
        attachments: Vec<Attachment>,
        gate: impl FnOnce(ChatStatus) -> Result<(), String>,
        after_user: impl FnOnce(&Chat),
    ) -> Result<(), String> {
        if attachments.len() > 16 { return Err("at most 16 attachments per prompt".into()); }
        let chat = self.get(chat_id)?;
        let session_id = chat.session_id()?.to_string();
        // File IO first: a failure here must not leave a turn open.
        let mut blocks = Vec::new();
        if !text.is_empty() || attachments.is_empty() {
            blocks.push(json!({ "type": "text", "text": text }));
        }
        let images = chat.prompt_images.load(Ordering::Acquire);
        for attachment in &attachments {
            blocks.extend(attachment_blocks(attachment, images, chat.wsl)?);
        }
        let names = attachments.iter().map(|a| a.name.clone()).collect();
        let shown = attachments.iter().filter_map(shown_image).collect();
        let asked = goal::parse_prompt(&chat.agent, &text);
        chat.emit_when(ChatBody::User { text, attachments: names, images: shown }, gate)?;
        after_user(&chat);
        if let Some(asked) = asked {
            chat.goal_asked(&asked);
        }
        let id = match chat.register(Pending::Prompt) {
            Ok(id) => id,
            Err(message) => {
                chat.prompt_failed(message.clone(), false);
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
                chat.prompt_failed(message.clone(), false);
            }
            return Err(message);
        }
        Ok(())
    }

    /// Schedules `text` to be sent by itself `RESUME_GRACE_MS` after `at`, the
    /// usage limit's reset (`limit_id`: the views' limit item it answers).
    /// Replaces an earlier schedule; the user writing first cancels it.
    pub(crate) fn schedule_resume(&self, chat_id: &str, at: u64, text: String, limit_id: String) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        let text = text.trim().to_string();
        if text.is_empty() || text.len() > MAX_RESUME_TEXT_BYTES || limit_id.len() > 256 {
            return Err("invalid resume".into());
        }
        if chat.exited.load(Ordering::Acquire) || chat.closed.load(Ordering::Relaxed) {
            return Err("agent_exited: the agent has exited".into());
        }
        let generation = chat.resume_gen.fetch_add(1, Ordering::AcqRel) + 1;
        let resume = ScheduledResume { at, text, limit_id, generation };
        *lock(&chat.resume) = Some(resume.clone());
        chat.announce_resume("armed", &resume);
        let weak = Arc::downgrade(&chat);
        std::thread::spawn(move || send_resume_when_due(weak, generation));
        Ok(())
    }

    /// Edits the scheduled resume's message, or cancels it (`None`, or a
    /// blank text). Only touches the text under the `resume` lock, which the
    /// `prompt_resume` gate also takes: an update accepted before the timer
    /// acquires the turn wins (the gate sees the new text, refuses with
    /// `resume_changed` and the next tick sends it); after the acquisition the
    /// resume is gone and this returns "no resume scheduled".
    pub(crate) fn update_resume(&self, chat_id: &str, text: Option<String>) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        let Some(text) = text.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) else {
            chat.drop_resume("cancelled");
            return Ok(());
        };
        if text.len() > MAX_RESUME_TEXT_BYTES {
            return Err("invalid resume".into());
        }
        let updated = lock(&chat.resume).as_mut().map(|resume| {
            resume.text = text;
            resume.clone()
        });
        match updated {
            Some(resume) => {
                chat.announce_resume("armed", &resume);
                Ok(())
            }
            None => Err("no resume scheduled".into()),
        }
    }

    /// Cancels the scheduled resume of every chat (auto-resume turned off).
    /// The chats are collected first: `drop_resume` emits events.
    pub(crate) fn cancel_all_resumes(&self) {
        let chats: Vec<Arc<Chat>> = lock(&self.sessions).values().map(|s| Arc::clone(&s.chat)).collect();
        for chat in chats {
            chat.drop_resume("cancelled");
        }
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

    /// Answers a form question (`Ask`) of a chat.
    pub(crate) fn ask(&self, chat_id: &str, request_id: &Value, action: &str, content: Option<Value>) -> Result<(), String> {
        self.get(chat_id)?.resolve_ask(request_id, action, content)
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
            *lock(&chat.current_mode) = Some(mode_id.clone());
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

    /// As `set_model`, for the thinking level.
    pub(crate) async fn set_thought(&self, chat_id: &str, value: String) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        crate::blocking(move || chat.set_thought(&value)).await
    }

    /// As `set_model`, for the goal controls (`pause`, `resume`, `clear`).
    pub(crate) async fn goal_action(&self, chat_id: &str, action: String) -> Result<(), String> {
        let chat = self.get(chat_id)?;
        crate::blocking(move || chat.goal_action(&action)).await
    }

    /// The file an image the agent mentioned by path points at, resolved in
    /// the chat's folder and WSL distro (`chat_id` of a live chat), else only
    /// absolute paths resolve.
    pub(crate) fn image_file(&self, chat_id: Option<&str>, path: &str) -> Result<std::path::PathBuf, String> {
        let chat = chat_id.map(|id| self.get(id)).transpose()?;
        let file = match &chat {
            // `Some("")`: in WSL but the distro is unknown (only `/mnt` paths resolve).
            Some(c) => crate::chat_images::resolve_file(path, Some(&c.cwd), c.wsl.then(|| c.wsl_distro.as_deref().unwrap_or(""))),
            None => crate::chat_images::resolve_file(path, None, None),
        }?;
        if let Some(chat) = &chat {
            if !crate::fs::is_local_path(&file, false) || !crate::fs::links_stay_local(&file) { return Err("image is not local".into()); }
            let root = self.preview_root(&chat.id)?.canonicalize().map_err(|e| e.to_string())?;
            let real = file.canonicalize().map_err(|e| e.to_string())?;
            if !real.starts_with(root) { return Err("image is outside the chat folder".into()); }
        }
        Ok(file)
    }

    /// The authenticated preview server scopes every chat file to this folder.
    pub(crate) fn preview_root(&self, chat_id: &str) -> Result<std::path::PathBuf, String> {
        let chat = self.get(chat_id)?;
        #[cfg(target_os = "windows")]
        if chat.wsl && chat.cwd.starts_with('/') {
            return crate::chat_images::from_wsl_path(&chat.cwd, chat.wsl_distro.as_deref().unwrap_or("")).map(std::path::PathBuf::from);
        }
        Ok(std::path::PathBuf::from(&chat.cwd))
    }

    /// Lists a started chat as a session of its owner window. Refused when that
    /// window closed while the agent was starting, and its `kill_owned_by` (run
    /// by `on_window_event` on `Destroyed`) then had nothing to kill. Tauri takes
    /// a destroyed window out of its map *before* running the `Destroyed`
    /// handlers, so inserting first and looking the window up after can't miss
    /// both ways: either the insert came first and `kill_owned_by` takes the
    /// chat, or it came after that handler ran - and so after the window left
    /// the map - and the lookup finds no window.
    pub(super) fn adopt(&self, app: &AppHandle, chat: Arc<Chat>) -> Result<(), String> {
        let (chat_id, owner) = (chat.id.clone(), chat.owner.clone());
        lock(&self.sessions).insert(chat_id.clone(), ChatSession { chat });
        if app.get_webview_window(&owner).is_none() {
            // `None` if `kill_owned_by` got it first; either way it dies.
            let orphan = lock(&self.sessions).remove(&chat_id);
            self.changed();
            if let Some(orphan) = orphan {
                std::thread::spawn(move || drop(orphan));
            }
            return Err("window_closed".into());
        }
        self.changed();
        Ok(())
    }

    /// Takes out the chats carrying out the tasks `parent_id` delegated, and
    /// forgets those tasks; dropping what is returned kills the agents.
    pub(super) fn take_children(&self, parent: &Chat) -> Vec<ChatSession> {
        let parent_id = parent.id.as_str();
        for task in self.delegations.forget_parent(parent_id) {
            parent.emit(ChatBody::Ext { method: "_flowcode/delegate".into(), params: task.params() });
        }
        let kids: Vec<ChatSession> = {
            let mut sessions = lock(&self.sessions);
            let ids: Vec<String> = sessions
                .iter()
                .filter(|(_, s)| s.chat.link.as_ref().is_some_and(|l| l.parent_chat_id == parent_id))
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| sessions.remove(id)).collect()
        };
        if !kids.is_empty() {
            self.changed();
        }
        kids
    }

    /// Closes the children of `parent_id` (its agent is gone or going), off this thread.
    pub(super) fn close_children(&self, parent: &Chat) {
        let kids = self.take_children(parent);
        if !kids.is_empty() {
            std::thread::spawn(move || drop(kids));
        }
    }

    pub(crate) fn exists(&self, chat_id: &str) -> bool {
        self.get(chat_id).is_ok()
    }

    pub(super) fn get(&self, chat_id: &str) -> Result<Arc<Chat>, String> {
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
        // Children share their parent's window, so they are in `doomed` too.
        for session in &doomed {
            self.delegations.forget_parent(&session.chat.id);
        }
        if !doomed.is_empty() {
            self.changed();
            std::thread::spawn(move || drop(doomed));
        }
    }
}

/// The shell script that starts an agent's ACP server inside WSL (the managed
/// install under the distro's home, else `npx`/the binary), with a readable
/// description of it for error messages.
pub(super) fn wsl_script(agent: &str) -> Option<(String, String)> {
    let (program, args) = launch_command(agent)?;
    let fallback = std::iter::once(program).chain(args.iter().copied()).collect::<Vec<_>>().join(" ");
    let version = crate::acp_adapters::package_spec(agent).and_then(|spec| spec.rsplit_once('@')).map(|(_, version)| version).unwrap_or_default();
    Some(match crate::acp_adapters::package(agent) {
        Some(_) => (
            format!(
                "d=\"$HOME/.local/share/flowcode/acp-adapters/{agent}\"; e=$(cat \"$d/current\" 2>/dev/null); \
                 case \"$e\" in \"$d/{version}/\"*) if [ -f \"$e\" ]; then exec node \"$e\"; fi;; esac; mkdir -p \"$HOME/.local/share/flowcode/adapter-launch\"; cd \"$HOME/.local/share/flowcode/adapter-launch\" || exit 1; exec {fallback}"
            ),
            format!("wsl: node <adapter> || {fallback}"),
        ),
        None => (format!("exec {fallback}"), format!("wsl: {fallback}")),
    })
}

/// Starts the agent's ACP server in `cwd` with its pipes open - inside the
/// distro of `wsl` when given, else as a Windows process.
pub(super) fn spawn_agent(app: &AppHandle, agent: &str, cwd: &str, profile: Option<&str>, wsl: Option<&WslTarget>) -> Result<(Child, String), String> {
    let (program, args) = launch_command(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    #[cfg(target_os = "windows")]
    if let Some(wsl) = wsl {
        let (script, line) = wsl_script(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
        crate::acp_adapters::refresh_wsl_in_background(wsl.distro.clone(), agent);
        let mut cmd = Command::new("wsl.exe");
        if let Some(distro) = &wsl.distro {
            cmd.arg("-d").arg(distro);
        }
        // `--exec`: without it wsl.exe runs the line through the default shell, which expands the script's `$`.
        // `-l` but not `-i`: a login shell finds node (nvm...), while an interactive one lets .bashrc print into the ACP stream.
        let script = format!("printf 'FLOWCODE_PROCESS_GROUP=%s\\n' \"$$\" >&2; {script}");
        cmd.arg("--cd").arg(&wsl.cwd).arg("--exec").args(["setsid", "bash", "-lc"]).arg(script);
        // No profile env: it holds Windows paths, meaningless in the distro (as for the terminals).
        cmd.creation_flags(CREATE_NO_WINDOW).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let child = cmd.spawn().map_err(|e| format!("could not start `{line}`: {e}"))?;
        crate::process_job::assign(child.id());
        return Ok((child, line));
    }
    #[cfg(not(target_os = "windows"))]
    let _ = wsl;
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
            // cmd looks in the current folder (the project) before PATH: a `gemini.cmd` or
            // `npx.cmd` of a cloned repo would run. This keeps the lookup to PATH.
            cmd.env("NoDefaultCurrentDirectoryInExePath", "1");
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
    let neutral = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("adapter-launch");
    std::fs::create_dir_all(&neutral).map_err(|e| e.to_string())?;
    cmd.current_dir(if program == "npx" && installed.is_none() { neutral.as_path() } else { std::path::Path::new(cwd) })
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, v) in crate::profiles::env_for_cli(app, profile, agent) {
        cmd.env(k, v);
    }
    let child = cmd.spawn().map_err(|e| format!("could not start `{line}`: {e}"))?;
    crate::process_job::assign(child.id());
    Ok((child, line))
}

/// Whether a non-`strict` resume whose `session/load` failed with `error`
/// goes on with a new session. Not when the agent wants a sign-in: a new
/// session would fail the same way, and the view must offer the login.
/// Nor when another client still holds the session: a new session would silently replace the conversation.
pub(super) fn falls_back(strict: bool, error: &str) -> bool {
    !strict && !error.starts_with("auth_required") && !session_in_use(error)
}

/// Attempts (after the first) a `session/load` makes while another process still holds the session.
pub(super) const LOAD_RETRIES: u32 = 6;
pub(super) const LOAD_RETRY_DELAY: Duration = Duration::from_millis(500);

/// Whether a `session/load` error says another client still has the session open (codex-acp's `thread_active_writer`).
pub(super) fn session_in_use(error: &str) -> bool {
    let error = error.to_lowercase();
    error.contains("active writer") || error.contains("in use by another")
}

pub(super) fn new_session(chat: &Chat, cwd: &str) -> Result<(Value, String, bool), String> {
    let mcp = chat.mcp_servers();
    let result = chat.request("session/new", json!({ "cwd": cwd, "mcpServers": mcp }), SETUP_TIMEOUT)?;
    let session_id = result
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| "session/new returned no sessionId".to_string())?
        .to_string();
    Ok((result, session_id, false))
}

/// Native subagents run in their own sessions, whose updates arrive on the same stream. Tracks the children and tells whether `update`
/// (of `params`) is kept: the child's own session chatter (config, mode, commands, usage, plan, its copy of the prompt message) would
/// overwrite the main chat's, so it is dropped; what stays (its tool calls and text) gets the launch id as `parentToolUseId` when the
/// adapter didn't say it, so it nests under the subagent.
pub(super) fn route_child_update(children: &mut HashMap<String, Option<String>>, params: &Value, update: &mut Value) -> bool {
    const CHATTER: [&str; 8] = [
        "config_option_update", "current_mode_update", "available_commands_update", "usage_update", "plan", "session_info_update", "session_message", "compaction_update",
    ];
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("").to_string();
    let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("");
    let is_child = children.contains_key(session);
    if kind == "subagent_update" {
        if let Some(child) = update.get("sessionId").and_then(Value::as_str) {
            children.entry(child.to_string()).or_insert(None);
        }
        return true;
    }
    if kind == "session_message" {
        if is_child {
            return false;
        }
        let to = update.get("recipientSessionId").and_then(Value::as_str);
        let id = update.get("messageId").and_then(Value::as_str);
        if let (Some(to), Some(id)) = (to, id) {
            if let Some(launch @ None) = children.get_mut(to) {
                *launch = Some(id.to_string());
            }
        }
        return true;
    }
    if !is_child {
        return true;
    }
    if CHATTER.contains(&kind.as_str()) {
        return false;
    }
    if let Some(Some(launch)) = children.get(session) {
        let meta = &mut update["_meta"]["claudeCode"];
        if meta.get("parentToolUseId").and_then(Value::as_str).is_none() {
            meta["parentToolUseId"] = Value::String(launch.clone());
        }
    }
    true
}

/// OpenCode's extension notification carrying a child (sub-agent) session's activity.
pub(super) const OPENCODE_CHILD_UPDATE: &str = "opencode/session/child_update";

/// Whether an OpenCode tool call is the one that launches a sub-agent (`subagent`, `task` in sessions migrated from v1).
pub(super) fn is_opencode_launch(update: &Value) -> bool {
    ["name", "title"].iter().any(|k| {
        update.get(*k).and_then(Value::as_str).is_some_and(|n| n.eq_ignore_ascii_case("subagent") || n.eq_ignore_ascii_case("task"))
    })
}

/// Remembers a `subagent` tool call of `session` until its child session shows up, and - from the finished
/// call's `rawOutput.metadata.sessionID` - links a child that was never matched.
pub(super) fn note_opencode_launch(launches: &mut Vec<(String, String)>, children: &mut HashMap<String, Option<String>>, session: &str, update: &Value) {
    let Some(id) = update.get("toolCallId").and_then(Value::as_str) else { return };
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("tool_call") if is_opencode_launch(update) => {
            if !launches.iter().any(|(_, l)| l == id) {
                launches.push((session.to_string(), id.to_string()));
            }
        }
        Some("tool_call_update") => {
            let Some(child) = update.pointer("/rawOutput/metadata/sessionID").and_then(Value::as_str) else { return };
            launches.retain(|(_, l)| l != id);
            let launch = children.entry(child.to_string()).or_insert(None);
            if launch.is_none() {
                *launch = Some(id.to_string());
            }
        }
        _ => {}
    }
}

/// An `opencode/session/child_update` as a plain `session/update` of the child session: `(params, update)` for
/// `route_child_update`. A child is nested under the sub-agent tool call that started it: OpenCode names no link, so the
/// oldest unmatched `subagent` call of the child's parent session is taken (children are created in launch order).
/// Status notifications only register the child (the launching tool call reports its end itself); `None` when there is nothing to show.
pub(super) fn opencode_child_update(launches: &mut Vec<(String, String)>, children: &mut HashMap<String, Option<String>>, params: &Value) -> Option<(Value, Value)> {
    let child = params.get("childSessionId").and_then(Value::as_str)?;
    let parent = params.get("parentSessionId").and_then(Value::as_str).unwrap_or("");
    let launch = children.entry(child.to_string()).or_insert(None);
    if launch.is_none() {
        if let Some(i) = launches.iter().position(|(session, _)| session == parent) {
            *launch = Some(launches.remove(i).1);
        }
    }
    if params.get("type").and_then(Value::as_str) != Some("update") {
        return None;
    }
    let update = params.get("update")?.clone();
    // A sub-agent started by the child itself nests under the child's tool call.
    note_opencode_launch(launches, children, child, &update);
    Some((json!({ "sessionId": child }), update))
}

/// Whether the native-subagents experiment is on (`FLOWCODE_NATIVE_SUBAGENTS=1`).
pub(super) fn native_subagents_enabled() -> bool {
    std::env::var("FLOWCODE_NATIVE_SUBAGENTS").is_ok_and(|v| v == "1")
}

/// Experiment: prints the native subagent updates (`subagent_*`, `session_message`) verbatim to stderr,
/// with the session they arrive on, to learn their real shape before modelling them.
pub(super) fn log_native_subagent(chat_id: &str, params: &Value, update: &Value) {
    if !native_subagents_enabled() {
        return;
    }
    let kind = update.get("sessionUpdate").and_then(Value::as_str).unwrap_or("");
    if kind.starts_with("subagent_") || kind == "session_message" || kind.starts_with("async_task_") {
        let session = params.get("sessionId").and_then(Value::as_str).unwrap_or("?");
        eprintln!("[native-subagents] chat {chat_id} session {session}: {update}");
    }
}

/// `initialize`, then `session/load` or `session/new`; `strict` refuses a
/// fresh session when the resume can't load. Otherwise a load that fails
/// (the session is gone, the agent can't read it...) falls back to a new
/// session (`loaded` false, its new id) rather than failing the chat; the
/// history the failed load had already replayed is dropped with it.
pub(super) fn handshake(chat: &Chat, cwd: &str, resume: Option<String>, strict: bool, gate: &mut Option<StartGate>) -> Result<(Value, String, bool), String> {
    // Experiment: `FLOWCODE_NATIVE_SUBAGENTS=1` declares `subagents` (ACP RFD #1992), so the adapters send
    // `subagent_update` / `session_message` instead of only the Agent tool call. See `log_native_subagent`.
    let mut capabilities = json!({ "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false, "session": { "compaction": {} }, "elicitation": { "form": {} }, "_meta": { "subagent-transcript": true } });
    // Claude only: Codex then sends no launch message (its tool calls vanish) and puts the child's model options on the main stream.
    if native_subagents_enabled() && chat.agent == "claude" {
        capabilities["subagents"] = json!({});
    }
    // OpenCode only reports its sub-agents' work to clients that ask for it (see `opencode_child_update`).
    if chat.agent == "opencode" {
        capabilities["_meta"]["opencode/child-session-updates"] = json!(true);
    }
    let init = chat.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            // `session.compaction`: the adapters send `compaction_update` events (not a generic tool call) only to clients that declare it.
            "clientCapabilities": capabilities,
            "clientInfo": { "name": "flowcode", "version": env!("CARGO_PKG_VERSION") },
        }),
        SETUP_TIMEOUT,
    )?;
    // The agent opened its state store to answer `initialize`: others may start now.
    drop(gate.take());
    let images = init.pointer("/agentCapabilities/promptCapabilities/image").and_then(Value::as_bool).unwrap_or(false);
    chat.prompt_images.store(images, Ordering::Release);
    let can_load = init.pointer("/agentCapabilities/loadSession").and_then(Value::as_bool).unwrap_or(false);
    if strict && !can_load && resume.as_deref().is_some_and(|id| !id.is_empty()) {
        return Err("resume_unsupported: the agent can't resume a session".into());
    }
    match resume.filter(|id| can_load && !id.is_empty()) {
        Some(session_id) => {
            let mut loaded = Err(String::new());
            // A terminal that just handed its session over, or the agent a restart replaces, may still
            // be letting go of it (Codex: "already has an active writer"): a resume tries again briefly.
            for attempt in 0..=LOAD_RETRIES {
                if attempt > 0 {
                    std::thread::sleep(LOAD_RETRY_DELAY);
                }
                loaded = chat.request(
                    "session/load",
                    json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": chat.mcp_servers() }),
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

/// Whether an agent failed to start because another process was using its
/// state store at the same time (Codex: "failed to initialize sqlite state
/// runtime" while another Codex process migrates or still releases
/// `~/.codex`). It goes away by itself, so the start is tried again.
pub(super) fn transient_start_failure(agent: &str, error: &str) -> bool {
    let error = error.to_lowercase();
    // A timeout is not a busy store (its stderr tail may still mention one).
    agent == "codex"
        && !error.contains("timed out")
        && (error.contains("state runtime") || error.contains("sqlite") || error.contains("database is locked"))
}

/// Attempts (after the first) a start makes when the agent trips over a busy state store.
pub(super) const START_RETRIES: u32 = 3;

/// Starts that touch Codex's shared state store one at a time - until the agent answers `initialize`, not through
/// loading a session: several Codex
/// processes initializing `~/.codex` together (a restored window opening many
/// chats, a restart racing the agent it replaces) make some of them fail.
pub(super) type StartGate = std::sync::MutexGuard<'static, ()>;

pub(super) fn start_gate(agent: &str) -> Option<StartGate> {
    static CODEX: Mutex<()> = Mutex::new(());
    (agent == "codex").then(|| lock(&CODEX))
}

/// What a chat gets from Flowcode besides the agent itself.
#[derive(Clone, Default)]
pub(super) struct Extras {
    pub(super) tools: ToolsConfig,
    /// Set for a chat that carries out a delegated task.
    pub(super) link: Option<TaskLink>,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn start_blocking(
    app: AppHandle,
    owner: String,
    agent: String,
    cwd: String,
    profile: Option<String>,
    resume: Option<String>,
    strict: bool,
    shell: Option<String>,
    extras: Extras,
) -> Result<(Arc<Chat>, ChatStarted), String> {
    let mut attempt = 0;
    loop {
        let gate = start_gate(&agent);
        let started = start_once(app.clone(), owner.clone(), agent.clone(), cwd.clone(), profile.clone(), resume.clone(), strict, shell.clone(), extras.clone(), gate);
        match started {
            Err(e) if attempt < START_RETRIES && transient_start_failure(&agent, &e) => {
                attempt += 1;
                eprintln!("chat: {agent} could not start ({e}); trying again ({attempt}/{START_RETRIES})");
                std::thread::sleep(Duration::from_millis(700 * u64::from(attempt)));
            }
            other => return other,
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn start_once(
    app: AppHandle,
    owner: String,
    agent: String,
    cwd: String,
    profile: Option<String>,
    resume: Option<String>,
    strict: bool,
    shell: Option<String>,
    extras: Extras,
    mut gate: Option<StartGate>,
) -> Result<(Arc<Chat>, ChatStarted), String> {
    let wsl = wsl_target(&cwd, shell.as_deref());
    let (mut child, line) = spawn_agent(&app, &agent, &cwd, profile.as_deref(), wsl.as_ref())?;
    let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        kill_tree(child.id());
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("could not open the pipes of `{line}`"));
    };
    let chat_id = uuid::Uuid::new_v4().to_string();
    let depth = u8::from(extras.link.is_some());
    let token = (!crate::chat_mcp::enabled_tools(&extras.tools, depth).is_empty()).then(|| crate::chat_mcp::register(&chat_id, depth));
    let (replies, queued) = mpsc::sync_channel(REPLY_QUEUE);
    let chat = Arc::new(Chat {
        id: chat_id.clone(),
        app,
        owner,
        agent: agent.clone(),
        cwd: cwd.clone(),
        wsl: wsl.is_some(),
        wsl_distro: wsl.as_ref().and_then(|w| w.distro.clone().or_else(crate::util::wsl_default_distro)),
        profile,
        shell,
        tools: extras.tools,
        token,
        link: extras.link,
        answer: Mutex::new(String::new()),
        final_answer: Mutex::new(String::new()),
        child: Mutex::new(child),
        wsl_group: AtomicU32::new(0),
        wsl_group_seen: AtomicBool::new(false),
        writer: Mutex::new(stdin),
        replies,
        next_id: AtomicU64::new(1),
        pending: Mutex::new(HashMap::new()),
        permissions: Mutex::new(HashMap::new()),
        asks: Mutex::new(HashMap::new()),
        log: Mutex::new(Log::new(MAX_LOG_EVENTS, MAX_LOG_BYTES)),
        feed: broadcast::channel(FEED_CAPACITY).0,
        status: Mutex::new(ChatStatus::Starting),
        status_at: AtomicU64::new(now_ms()),
        stderr: Mutex::new(Vec::new()),
        stderr_done: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        session_id: OnceLock::new(),
        modes: OnceLock::new(),
        current_mode: Mutex::new(None),
        models: Mutex::new(None),
        thought: Mutex::new(None),
        stale_session: Mutex::new(None),
        children: Mutex::new(HashMap::new()),
        launches: Mutex::new(Vec::new()),
        prompt_images: AtomicBool::new(false),
        goal: Mutex::new(goal::GoalTrack::default()),
        resume: Mutex::new(None),
        resume_gen: AtomicU64::new(0),
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
    // The agent sees Linux paths when it runs in WSL.
    match handshake(&chat, wsl.as_ref().map_or(&cwd, |w| &w.cwd), resume, strict, &mut gate) {
        Ok((result, session_id, loaded)) => {
            let _ = chat.session_id.set(session_id.clone());
            if let Some(modes) = result.get("modes") {
                let _ = chat.modes.set(modes.clone());
                *lock(&chat.current_mode) = modes.get("currentModeId").and_then(Value::as_str).map(str::to_string);
            }
            if let Some(options) = result.get("configOptions") { chat.config_options_changed(options); }
            let models = normalize_models(&result);
            *lock(&chat.models) = models.clone();
            let thought = result.get("configOptions").and_then(thought_from_config_options);
            *lock(&chat.thought) = thought.clone();
            chat.started();
            if goal::supported(&chat.agent) {
                let (first, watcher) = (Arc::clone(&chat), Arc::downgrade(&chat));
                std::thread::spawn(move || first.refresh_goal_first());
                std::thread::spawn(move || watch_goal(watcher));
            }
            let started = ChatStarted {
                chat_id,
                session_id,
                modes: result.get("modes").cloned(),
                models: models.as_ref().map(ChatModels::to_json),
                thought: thought.as_ref().map(ThoughtLevels::to_json),
                loaded,
                wsl_distro: wsl.as_ref().and_then(|w| w.distro.clone().or_else(crate::util::wsl_default_distro)),
            };
            Ok((chat, started))
        }
        Err(e) => {
            chat.kill();
            if e.starts_with("auth_required") {
                chat.app.state::<crate::remote::RemoteState>().notify_provider_auth_required(&chat.agent, chat.profile.as_deref());
            }
            Err(if e.starts_with("auth_required") || e.starts_with("resume_unsupported") { e } else { format!("`{line}`: {e}") })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn child_session_updates_are_filtered_and_nested_under_the_launch() {
        let mut children = HashMap::new();
        let main = json!({ "sessionId": "main" });
        let child = json!({ "sessionId": "kid" });
        let mut announce = json!({ "sessionUpdate": "subagent_update", "sessionId": "kid", "state": { "state": "running" } });
        assert!(route_child_update(&mut children, &main, &mut announce));
        let mut prompt = json!({ "sessionUpdate": "session_message", "messageId": "L", "recipientSessionId": "kid" });
        assert!(route_child_update(&mut children, &main, &mut prompt));
        // The child's copy of the prompt, and its own config/mode chatter, would clobber the main chat's.
        let mut copy = json!({ "sessionUpdate": "session_message", "messageId": "L", "recipientSessionId": "kid" });
        assert!(!route_child_update(&mut children, &child, &mut copy));
        let mut config = json!({ "sessionUpdate": "config_option_update" });
        assert!(!route_child_update(&mut children, &child, &mut config));
        // Its work stays, nested under the launch id when the adapter didn't name it.
        let mut tool = json!({ "sessionUpdate": "tool_call", "toolCallId": "t" });
        assert!(route_child_update(&mut children, &child, &mut tool));
        assert_eq!(tool["_meta"]["claudeCode"]["parentToolUseId"], "L");
        let mut named = json!({ "sessionUpdate": "tool_call", "_meta": { "claudeCode": { "parentToolUseId": "X" } } });
        assert!(route_child_update(&mut children, &child, &mut named));
        assert_eq!(named["_meta"]["claudeCode"]["parentToolUseId"], "X");
        // The main session is untouched.
        let mut main_config = json!({ "sessionUpdate": "config_option_update" });
        assert!(route_child_update(&mut children, &main, &mut main_config));
    }

    #[test]
    fn opencode_children_nest_under_the_subagent_call() {
        let (mut launches, mut children) = (Vec::new(), HashMap::new());
        // Root session sends two sub-agent launches and an ordinary tool call.
        for (id, name) in [("call_a", "subagent"), ("call_b", "subagent"), ("call_c", "shell")] {
            note_opencode_launch(&mut launches, &mut children, "ses_root", &json!({ "sessionUpdate": "tool_call", "toolCallId": id, "name": name, "title": name }));
        }
        assert_eq!(launches.len(), 2);
        let created = json!({ "rootSessionId": "ses_root", "childSessionId": "ses_k1", "parentSessionId": "ses_root", "depth": 1, "title": "Explore", "type": "status", "status": "created" });
        assert!(opencode_child_update(&mut launches, &mut children, &created).is_none());
        assert_eq!(children["ses_k1"].as_deref(), Some("call_a"));
        let tool = json!({
            "rootSessionId": "ses_root", "childSessionId": "ses_k1", "parentSessionId": "ses_root", "depth": 1, "type": "update",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "ses_k1:call_z", "title": "Explore: ls", "_meta": { "opencode/child-session": { "id": "ses_k1", "parentID": "ses_root", "depth": 1 } } }
        });
        let (child_params, mut update) = opencode_child_update(&mut launches, &mut children, &tool).unwrap();
        assert_eq!(child_params["sessionId"], "ses_k1");
        assert!(route_child_update(&mut children, &child_params, &mut update));
        assert_eq!(update["_meta"]["claudeCode"]["parentToolUseId"], "call_a");
        assert_eq!(update["_meta"]["opencode/child-session"]["id"], "ses_k1");
        // The second child, first seen through an update, takes the second call.
        let second = json!({ "childSessionId": "ses_k2", "parentSessionId": "ses_root", "type": "update", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "hi" } } });
        let (p, mut u) = opencode_child_update(&mut launches, &mut children, &second).unwrap();
        assert!(route_child_update(&mut children, &p, &mut u));
        assert_eq!(u["_meta"]["claudeCode"]["parentToolUseId"], "call_b");
        // The finished launch names its child (metadata.sessionID) when no link was made.
        note_opencode_launch(&mut launches, &mut children, "ses_root", &json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call_q", "rawOutput": { "metadata": { "sessionID": "ses_k3", "status": "completed" } } }));
        assert_eq!(children["ses_k3"].as_deref(), Some("call_q"));
        // The notification is accepted with or without the extension underscore; chatter of a child is dropped.
        assert_eq!("_opencode/session/child_update".trim_start_matches('_'), OPENCODE_CHILD_UPDATE);
        let mut chatter = json!({ "sessionUpdate": "usage_update" });
        assert!(!route_child_update(&mut children, &json!({ "sessionId": "ses_k1" }), &mut chatter));
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
        assert!(!falls_back(false, "thread already has an active writer"));
    }

    #[test]
    fn a_busy_state_store_is_a_transient_start_failure() {
        assert!(transient_start_failure("codex", r"Error: failed to initialize sqlite state runtime under C:\Users\x\.codex"));
        assert!(transient_start_failure("codex", "database is locked"));
        assert!(!transient_start_failure("codex", "auth_required: sign in"));
        assert!(!transient_start_failure("claude", "failed to initialize sqlite state runtime"));
        assert!(!transient_start_failure("codex", "initialize timed out after 180s: sqlite"));
    }
}
