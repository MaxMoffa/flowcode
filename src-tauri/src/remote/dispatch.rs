//! Per-message dispatch of what the phone sends.

use super::*;

/// Runs one Git panel request through the same functions the desktop panel invokes.
pub(super) async fn run_git(request: proto::GitRequest) -> Result<serde_json::Value, String> {
    use crate::git;
    use proto::GitRequest as R;
    fn json<T: Serialize>(v: T) -> Result<serde_json::Value, String> {
        serde_json::to_value(v).map_err(|e| e.to_string())
    }
    match request {
        R::Toplevel { path } => json(git::git_toplevel(path).await?),
        R::Status { root } => json(git::git_status(root).await?),
        R::Stage { root, paths } => json(git::git_stage(root, paths).await?),
        R::Unstage { root, paths } => json(git::git_unstage(root, paths).await?),
        R::Commit { root, message } => json(git::git_commit(root, message).await?),
        R::Discard { root, paths, untracked } => json(git::git_discard(root, paths, untracked).await?),
        R::Branches { root } => json(git::git_branches(root).await?),
        R::Switch { root, name, create_from_remote } => json(git::git_switch_branch(root, name, create_from_remote).await?),
        R::Show { root, path, rev } => json(git::git_show_file(root, path, rev).await?),
    }
}

/// The agent session lists of the project at `cwd`, as the desktop's History panel loads them.
pub(super) async fn run_history(app: AppHandle, cwd: String) -> Result<serde_json::Value, String> {
    use crate::git;
    // The repo's worktrees count as the project.
    let roots = match git::git_repo_root(cwd.clone()).await {
        Ok(Some(root)) => match git::git_worktrees(root.clone()).await {
            Ok(w) if !w.is_empty() => w.into_iter().map(|w| w.path).collect(),
            _ => vec![root],
        },
        _ => vec![cwd],
    };
    fn list<T: Serialize>(r: Result<Vec<T>, String>) -> serde_json::Value {
        r.ok().and_then(|v| serde_json::to_value(v).ok()).unwrap_or_else(|| serde_json::json!([]))
    }
    // Independent lists: gathered together, so a cold cache costs the slowest one, not their sum.
    let (claude, codex, vibe, opencode) = tokio::join!(
        crate::agents::claude_history::list_claude_sessions(app.clone(), roots.clone()),
        crate::agents::list_codex_sessions(app.clone(), Some(false)),
        crate::vibe::list_vibe_sessions(app.clone(), Some(false)),
        crate::opencode_db::list_opencode_sessions(app, Some(false)),
    );
    let (claude, codex, vibe, opencode) = (list(claude), list(codex), list(vibe), list(opencode));
    Ok(serde_json::json!({ "roots": roots, "claude": claude, "codex": codex, "vibe": vibe, "opencode": opencode }))
}

