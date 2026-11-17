//! The tab and chat lists, and the notifications built from them.

use super::*;

impl Shared {
    // ---- tabs --------------------------------------------------------------

    /// The latest tab list, never scanning: empty until the first build.
    pub(super) fn latest_tabs(&self) -> Vec<Tab> {
        self.tabs.borrow().as_ref().map(|(_, tabs)| tabs.clone()).unwrap_or_default()
    }

    /// Rebuilds the tab list unless one younger than `max_age` exists (a
    /// concurrent caller's counts), and returns the latest. This is where the
    /// process scan happens; only `tabs_task` and a new connection call it,
    /// never the loop that serves a phone's input.
    pub(super) async fn refresh_tabs(&self, max_age: Duration) -> Vec<Tab> {
        let _building = self.tabs_build.lock().await;
        let fresh = self.tabs.borrow().as_ref().is_some_and(|(at, _)| at.elapsed() < max_age);
        if !fresh {
            let tabs = self.build_tabs().await;
            self.sync_size_owners(&tabs);
            self.tabs.send_replace(Some((Instant::now(), tabs)));
        }
        self.latest_tabs()
    }

    /// Whether a phone is connected (admitted, past its handshake).
    pub(super) fn has_conns(&self) -> bool {
        !lock(&self.conns).is_empty()
    }

    /// `WindowTabs` entries that have a live pty, joined with the agent running
    /// in each (same source as the Agents panel) and its context fill.
    pub(super) async fn build_tabs(&self) -> Vec<Tab> {
        let app = &self.app;
        let sizes = app.state::<PtyState>().sizes();
        let sessions = crate::agents::collect_agent_sessions(app).await.unwrap_or_default();
        let contexts = self.contexts_for(&sessions).await;
        let agents: HashMap<String, (String, Option<String>, Option<String>, Option<String>)> =
            sessions.into_iter().map(|s| (s.pty_id, (s.cli, s.status, s.profile, s.session_id))).collect();
        app.state::<crate::windows::WindowTabs>()
            .list()
            .into_iter()
            .filter_map(|(window, tab)| {
                let pty_id = tab.pty_id?;
                let (cols, rows) = *sizes.get(&pty_id)?;
                let (cli, status, profile, session_id) = match agents.get(&pty_id) {
                    Some((cli, status, profile, session_id)) => (Some(cli.clone()), status.clone(), profile.clone(), session_id.clone()),
                    None => (None, None, None, None),
                };
                let context = contexts.get(&pty_id).cloned().flatten();
                Some(Tab { pty_id, tab_id: tab.tab_id, window, label: tab.label, cwd: tab.cwd, cli, profile, session_id, status, cols, rows, context, order: tab.index, notify: tab.notify })
            })
            .collect()
    }

    /// The running chats that have a tab (one reported by its window), in the
    /// order the windows report them. A chat is matched to its tab by agent
    /// session: the frontend knows the tab, the backend the chat, and both know
    /// the session.
    pub(super) fn chat_infos(&self) -> Vec<ChatInfo> {
        let chats = self.app.state::<ChatState>().list();
        self.app
            .state::<crate::windows::WindowTabs>()
            .list_chats()
            .into_iter()
            .filter_map(|(window, tab)| {
                let chat = chats.iter().find(|c| c.session_id.as_deref() == Some(tab.session_id.as_str()))?;
                Some(ChatInfo {
                    chat_id: chat.chat_id.clone(),
                    tab_id: tab.tab_id,
                    window,
                    label: tab.label,
                    agent: chat.agent.clone(),
                    cwd: chat.cwd.clone(),
                    profile: chat.profile.clone(),
                    session_id: chat.session_id.clone(),
                    status: Some(chat.status.as_str().to_string()),
                    modes: chat.modes.clone(),
                    models: chat.models.clone(),
                    thought: chat.thought.clone(),
                    order: tab.index,
                    notify: None,
                    active_at: Some(chat.status_at),
                })
            })
            .collect()
    }

    /// Tells the phones a chat needs them: an agent waiting for a permission
    /// answer, or one that finished its turn.
    pub(super) fn notify_chat(&self, alert: ChatAlert) {
        let chat = self.chat_infos().into_iter().find(|c| c.session_id.as_deref() == Some(alert.session_id.as_str()));
        let folder = chat
            .as_ref()
            .and_then(|c| Path::new(&c.cwd).file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let agent = agent_name(&alert.agent);
        let (title, body) = match alert.kind {
            AlertKind::Permission { tool } => {
                (format!("{agent} {}", tr("chiede un permesso", "asks for permission")), if tool.is_empty() { folder } else { tool })
            }
            AlertKind::Done => (format!("{agent} {}", tr("ha finito", "is done")), folder),
        };
        let _ = self.notices.send(ServerMsg::Notify { title, body, tab_id: chat.map(|c| c.tab_id) });
    }

    /// Context fill of the claude/codex tabs, each recomputed at most every
    /// `CONTEXT_CACHE`.
    pub(super) async fn contexts_for(&self, sessions: &[crate::agents::AgentSession]) -> HashMap<String, Option<TabContext>> {
        let wanted: Vec<_> = sessions
            .iter()
            .filter(|s| crate::agents::registry::reads_sessions(&s.cli))
            .filter_map(|s| Some((s.pty_id.clone(), s.cli.clone(), s.session_id.clone()?, s.profile.clone())))
            .collect();
        let stale: Vec<_> = {
            let mut cache = lock(&self.context_cache);
            // Tabs that are gone take their entry with them.
            cache.retain(|pty, _| wanted.iter().any(|(p, ..)| p == pty));
            wanted
                .iter()
                .filter(|(pty, ..)| cache.get(pty).is_none_or(|(at, _)| at.elapsed() >= CONTEXT_CACHE))
                .cloned()
                .collect()
        };
        if !stale.is_empty() {
            let app = self.app.clone();
            let fresh = crate::blocking(move || {
                Ok(stale
                    .into_iter()
                    .map(|(pty, cli, session, profile)| {
                        let context = crate::context::read_context(&app, &cli, &session, profile)
                            .ok()
                            .flatten()
                            .map(|c| TabContext { used: c.used, window: c.window, model: c.model });
                        (pty, context)
                    })
                    .collect::<Vec<_>>())
            })
            .await
            .unwrap_or_default();
            let mut cache = lock(&self.context_cache);
            for (pty, context) in fresh {
                cache.insert(pty, (Instant::now(), context));
            }
        }
        lock(&self.context_cache).iter().map(|(pty, (_, c))| (pty.clone(), c.clone())).collect()
    }

    /// The window an action without a specific tab runs in.
    pub(super) fn default_window(&self) -> Option<String> {
        if self.app.get_webview_window("main").is_some() {
            return Some("main".to_string());
        }
        let mut labels: Vec<String> = self.app.webview_windows().into_keys().collect();
        labels.sort();
        labels.into_iter().next()
    }
}
