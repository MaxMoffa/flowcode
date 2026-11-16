//! What a connection answers on request: views, previews, insights, chat calls.

use super::*;

impl Conn {
    /// Lists the agent view plugins for the phone. Reading and hashing the
    /// packages happens on the blocking pool, and `viewfile` chunks reuse the hashes.
    pub(super) fn send_views(&self) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let app = shared.app.clone();
            match crate::blocking(move || views::list(&app)).await {
                Ok(views) => {
                    *lock(&shared.view_hashes) = views.iter().map(|v| (v.id.clone(), v.hash.clone())).collect();
                    let _ = out.try_send(ServerMsg::Views { views });
                }
                Err(message) => {
                    let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
                }
            }
        });
    }

    /// Sends one file of a view plugin, in chunks.
    pub(super) fn send_view_file(&self, view_id: String, path: String) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let app = shared.app.clone();
            let known = lock(&shared.view_hashes).get(&view_id).cloned();
            let (id, file) = (view_id.clone(), path.clone());
            match crate::blocking(move || views::read_file(&app, &id, &file, known)).await {
                Ok((hash, bytes)) => {
                    lock(&shared.view_hashes).insert(view_id.clone(), hash.clone());
                    views::send_file(&out, &view_id, &hash, &path, &bytes).await;
                }
                Err(message) => {
                    let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
                }
            }
        });
    }

    /// Answers a `chatimage`: the stored image `id`, or the file `path` the
    /// agent mentioned (resolved in the chat's folder), or the web image `url`
    /// (only if the desktop's "chatWebImages" setting is on), as chunks - or one
    /// `missing` message if it can't be read.
    pub(super) fn send_chat_image(&self, chat_id: Option<String>, id: Option<String>, path: Option<String>, url: Option<String>, request_id: Option<String>) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let key = request_id.or_else(|| id.clone()).or_else(|| path.clone()).or_else(|| url.clone()).unwrap_or_default();
            let web_images = shared.settings.borrow().get("chatWebImages").and_then(|v| v.as_bool()) == Some(true);
            let app = shared.app.clone();
            let read = crate::blocking(move || match (id, path, url) {
                (Some(id), _, _) => crate::chat_images::read(&id).map(|bytes| (bytes, None)),
                (None, Some(path), _) => {
                    let file = app.state::<ChatState>().image_file(chat_id.as_deref(), &path)?;
                    let bytes = crate::chat_images::read_file(&file)?;
                    Ok((bytes, Some(crate::chat_images::mime_of(&file).to_string())))
                }
                (None, None, Some(url)) if web_images => {
                    crate::link_preview::fetch_chat_image(url.trim()).map(|(bytes, mime)| (bytes, Some(mime)))
                }
                _ => Err("no image".to_string()),
            })
            .await;
            match read {
                Ok((bytes, mime)) => {
                    chat::send_image(&out, &key, mime.as_deref(), &bytes).await;
                }
                Err(_) => {
                    let _ = out.send(ServerMsg::ChatImage { key, offset: 0, total: 0, data: String::new(), mime: None, missing: true }).await;
                }
            }
        });
    }

    /// Answers a `linkpreview`: the page's preview, or none if the desktop's
    /// link preview setting is "never" or the page has nothing to show.
    pub(super) fn send_link_preview(&self, url: String) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let never = shared.settings.borrow().get("linkPreviews").and_then(|v| v.as_str()) == Some("never");
            let preview = if never { None } else { crate::link_preview::link_preview(url.clone()).await.ok() };
            // A reply is one frame: the pictures go first if it would not fit.
            let preview = preview.and_then(|p| serde_json::to_value(p.fit(LINK_PREVIEW_MAX_BYTES)).ok());
            let _ = out.send(ServerMsg::LinkPreview { url, preview }).await;
        });
    }

    /// Answers an `mcpicon`: the icon of the service behind an MCP server, or
    /// none if the desktop's setting is off or no icon was found.
    pub(super) fn send_mcp_icon(&self, chat_id: Option<String>, server: String) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let off = shared.settings.borrow().get("chatMcpIcons").and_then(|v| v.as_bool()) == Some(false);
            let icon = if off {
                None
            } else {
                let (app, name) = (shared.app.clone(), server.clone());
                tauri::async_runtime::spawn_blocking(move || crate::mcp_icons::icon(&app, chat_id.as_deref(), &name)).await.ok().flatten()
            };
            let _ = out.send(ServerMsg::McpIcon { server, icon }).await;
        });
    }

    /// Answers an `agentinsight`: the context, usage and tools of a terminal
    /// tab's agent (`pty_id`) or of a chat's (`chat_id`). What can't be read is
    /// left out.
    pub(super) fn send_agent_insight(&self, pty_id: Option<String>, chat_id: Option<String>) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let key = pty_id.clone().or_else(|| chat_id.clone()).unwrap_or_default();
            // (cli, session id, profile, folder, inside WSL)
            let target: Option<(String, Option<String>, Option<String>, String, bool)> = if let Some(pty) = pty_id {
                let sessions = crate::agents::collect_agent_sessions(&shared.app).await.unwrap_or_default();
                sessions.into_iter().find(|s| s.pty_id == pty).map(|s| {
                    let wsl = s.wsl_distro.is_some();
                    let cwd = s.cwd.clone().or_else(|| s.tab_cwd.clone()).unwrap_or_default();
                    (s.cli.clone(), s.session_id.clone(), s.profile.clone(), cwd, wsl)
                })
            } else {
                let chats = shared.app.state::<ChatState>().list();
                chats
                    .into_iter()
                    .find(|c| Some(c.chat_id.as_str()) == chat_id.as_deref())
                    .map(|c| (c.agent.clone(), c.session_id.clone(), c.profile.clone(), c.cwd.clone(), false))
            };
            let Some((cli, session_id, profile, cwd, wsl)) = target else {
                let _ = out.send(ServerMsg::AgentInsight { key, cli: None, context: None, usage: None, tools: None }).await;
                return;
            };
            let app = shared.app.clone();
            let read_cli = cli.clone();
            let read = crate::blocking(move || {
                let reads_session = crate::agents::registry::reads_sessions(&read_cli) && !wsl;
                let session = if reads_session { session_id } else { None };
                let context = session.as_deref().and_then(|id| {
                    crate::context::read_context(&app, &read_cli, id, profile.clone())
                        .ok()
                        .flatten()
                        .map(|c| TabContext { used: c.used, window: c.window, model: c.model })
                });
                let usage = session
                    .as_deref()
                    .and_then(|id| crate::agent_insight::read_usage(&app, &read_cli, id, profile.clone()).ok())
                    .and_then(|u| serde_json::to_value(u).ok());
                let tools = if wsl {
                    None
                } else {
                    crate::agent_insight::read_tools(&app, &read_cli, &cwd, profile).ok().and_then(|t| serde_json::to_value(t).ok())
                };
                Ok((context, usage, tools))
            })
            .await;
            let (context, usage, mut tools) = read.unwrap_or((None, None, None));
            // A reply is one frame: the long lists are cut if it would not fit.
            if let Some(value) = tools.as_mut() {
                if serde_json::to_string(value).map_or(false, |text| text.len() > AGENT_INSIGHT_TOOLS_MAX_BYTES) {
                    for list in ["skills", "mcp"] {
                        if let Some(items) = value.get_mut(list).and_then(|v| v.as_array_mut()) {
                            items.truncate(AGENT_INSIGHT_LIST_KEEP);
                        }
                    }
                }
            }
            let _ = out.send(ServerMsg::AgentInsight { key, cli: Some(cli), context, usage, tools }).await;
        });
    }

    /// Answers a `chatcacheinfo`: the prompt-cache lifetime and last model call
    /// of a Claude chat, read from its transcript. Both are left out when
    /// unreadable (not Claude, no session, no transcript).
    pub(super) fn send_chat_cache_info(&self, chat_id: String) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let chat = shared.app.state::<ChatState>().list().into_iter().find(|c| c.chat_id == chat_id);
            let info = match chat {
                Some(c) if c.agent == "claude" => match c.session_id {
                    Some(sid) => {
                        let app = shared.app.clone();
                        crate::blocking(move || crate::agent_insight::read_cache_info(&app, &sid, c.profile, c.wsl_distro)).await.ok()
                    }
                    None => None,
                },
                _ => None,
            };
            let (ttl_ms, last_call_at) = match info {
                Some(i) => (Some(i.ttl_ms), i.last_call_at),
                None => (None, None),
            };
            let _ = out.send(ServerMsg::ChatCacheInfo { chat_id, ttl_ms, last_call_at }).await;
        });
    }

    /// Runs a call on a chat on the blocking pool (it writes to the agent) and
    /// reports a failure to the phone.
    pub(super) fn spawn_chat<F>(&self, work: F)
    where
        F: FnOnce(&ChatState) -> Result<(), String> + Send + 'static,
    {
        let (app, out) = (self.shared.app.clone(), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let result = crate::blocking(move || work(&app.state::<ChatState>())).await;
            if let Err(message) = result {
                let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
            }
        });
    }

    /// A receipt survives the connection, so a retry cannot start a second turn.
    pub(super) fn prompt(&self, chat_id: String, text: String, request_id: Option<String>, attachments: Vec<proto::ChatAttachmentRef>) {
        let Some(device) = lock(&self.shared.conns).get(&self.id).map(|c| c.device_id.clone()) else { return };
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let result = if text.len() > proto::MAX_INPUT_BYTES || (text.trim().is_empty() && attachments.is_empty()) || attachments.len() > 16 || chat_id.len() > MAX_ID_BYTES {
                Err(tr("Messaggio non valido", "Invalid message").to_string())
            } else {
                let (app, id, message) = (shared.app.clone(), chat_id.clone(), text.clone());
                let refs = attachments;
                let work = || crate::blocking(move || {
                    let resolved = refs.iter().map(|r| crate::chat::uploaded_attachment(&r.id, &r.name, &r.mime)).collect::<Result<Vec<_>, _>>()?;
                    app.state::<ChatState>().prompt(&id, message, resolved)
                });
                match request_id.as_deref() {
                    Some(id) => shared.prompt_receipts.run(&device, &chat_id, id, &text, work).await,
                    None => work().await,
                }
            };
            let reply = match request_id {
                Some(request_id) => Some(ServerMsg::ChatPromptAck { chat_id, request_id, message: result.err() }),
                None => result.err().map(|message| ServerMsg::Error { message, pty_id: None, fatal: false }),
            };
            if let Some(reply) = reply { let _ = out.send(reply).await; }
        });
    }

    /// The chat with that id, as the phone lists it; reports an unknown one.
    pub(super) fn chat(&self, chat_id: &str) -> Option<ChatInfo> {
        let chat = self.shared.chat_infos().into_iter().find(|c| c.chat_id == chat_id);
        if chat.is_none() {
            self.error(tr("Chat non trovata", "Chat not found"), None);
        }
        chat
    }

    /// Whether the folder, agent and profile of a `newtab` / `newchat` make
    /// sense; tells the phone what doesn't.
    pub(super) fn new_target_ok(&self, cwd: &Option<String>, cli: Option<&str>, profile: &Option<String>) -> bool {
        if cli.is_some_and(|c| !crate::agents::registry::is_known(c)) {
            self.error(tr("Agente sconosciuto", "Unknown agent"), None);
            return false;
        }
        if cwd.as_deref().is_some_and(|c| {
            let path = std::path::Path::new(c);
            c.len() > 4096 || !crate::fs::is_local_path(path, false) || !crate::fs::links_stay_local(path) || !path.is_dir()
        }) {
            self.error(tr("Cartella non trovata sul computer", "Folder not found on the computer"), None);
            return false;
        }
        if profile.as_deref().is_some_and(|p| p.len() > 128) {
            self.error(tr("Profilo non valido", "Invalid profile"), None);
            return false;
        }
        true
    }

    /// Queues keystrokes for `pty_id`, in order. `PtyState::write` only
    /// enqueues (the session's writer thread does the blocking write), so it
    /// runs inline; a pty that can't take more (or is gone) is reported.
    pub(super) fn input(&mut self, pty_id: String, data: String) {
        let result = self.shared.app.state::<PtyState>().write(&pty_id, &data);
        if let Err(message) = result {
            let recent = self
                .input_error_at
                .as_ref()
                .is_some_and(|(id, at)| *id == pty_id && at.elapsed() < INPUT_ERROR_QUIET);
            if !recent {
                self.input_error_at = Some((pty_id.clone(), Instant::now()));
                self.error(&message, Some(pty_id));
            }
        }
    }
}