impl Conn {
    pub(super) async fn handle(&mut self, msg: ClientMsg) {
        match msg {
            ClientMsg::ProviderAuth { request_id, request } => self.provider_auth(request_id, request),
            ClientMsg::Hello { caps } => self.auth_supported = caps.iter().any(|cap| cap == "providerAuth"),
            ClientMsg::Auth { .. } | ClientMsg::Pair { .. } => {}
            ClientMsg::Ping => self.send(ServerMsg::Pong),
            ClientMsg::List => {
                let tabs = self.shared.latest_tabs();
                self.last_tabs = tabs.clone();
                self.send(ServerMsg::Tabs { tabs });
            }
            ClientMsg::Background { on } => self.set_background(on),
            ClientMsg::Open { pty_id, cols, rows } => {
                self.prune_subs();
                if self.subs.len() >= MAX_SUBS && !self.subs.contains_key(&pty_id) {
                    self.error(tr("Troppi terminali aperti", "Too many open terminals"), Some(pty_id));
                    return;
                }
                if let Some(old) = self.subs.remove(&pty_id) {
                    old.abort();
                }
                // Size first: the window then resizes its terminal before the
                // snapshot request that follows reaches it.
                if let (Some(cols), Some(rows)) = (cols, rows) {
                    self.shared.claim_size(&pty_id, self.id, cols, rows);
                }
                let task = tokio::spawn(stream_pty(Arc::clone(&self.shared), pty_id.clone(), self.out_tx.clone()));
                self.subs.insert(pty_id, task);
            }
            ClientMsg::Resize { pty_id, cols, rows } => {
                // Only a tab this phone has open (and so may be sizing).
                if self.subs.contains_key(&pty_id) {
                    self.shared.claim_size(&pty_id, self.id, cols, rows);
                }
            }
            ClientMsg::Close { pty_id } => {
                self.paused_ptys.retain(|id| *id != pty_id);
                if let Some(task) = self.subs.remove(&pty_id) {
                    task.abort();
                }
                self.shared.release_size(&pty_id, self.id);
            }
            ClientMsg::Input { pty_id, data } => {
                if data.len() > proto::MAX_INPUT_BYTES {
                    self.error(tr("Input troppo lungo", "Input too large"), Some(pty_id));
                } else {
                    // A prompt sent from the phone: the window's agent
                    // notifications must count it like an Enter typed there.
                    // A paste with line breaks inside doesn't count, only input
                    // that ends in Enter.
                    if data.ends_with('\r') {
                        if let Some(window) = self.shared.app.state::<PtyState>().owner_of(&pty_id) {
                            let _ = self.shared.app.emit_to(window.as_str(), EVT_SUBMIT, &pty_id);
                        }
                    }
                    self.input(pty_id, data);
                }
            }
            ClientMsg::Action { id, pty_id } => {
                if !self.shared.actions.borrow().iter().any(|a| a.id == id) {
                    self.error(tr("Azione sconosciuta", "Unknown action"), pty_id);
                    return;
                }
                let owner = pty_id.as_deref().and_then(|p| self.shared.app.state::<PtyState>().owner_of(p));
                let Some(window) = owner.or_else(|| self.shared.default_window()) else {
                    self.error(tr("Nessuna finestra aperta", "No window is open"), pty_id);
                    return;
                };
                let payload = serde_json::json!({ "id": id, "ptyId": pty_id });
                let _ = self.shared.app.emit_to(window.as_str(), EVT_RUN_ACTION, payload);
            }
            ClientMsg::Rename { pty_id, label } => {
                let label = label.trim();
                if label.is_empty() {
                    return;
                }
                if label.chars().count() > 128 {
                    self.error(tr("Nome troppo lungo", "Name too long"), Some(pty_id));
                    return;
                }
                let Some(window) = self.shared.app.state::<PtyState>().owner_of(&pty_id) else {
                    self.error(tr("Terminale non trovato", "Terminal not found"), Some(pty_id));
                    return;
                };
                let payload = serde_json::json!({ "ptyId": pty_id, "label": label });
                let _ = self.shared.app.emit_to(window.as_str(), EVT_RENAME_TAB, payload);
            }
            ClientMsg::CloseTab { pty_id } => {
                let Some(window) = self.shared.app.state::<PtyState>().owner_of(&pty_id) else {
                    self.error(tr("Terminale non trovato", "Terminal not found"), Some(pty_id));
                    return;
                };
                let payload = serde_json::json!({ "ptyId": pty_id });
                let _ = self.shared.app.emit_to(window.as_str(), EVT_CLOSE_TAB, payload);
            }
            ClientMsg::NewTab { cwd, cli, profile } => {
                let cwd = cwd.filter(|c| !c.trim().is_empty());
                if !self.new_target_ok(&cwd, cli.as_deref(), &profile) {
                    return;
                }
                let Some(window) = self.shared.default_window() else {
                    self.error(tr("Nessuna finestra aperta", "No window is open"), None);
                    return;
                };
                let payload = serde_json::json!({ "cwd": cwd, "cli": cli, "profile": profile });
                let _ = self.shared.app.emit_to(window.as_str(), EVT_NEW_TAB, payload);
            }
            ClientMsg::NewChat { cli, cwd, profile } => {
                let cwd = cwd.filter(|c| !c.trim().is_empty());
                if !self.new_target_ok(&cwd, Some(&cli), &profile) {
                    return;
                }
                let Some(window) = self.shared.default_window() else {
                    self.error(tr("Nessuna finestra aperta", "No window is open"), None);
                    return;
                };
                let payload = serde_json::json!({ "cwd": cwd, "cli": cli, "profile": profile });
                let _ = self.shared.app.emit_to(window.as_str(), EVT_NEW_CHAT, payload);
            }
            ClientMsg::ChatOpen { chat_id, after_seq } => {
                self.prune_subs();
                if chat_id.len() > MAX_ID_BYTES {
                    self.error(tr("Chat non trovata", "Chat not found"), None);
                    return;
                }
                if self.chat_subs.len() >= MAX_CHAT_SUBS && !self.chat_subs.contains_key(&chat_id) {
                    self.error(tr("Troppe chat aperte", "Too many open chats"), None);
                    return;
                }
                self.paused_chats.retain(|(id, _)| *id != chat_id);
                self.open_chat(chat_id, after_seq);
            }
            ClientMsg::ChatClose { chat_id } => {
                self.paused_chats.retain(|(id, _)| *id != chat_id);
                if let Some((task, _)) = self.chat_subs.remove(&chat_id) {
                    task.abort();
                }
            }
            ClientMsg::ChatPrompt { chat_id, text, request_id, attachments } => self.prompt(chat_id, text, request_id, attachments),
            ClientMsg::ChatCancel { chat_id } => {
                if chat_id.len() > MAX_ID_BYTES {
                    self.error(tr("Chat non trovata", "Chat not found"), None);
                } else {
                    self.spawn_chat(move |chats| chats.cancel(&chat_id));
                }
            }
            ClientMsg::ChatResume { chat_id, text } => {
                if chat_id.len() > MAX_ID_BYTES || text.as_ref().is_some_and(|t| t.len() > crate::chat::MAX_RESUME_TEXT_BYTES) {
                    self.error(tr("Chat non trovata", "Chat not found"), None);
                } else {
                    self.spawn_chat(move |chats| chats.update_resume(&chat_id, text));
                }
            }
            ClientMsg::ChatPermission { chat_id, request_id, option_id } => {
                let short = chat_id.len() <= MAX_ID_BYTES
                    && option_id.as_ref().is_none_or(|o| o.len() <= MAX_ID_BYTES)
                    && request_id.to_string().len() <= MAX_ID_BYTES;
                if short {
                    self.spawn_chat(move |chats| chats.permission(&chat_id, &request_id, option_id.as_deref()));
                } else {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                }
            }
            ClientMsg::ChatAsk { chat_id, request_id, action, content } => {
                let short = chat_id.len() <= MAX_ID_BYTES
                    && action.len() <= MAX_ID_BYTES
                    && request_id.to_string().len() <= MAX_ID_BYTES
                    && content.as_ref().is_none_or(|c| c.to_string().len() <= proto::MAX_INPUT_BYTES);
                if short {
                    self.spawn_chat(move |chats| chats.ask(&chat_id, &request_id, &action, content));
                } else {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                }
            }
            ClientMsg::ChatMode { chat_id, mode_id } => {
                if chat_id.len() > MAX_ID_BYTES || mode_id.is_empty() || mode_id.len() > MAX_ID_BYTES {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                    return;
                }
                let (app, out) = (self.shared.app.clone(), self.out_tx.clone());
                tauri::async_runtime::spawn(async move {
                    let result = app.state::<ChatState>().set_mode(&chat_id, mode_id).await;
                    if let Err(message) = result {
                        let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
                    }
                });
            }
            // As `ChatMode`; the new model reaches every view as a chat event
            // and the phones' list as a fresh `chats`.
            ClientMsg::ChatModel { chat_id, model_id } => {
                if chat_id.len() > MAX_ID_BYTES || model_id.is_empty() || model_id.len() > MAX_ID_BYTES {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                    return;
                }
                let (app, out) = (self.shared.app.clone(), self.out_tx.clone());
                tauri::async_runtime::spawn(async move {
                    let result = app.state::<ChatState>().set_model(&chat_id, model_id).await;
                    if let Err(message) = result {
                        let message = format!("{}: {message}", tr("Impossibile cambiare modello", "Couldn't change the model"));
                        let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
                    }
                });
            }
            // As `ChatModel`, for the thinking level.
            ClientMsg::ChatThought { chat_id, value } => {
                if chat_id.len() > MAX_ID_BYTES || value.is_empty() || value.len() > MAX_ID_BYTES {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                    return;
                }
                let (app, out) = (self.shared.app.clone(), self.out_tx.clone());
                tauri::async_runtime::spawn(async move {
                    let result = app.state::<ChatState>().set_thought(&chat_id, value).await;
                    if let Err(message) = result {
                        let message = format!("{}: {message}", tr("Impossibile cambiare il livello di ragionamento", "Couldn't change the thinking level"));
                        let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
                    }
                });
            }
            // As `ChatThought`, for the goal controls.
            ClientMsg::ChatGoal { chat_id, action } => {
                if chat_id.len() > MAX_ID_BYTES || !matches!(action.as_str(), "pause" | "resume" | "clear") {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                    return;
                }
                let (app, out) = (self.shared.app.clone(), self.out_tx.clone());
                tauri::async_runtime::spawn(async move {
                    let result = app.state::<ChatState>().goal_action(&chat_id, action).await;
                    if let Err(message) = result {
                        let message = format!("{}: {message}", tr("Impossibile controllare il goal", "Couldn't control the goal"));
                        let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
                    }
                });
            }
            ClientMsg::ChatTerminal { chat_id } => {
                let Some(chat) = self.chat(&chat_id) else { return };
                let _ = self.shared.app.emit_to(chat.window.as_str(), EVT_CHAT_TERMINAL, serde_json::json!({ "tabId": chat.tab_id }));
            }
            ClientMsg::TerminalChat { pty_id } => {
                let Some(window) = self.shared.app.state::<PtyState>().owner_of(&pty_id) else {
                    self.error(tr("Terminale non trovato", "Terminal not found"), Some(pty_id));
                    return;
                };
                let payload = serde_json::json!({ "ptyId": pty_id });
                let _ = self.shared.app.emit_to(window.as_str(), EVT_TERMINAL_CHAT, payload);
            }
            ClientMsg::ChatRename { chat_id, label } => {
                let label = label.trim();
                if label.is_empty() {
                    return;
                }
                if label.chars().count() > 128 {
                    self.error(tr("Nome troppo lungo", "Name too long"), None);
                    return;
                }
                let Some(chat) = self.chat(&chat_id) else { return };
                let payload = serde_json::json!({ "tabId": chat.tab_id, "label": label });
                let _ = self.shared.app.emit_to(chat.window.as_str(), EVT_CHAT_RENAME, payload);
            }
            ClientMsg::ChatCloseTab { chat_id } => {
                let Some(chat) = self.chat(&chat_id) else { return };
                let payload = serde_json::json!({ "tabId": chat.tab_id });
                let _ = self.shared.app.emit_to(chat.window.as_str(), EVT_CHAT_CLOSE, payload);
            }
            ClientMsg::TabOp { target, op } => {
                if let TabOp::Move { index } = &op {
                    if *index > 1000 {
                        return;
                    }
                }
                let (window, mut payload) = match target {
                    TabTarget::Pty { pty_id } => {
                        let Some(window) = self.shared.app.state::<PtyState>().owner_of(&pty_id) else {
                            self.error(tr("Terminale non trovato", "Terminal not found"), Some(pty_id));
                            return;
                        };
                        (window, serde_json::json!({ "ptyId": pty_id }))
                    }
                    TabTarget::Chat { chat_id } => {
                        let Some(chat) = self.chat(&chat_id) else { return };
                        (chat.window.clone(), serde_json::json!({ "tabId": chat.tab_id }))
                    }
                };
                payload["op"] = serde_json::to_value(&op).unwrap_or_default();
                let _ = self.shared.app.emit_to(window.as_str(), EVT_TAB_OP, payload);
            }
            ClientMsg::BrowserOp { op } => self.browser_op(op),
            ClientMsg::ChatClear { chat_id } => {
                let Some(chat) = self.chat(&chat_id) else { return };
                let _ = self.shared.app.emit_to(chat.window.as_str(), EVT_CHAT_CLEAR, serde_json::json!({ "chatId": chat_id }));
            }
            ClientMsg::Views => self.send_views(),
            ClientMsg::UpdateCheck => self.emit_update_event(EVT_UPDATE_CHECK),
            ClientMsg::UpdateInstall => {
                if !lock(&self.shared.config).allow_phone_update {
                    self.error(
                        tr(
                            "Aggiornamento da telefono non consentito: attivalo nelle impostazioni di accesso remoto del desktop",
                            "Updating from the phone is not allowed: enable it in the desktop's remote access settings",
                        ),
                        None,
                    );
                    return;
                }
                self.emit_update_event(EVT_UPDATE_INSTALL);
            }
            ClientMsg::ViewFile { view_id, path } => {
                if view_id.len() > MAX_ID_BYTES || path.len() > 1024 {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                } else {
                    self.send_view_file(view_id, path);
                }
            }
            ClientMsg::ChatImage { chat_id, id, path, url, request_id } => {
                let ok = chat_id.as_ref().map_or(true, |c| c.len() <= MAX_ID_BYTES)
                    && id.as_ref().map_or(true, |i| i.len() <= MAX_ID_BYTES)
                    && path.as_ref().map_or(true, |p| p.len() <= 4096)
                    && url.as_ref().map_or(true, |u| u.len() <= 2048)
                    && request_id.as_ref().is_none_or(|r| !r.is_empty() && r.len() <= MAX_ID_BYTES)
                    && [id.is_some(), path.is_some(), url.is_some()].into_iter().filter(|b| *b).count() == 1;
                if ok {
                    self.send_chat_image(chat_id, id, path, url, request_id);
                } else {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                }
            }
            ClientMsg::LinkPreview { url } => {
                if url.len() > LINK_URL_MAX_BYTES {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                } else {
                    self.send_link_preview(url);
                }
            }
            ClientMsg::McpIcon { chat_id, server } => {
                if server.len() > 200 {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                } else {
                    self.send_mcp_icon(chat_id, server);
                }
            }
            ClientMsg::AgentInsight { pty_id, chat_id } => {
                if pty_id.is_some() == chat_id.is_some() {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                } else {
                    self.send_agent_insight(pty_id, chat_id);
                }
            }
            ClientMsg::ChatCacheInfo { chat_id } => self.send_chat_cache_info(chat_id),
            ClientMsg::DictStart { session, language } => {
                dictation::start(&self.shared.app, self.id, self.out_tx.clone(), session, language)
            }
            ClientMsg::DictStop { session } => dictation::stop(self.id, &session),
            ClientMsg::DictCancel { session } => dictation::cancel(self.id, &session),
            ClientMsg::Set { key, value } => {
                if key.is_empty() || key.len() > 64 {
                    self.error(tr("Impostazione non valida", "Invalid setting"), None);
                    return;
                }
                if serde_json::to_string(&value).map_or(true, |text| text.len() > MAX_SET_BYTES) {
                    self.error(tr("Valore troppo grande", "Value too large"), None);
                    return;
                }
                // Global emit: every window's bridge applies it; the setters are
                // idempotent and the windows share localStorage.
                let _ = self.shared.app.emit(EVT_SET_SETTING, serde_json::json!({ "key": key, "value": value }));
            }
            ClientMsg::Profile { op, id, name, color, copy_settings, delete_files, cli } => {
                let short = |v: &Option<String>, max: usize| v.as_ref().is_none_or(|s| s.len() <= max);
                let ok = short(&id, 64) && short(&name, 64) && short(&color, 16) && short(&cli, 16);
                // Sign-in / out also take the default profile (`""`); the rest need a real one.
                let needs_id = matches!(op.as_str(), "update" | "delete");
                let needs_look = matches!(op.as_str(), "create" | "update");
                let valid = ok
                    && matches!(op.as_str(), "create" | "update" | "delete" | "login" | "logout")
                    && (!needs_id || id.as_deref().is_some_and(|s| !s.is_empty()))
                    && (needs_id || !matches!(op.as_str(), "login" | "logout") || id.is_some())
                    && (!needs_look || (name.as_deref().is_some_and(|s| !s.trim().is_empty()) && color.is_some()))
                    && (!matches!(op.as_str(), "login" | "logout") || cli.as_deref().is_some_and(crate::agents::registry::is_known));
                if !valid {
                    self.error(tr("Richiesta profilo non valida", "Invalid profile request"), None);
                    return;
                }
                // Only the leader window (the one that publishes the profiles) acts on it.
                let Some(window) = self.shared.default_window() else {
                    self.error(tr("Nessuna finestra aperta", "No window is open"), None);
                    return;
                };
                let payload = serde_json::json!({
                    "op": op, "id": id, "name": name, "color": color, "cli": cli,
                    "copySettings": copy_settings, "deleteFiles": delete_files,
                });
                let event = if op == "login" { EVT_PROFILE_LOGIN } else { EVT_PROFILE };
                let _ = self.shared.app.emit_to(window.as_str(), event, payload);
            }
            ClientMsg::Ls { pty_id, path } => self.spawn_fs(pty_id, move |root, pty_id| {
                list_dir(root, path.as_deref().unwrap_or("")).map(|(path, entries)| ServerMsg::Ls { pty_id, path, entries })
            }),
            ClientMsg::Read { pty_id, path } => self.spawn_fs(pty_id, move |root, pty_id| {
                read_text(root, &path).map(|(path, text, truncated)| ServerMsg::File { pty_id, path, text, truncated })
            }),
            ClientMsg::Fs { request_id, request } => {
                if request_id.len() > 128 { return; }
                let config = self.shared.app.path().app_config_dir().ok();
                let out = self.out_tx.clone();
                tauri::async_runtime::spawn(async move {
                    let result = crate::blocking(move || explorer::run(request, config.as_deref())).await;
                    let (response, error) = match result { Ok(r) => (Some(r), None), Err(e) => (None, Some(e)) };
                    let _ = out.send(ServerMsg::Fs { request_id, response, error }).await;
                });
            }
            ClientMsg::Git { request_id, request } => {
                if request_id.len() > MAX_ID_BYTES { return; }
                let out = self.out_tx.clone();
                tauri::async_runtime::spawn(async move {
                    let (result, error) = match run_git(request).await { Ok(v) => (Some(v), None), Err(e) => (None, Some(e)) };
                    let _ = out.send(ServerMsg::Git { request_id, result, error }).await;
                });
            }
            ClientMsg::History { request_id, cwd } => {
                if request_id.len() > MAX_ID_BYTES { return; }
                let app = self.shared.app.clone();
                let out = self.out_tx.clone();
                tauri::async_runtime::spawn(async move {
                    let (result, error) = match run_history(app, cwd).await { Ok(v) => (Some(v), None), Err(e) => (None, Some(e)) };
                    let _ = out.send(ServerMsg::History { request_id, result, error }).await;
                });
            }
            ClientMsg::Stats { request_id, today_start } => {
                if request_id.len() > MAX_ID_BYTES { return; }
                let app = self.shared.app.clone();
                let out = self.out_tx.clone();
                tauri::async_runtime::spawn(async move {
                    let reply = match crate::spend::activity_stats(app, Some(today_start)).await {
                        Ok(v) => (serde_json::to_value(v).ok(), None),
                        Err(e) => (None, Some(e)),
                    };
                    let _ = out.send(ServerMsg::Stats { request_id, result: reply.0, error: reply.1 }).await;
                });
            }
            ClientMsg::Resume { cwd, session_id, cli, wsl_distro, profile, view } => {
                let bad = |s: &str, max: usize| s.is_empty() || s.len() > max || s.chars().any(|c| c.is_control());
                if bad(&cwd, 4096) || bad(&session_id, 256) || wsl_distro.as_deref().is_some_and(|d| bad(d, 128)) {
                    self.error(tr("Sessione non valida", "Invalid session"), None);
                    return;
                }
                // The folder may be a WSL path, so only the agent and profile are checked here.
                if !self.new_target_ok(&None, Some(&cli), &profile) {
                    return;
                }
                let Some(window) = self.shared.default_window() else {
                    self.error(tr("Nessuna finestra aperta", "No window is open"), None);
                    return;
                };
                let view = view.filter(|v| v == "chat" || v == "terminal");
                let payload = serde_json::json!({ "cwd": cwd, "sessionId": session_id, "cli": cli, "wslDistro": wsl_distro, "profile": profile, "view": view });
                let _ = self.shared.app.emit_to(window.as_str(), EVT_RESUME_SESSION, payload);
            }
        }
    }

    /// Runs a filesystem request rooted at the tab's working directory on the
    /// blocking pool and queues the reply (or an error).
    pub(super) fn spawn_fs<F>(&self, pty_id: String, work: F)
    where
        F: FnOnce(&Path, String) -> Result<ServerMsg, String> + Send + 'static,
    {
        let cwd = self.shared.app.state::<crate::windows::WindowTabs>().cwd_of(&pty_id);
        let out = self.out_tx.clone();
        tauri::async_runtime::spawn(async move {
            let result = match cwd {
                None => Err(tr("Terminale non trovato", "Terminal not found").to_string()),
                Some(cwd) => {
                    let id = pty_id.clone();
                    crate::blocking(move || work(Path::new(&cwd), id)).await
                }
            };
            // A reply that doesn't fit the queue is dropped: the phone isn't reading.
            let _ = out.try_send(match result {
                Ok(msg) => msg,
                Err(message) => ServerMsg::Error { message, pty_id: Some(pty_id), fatal: false },
            });
        });
    }
}

const BROWSER_URL_MAX: usize = 4096;
const BROWSER_ID_MAX: usize = 64;

/// An http(s) URL a phone may open or navigate a shared browser tab to.
pub(super) fn browser_url_ok(url: &str) -> bool {
    if url.is_empty() || url.len() > BROWSER_URL_MAX || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    let lower = url.to_ascii_lowercase();
    ["http://", "https://"].iter().any(|p| lower.starts_with(p) && lower.len() > p.len())
}

/// A page, tab or nonce id: not empty, at most 64 bytes.
pub(super) fn browser_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= BROWSER_ID_MAX
}

/// The path of an `openFile` as `/`-separated relative segments: `\` becomes `/`,
/// `.` and empty segments are dropped. `None` for an absolute path, a drive
/// letter, a `..` segment or nothing at all.
pub(super) fn browser_relative_path(path: &str) -> Option<String> {
    if path.is_empty() || path.len() > BROWSER_URL_MAX || path.contains('\0') {
        return None;
    }
    let path = path.replace('\\', "/");
    let bytes = path.as_bytes();
    if path.starts_with('/') || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':') {
        return None;
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => return None,
            p => parts.push(p),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Checks the fields of a phone's `BrowserOp` that don't depend on desktop state.
/// The error is the (Italian, English) text to report.
pub(super) fn check_browser_op(op: &proto::BrowserOp) -> Result<(), (&'static str, &'static str)> {
    use proto::BrowserOp as O;
    const BAD_URL: (&str, &str) = ("Indirizzo non valido (solo http e https)", "Invalid address (http and https only)");
    const BAD_ID: (&str, &str) = ("Pagina non valida", "Invalid page");
    const BAD_NONCE: (&str, &str) = ("Richiesta non valida", "Invalid request");
    match op {
        O::OpenUrl { url, nonce } => {
            if !browser_url_ok(url) {
                return Err(BAD_URL);
            }
            if nonce.len() > BROWSER_ID_MAX {
                return Err(BAD_NONCE);
            }
        }
        O::OpenFile { path, nonce, .. } => {
            if browser_relative_path(path).is_none() {
                return Err(("Percorso non valido", "Invalid path"));
            }
            if nonce.len() > BROWSER_ID_MAX {
                return Err(BAD_NONCE);
            }
        }
        O::Close { id } | O::Back { id } | O::Forward { id } => {
            if !browser_id_ok(id) {
                return Err(BAD_ID);
            }
        }
        O::Navigate { id, url } => {
            if !browser_id_ok(id) {
                return Err(BAD_ID);
            }
            if !browser_url_ok(url) {
                return Err(BAD_URL);
            }
        }
    }
    Ok(())
}

impl Conn {
    /// A phone's change to the shared browser tabs: checked here, then passed to
    /// the windows (the leader one applies it).
    pub(super) fn browser_op(&self, op: proto::BrowserOp) {
        use proto::BrowserOp as O;
        if let Err((it, en)) = check_browser_op(&op) {
            self.error(tr(it, en), None);
            return;
        }
        let payload = match op {
            O::OpenUrl { url, nonce } => serde_json::json!({ "op": "openUrl", "url": url, "nonce": nonce }),
            O::OpenFile { root, path, nonce } => {
                let cwd = match root {
                    proto::BrowserRoot::Chat { chat_id } => {
                        let Some(chat) = self.chat(&chat_id) else { return };
                        chat.cwd
                    }
                    proto::BrowserRoot::Pty { pty_id } => {
                        let Some(tab) = self.shared.latest_tabs().into_iter().find(|t| t.pty_id == pty_id) else {
                            self.error(tr("Terminale non trovato", "Terminal not found"), Some(pty_id));
                            return;
                        };
                        tab.cwd
                    }
                };
                let Some(rel) = browser_relative_path(&path) else { return };
                if cwd.is_empty() {
                    self.error(tr("Cartella non disponibile", "Folder not available"), None);
                    return;
                }
                let file = PathBuf::from(cwd).join(rel);
                serde_json::json!({ "op": "openFile", "path": file.to_string_lossy(), "nonce": nonce })
            }
            O::Close { id } => serde_json::json!({ "op": "close", "id": id }),
            O::Back { id } => serde_json::json!({ "op": "back", "id": id }),
            O::Forward { id } => serde_json::json!({ "op": "forward", "id": id }),
            O::Navigate { id, url } => serde_json::json!({ "op": "navigate", "id": id, "url": url }),
        };
        let _ = self.shared.app.emit(EVT_BROWSER_OP, payload);
    }
}

#[cfg(test)]
mod browser_op_tests {
    use super::*;
    use proto::{BrowserOp as O, BrowserRoot};

    #[test]
    fn urls_are_http_or_https_and_bounded() {
        assert!(browser_url_ok("http://localhost:3000/x"));
        assert!(browser_url_ok("HTTPS://example.com"));
        for bad in ["", "http://", "javascript:alert(1)", "file:///C:/x", "ftp://a.b", "example.com", "https://a b", "https://a\n.b"] {
            assert!(!browser_url_ok(bad), "{bad:?}");
        }
        assert!(!browser_url_ok(&format!("https://a.b/{}", "x".repeat(BROWSER_URL_MAX))));
    }

    #[test]
    fn relative_paths_are_normalized_and_confined() {
        assert_eq!(browser_relative_path("a\\b/c.html").as_deref(), Some("a/b/c.html"));
        assert_eq!(browser_relative_path("./a//b.html").as_deref(), Some("a/b.html"));
        for bad in ["", ".", "/etc/passwd", "\\a", "C:\\x", "c:/x", "C:x", "../a", "a/../b", "a\\..\\b", "a\0b"] {
            assert_eq!(browser_relative_path(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn ops_are_checked() {
        let root = || BrowserRoot::Chat { chat_id: "c".into() };
        assert!(check_browser_op(&O::OpenUrl { url: "https://a.b".into(), nonce: "n".into() }).is_ok());
        assert!(check_browser_op(&O::OpenUrl { url: "https://a.b".into(), nonce: "n".repeat(65) }).is_err());
        assert!(check_browser_op(&O::OpenUrl { url: "file:///x".into(), nonce: "n".into() }).is_err());
        assert!(check_browser_op(&O::OpenFile { root: root(), path: "a.html".into(), nonce: "n".into() }).is_ok());
        assert!(check_browser_op(&O::OpenFile { root: root(), path: "../a.html".into(), nonce: "n".into() }).is_err());
        assert!(check_browser_op(&O::Close { id: "p".into() }).is_ok());
        assert!(check_browser_op(&O::Back { id: "p".repeat(65) }).is_err());
        assert!(check_browser_op(&O::Forward { id: String::new() }).is_err());
        assert!(check_browser_op(&O::Navigate { id: "p".into(), url: "http://localhost:1".into() }).is_ok());
        assert!(check_browser_op(&O::Navigate { id: "p".into(), url: "data:text/html,x".into() }).is_err());
    }
}
