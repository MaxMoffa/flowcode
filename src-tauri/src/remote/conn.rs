//! One authenticated connection: its loop and the state it carries.

use super::*;

pub(super) async fn run_connection(
    shared: Arc<Shared>,
    connection: &Connection,
    mut shutdown: watch::Receiver<bool>,
    admitted: Admitted,
) -> String {
    let Admitted { device, token, send, recv } = admitted;
    shared.touch_device(&device.id);
    // A new pairing was announced when confirmed.
    if token.is_none() && shared.is_fresh_connect(&device.id) {
        let body = format!("{} {}", device.name, tr("ha aperto l'accesso remoto", "opened remote access"));
        shared.notify(tr("Dispositivo connesso", "Device connected").to_string(), body);
    }

    let (kick_tx, mut kick_rx) = watch::channel(None);
    let conn_id = shared.register_conn(&device.id, kick_tx, connection);

    let (out_tx, out_rx) = mpsc::channel::<ServerMsg>(OUT_QUEUE);
    let compress = Arc::new(AtomicBool::new(false));
    let mut writer = tokio::spawn(write_task(send, out_rx, Arc::clone(&compress)));
    let (in_tx, mut in_rx) = mpsc::channel::<ClientMsg>(IN_QUEUE);
    let reader = tokio::spawn(read_task(recv, in_tx, out_tx.clone(), compress));
    // Every stream after the control one is a preview stream (in-app browser).
    let previews = preview::spawn_accept_loop(connection.clone(), Arc::clone(&shared), conn_id);

    let mut tabs_rx = shared.tabs.subscribe();
    let mut usage_rx = shared.usage.subscribe();
    let mut actions_rx = shared.actions.subscribe();
    let mut settings_rx = shared.settings.subscribe();
    let mut browser_tabs_rx = shared.browser_tabs.subscribe();
    let mut update_rx = shared.update.subscribe();
    let mut profiles_rx = shared.profiles.subscribe();
    let mut notices_rx = shared.notices.subscribe();
    let mut chats_rx = shared.app.state::<ChatState>().watch_changes();
    let mut conn = Conn {
        shared: Arc::clone(&shared),
        id: conn_id,
        out_tx,
        overflow: AtomicBool::new(false),
        subs: HashMap::new(),
        chat_subs: HashMap::new(),
        paused_chats: Vec::new(),
        paused_ptys: Vec::new(),
        last_tabs: Vec::new(),
        last_chats: Vec::new(),
        background: false,
        input_error_at: None,
        auth_alive: Arc::new(AtomicBool::new(true)),
        auth_requests: Arc::new(AtomicUsize::new(0)),
        auth_supported: false,
        resized_supported: false,
    };
    if let Some(token) = token {
        conn.send(ServerMsg::Paired { token, device_name: device.name.clone() });
    }
    conn.send(ServerMsg::Ready {
        device_name: device.name.clone(),
        host_name: shared.host_name.clone(),
        app_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        proto: Some(proto::PROTOCOL_VERSION),
        caps: proto::CAPABILITIES.iter().map(|c| c.to_string()).collect(),
    });
    conn.send(ServerMsg::Usage { items: usage_rx.borrow_and_update().clone() });
    conn.send(ServerMsg::Actions { actions: actions_rx.borrow_and_update().clone() });
    let settings = settings_rx.borrow_and_update().clone();
    if !settings.is_null() {
        conn.send(ServerMsg::Settings { settings });
    }
    let browser_tabs = browser_tabs_rx.borrow_and_update().clone();
    if !browser_tabs.is_null() {
        conn.send(ServerMsg::BrowserTabs { tabs: browser_tabs });
    }
    let allowed = lock(&shared.config).allow_phone_update;
    if let Some(msg) = update_msg(&update_rx.borrow_and_update(), allowed) {
        conn.send(msg);
    }
    if let Some(msg) = profiles_msg(&profiles_rx.borrow_and_update()) {
        conn.send(msg);
    }
    // Tabs right behind `Ready`, so the phone needn't wait for a `list` round
    // trip (an older phone asks anyway and gets the same list again). A list
    // older than `TABS_CACHE` (none was connected for a while) is rebuilt.
    conn.last_tabs = shared.refresh_tabs(TABS_CACHE).await;
    tabs_rx.mark_unchanged();
    conn.send(ServerMsg::Tabs { tabs: conn.last_tabs.clone() });
    chats_rx.mark_unchanged();
    conn.last_chats = shared.chat_infos();
    conn.send(ServerMsg::Chats { chats: conn.last_chats.clone() });
    conn.send_views();

    let mut tick = tokio::time::interval(TABS_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // A finished `JoinHandle` must not be polled again (it panics), and the
    // `select!` below may be the one that saw it finish.
    let mut writer_done = false;
    let mut why = "phone closed the stream or the link broke";
    loop {
        tokio::select! {
            msg = in_rx.recv() => match msg {
                Some(msg) => conn.handle(msg).await,
                None => break,
            },
            _ = tick.tick() => conn.prune_subs(),
            // The refresh task published a list; only a different one goes out.
            Ok(()) = tabs_rx.changed() => {
                if !conn.background {
                    conn.push_tabs_if_changed();
                    // A window reporting its tabs may have given a chat its tab or its label.
                    conn.push_chats_if_changed();
                }
            }
            Ok(()) = chats_rx.changed() => {
                if !conn.background {
                    conn.push_chats_if_changed();
                }
            }
            // While the phone is in the background the arms below still
            // consume their channel (so it doesn't spin) but send nothing;
            // `Conn::set_background` catches the phone up afterwards.
            Ok(()) = usage_rx.changed() => {
                let items = usage_rx.borrow_and_update().clone();
                if !conn.background {
                    conn.send(ServerMsg::Usage { items });
                }
            }
            Ok(()) = actions_rx.changed() => {
                let actions = actions_rx.borrow_and_update().clone();
                if !conn.background {
                    conn.send(ServerMsg::Actions { actions });
                }
            }
            Ok(()) = settings_rx.changed() => {
                let settings = settings_rx.borrow_and_update().clone();
                if !conn.background && !settings.is_null() {
                    conn.send(ServerMsg::Settings { settings });
                }
            }
            Ok(()) = browser_tabs_rx.changed() => {
                let tabs = browser_tabs_rx.borrow_and_update().clone();
                if !conn.background && !tabs.is_null() {
                    conn.send(ServerMsg::BrowserTabs { tabs });
                }
            }
            Ok(()) = update_rx.changed() => {
                let allowed = lock(&shared.config).allow_phone_update;
                let msg = update_msg(&update_rx.borrow_and_update(), allowed);
                if let (false, Some(msg)) = (conn.background, msg) {
                    conn.send(msg);
                }
            }
            Ok(()) = profiles_rx.changed() => {
                let msg = profiles_msg(&profiles_rx.borrow_and_update());
                if let Some(msg) = msg.filter(|_| !conn.background) {
                    conn.send(msg);
                }
            }
            // Lagging just drops the notifications missed; a closed channel
            // (never, `Shared` holds the sender) would only disable this arm.
            notice = notices_rx.recv() => match notice {
                Ok(msg) => {
                    if !matches!(&msg, ServerMsg::ProviderAuthRequired { .. }) || conn.auth_supported {
                        conn.send(msg);
                    }
                },
                Err(_) => continue,
            },
            _ = kick_rx.changed() => {
                if *kick_rx.borrow() == Some(Kick::Revoked) {
                    let message = tr("Dispositivo revocato", "Device revoked").to_string();
                    conn.send(ServerMsg::Error { message, pty_id: None, chat_id: None, fatal: true });
                    why = "device revoked";
                } else {
                    // Recovery is transient: never make the phone forget pairing.
                    why = "connection replaced";
                }
                break;
            }
            _ = shutdown.changed() => {
                why = "remote access stopped";
                break;
            }
            _ = &mut writer, if !writer_done => {
                writer_done = true;
                why = "write to the phone failed";
                break;
            }
        }
        // The phone stopped reading, or floods input: not worth keeping.
        if conn.overflow.load(Ordering::Relaxed) {
            why = "queue overflowed (phone not reading or flooding)";
            break;
        }
    }
    conn.shutdown();
    shared.release_all_sizes(conn_id);
    reader.abort();
    previews.abort();
    shared.unregister_conn(conn_id);
    // Dropping `conn` closes the writer's channel: it flushes what is queued,
    // then finishes the stream. Give it a moment before closing the link.
    drop(conn);
    if !writer_done {
        let _ = tokio::time::timeout(Duration::from_secs(3), &mut writer).await;
    }
    // Read before closing ourselves: this is why QUIC itself saw it end (idle
    // timeout, the phone's close code, a reset) when it wasn't us.
    let quic = connection.close_reason().map_or_else(|| "still open".to_string(), |e| e.to_string());
    connection.close(0u32.into(), b"bye");
    format!("{why}; QUIC: {quic}")
}

pub(super) struct Conn {
    pub(super) shared: Arc<Shared>,
    pub(super) id: u64,
    pub(super) out_tx: mpsc::Sender<ServerMsg>,
    /// Set when something couldn't be queued because the phone isn't keeping
    /// up; the connection loop then hangs up.
    pub(super) overflow: AtomicBool,
    /// pty id -> the task streaming it to this client.
    pub(super) subs: HashMap<String, tokio::task::JoinHandle<()>>,
    /// chat id -> the task streaming it to this client, and the last event it sent.
    pub(super) chat_subs: HashMap<String, (tokio::task::JoinHandle<()>, Arc<AtomicU64>)>,
    /// Chats followed when the phone went to the background, with the last
    /// event sent: the phone still counts them as open, so they resume by
    /// themselves when it comes back.
    pub(super) paused_chats: Vec<(String, u64)>,
    /// Terminals streamed when the phone went to the background. They are
    /// streamed again (fresh snapshot first) when it comes back, so a phone
    /// whose page never saw itself hidden doesn't stay on a frozen screen.
    pub(super) paused_ptys: Vec<String>,
    pub(super) last_tabs: Vec<Tab>,
    pub(super) last_chats: Vec<ChatInfo>,
    /// The phone said it is in the background: only notifications go out.
    pub(super) background: bool,
    /// The last input error reported (pty id, when): repeats for the same pty
    /// are held back for `INPUT_ERROR_QUIET`, or each keystroke would toast.
    pub(super) input_error_at: Option<(String, Instant)>,
    /// The connection owns its login processes, including a start still on the blocking pool.
    pub(super) auth_alive: Arc<AtomicBool>,
    pub(super) auth_requests: Arc<AtomicUsize>,
    pub(super) auth_supported: bool,
    /// The client advertised `resized`: it follows the size of the ptys it has open.
    pub(super) resized_supported: bool,
}

impl Conn {
    /// Queues a message without waiting: a full queue means the phone stopped
    /// reading, which ends the connection (see `overflow`).
    pub(super) fn send(&self, msg: ServerMsg) {
        if let Err(mpsc::error::TrySendError::Full(_)) = self.out_tx.try_send(msg) {
            self.overflow.store(true, Ordering::Relaxed);
        }
    }

    /// Tells the leader window a phone wants an update check / install.
    pub(super) fn emit_update_event(&self, event: &str) {
        let Some(window) = self.shared.default_window() else {
            self.error(tr("Nessuna finestra aperta", "No window is open"), None);
            return;
        };
        let _ = self.shared.app.emit_to(window.as_str(), event, ());
    }

    pub(super) fn error(&self, message: &str, pty_id: Option<String>) {
        self.send(ServerMsg::Error { message: message.to_string(), pty_id, chat_id: None, fatal: false });
    }

    /// An error about one chat's request: the chat id lets the client settle that chat's state.
    pub(super) fn chat_error(&self, message: &str, chat_id: &str) {
        self.send(ServerMsg::Error { message: message.to_string(), pty_id: None, chat_id: Some(chat_id.to_string()), fatal: false });
    }

    /// Forgets streams that ended on their own (the program exited), with
    /// everything tied to them.
    pub(super) fn prune_subs(&mut self) {
        let ended: Vec<String> = self.subs.iter().filter(|(_, task)| task.is_finished()).map(|(p, _)| p.clone()).collect();
        for pty_id in ended {
            self.subs.remove(&pty_id);
            self.shared.release_size(&pty_id, self.id);
        }
        self.chat_subs.retain(|_, (task, _)| !task.is_finished());
    }

    /// Stops every task this connection started.
    pub(super) fn shutdown(&mut self) {
        self.auth_alive.store(false, Ordering::Release);
        dictation::cancel_all(self.id);
        crate::provider_auth::cancel_owner(&self.auth_owner());
        for (_, task) in self.subs.drain() {
            task.abort();
        }
        for (_, (task, _)) in self.chat_subs.drain() {
            task.abort();
        }
    }

    pub(super) fn auth_owner(&self) -> String {
        // Connection id is generated by the server, never accepted from a request.
        format!("remote:{}", self.id)
    }

    pub(super) fn provider_auth(&self, request_id: String, request: serde_json::Value) {
        if request_id.is_empty() || request_id.len() > MAX_ID_BYTES {
            return;
        }
        let refuse = |message: &str| self.send(ServerMsg::ProviderAuth {
            request_id: request_id.clone(), state: None, error: Some(message.to_string()),
        });
        if serde_json::to_vec(&request).map_or(true, |bytes| bytes.len() > 20 * 1024) {
            refuse(tr("Richiesta di accesso troppo grande", "Sign-in request is too large"));
            return;
        }
        let Ok(mut request) = serde_json::from_value::<crate::provider_auth::AuthRequest>(request) else {
            refuse(tr("Richiesta di accesso non valida", "Invalid sign-in request"));
            return;
        };
        // A phone cannot opt into a desktop-only loopback callback flow.
        request.remote = true;
        if self.auth_requests.fetch_add(1, Ordering::AcqRel) >= 4 {
            self.auth_requests.fetch_sub(1, Ordering::AcqRel);
            refuse(tr("Troppe richieste di accesso. Riprova.", "Too many sign-in requests. Try again."));
            return;
        }
        let app = self.shared.app.clone();
        let owner = self.auth_owner();
        let alive = Arc::clone(&self.auth_alive);
        let count = Arc::clone(&self.auth_requests);
        let out = self.out_tx.clone();
        tauri::async_runtime::spawn(async move {
            let result = crate::blocking(move || {
                if !alive.load(Ordering::Acquire) {
                    return Err("Connection closed".to_string());
                }
                let result = crate::provider_auth::handle(&app, &owner, request);
                if !alive.load(Ordering::Acquire) {
                    // A start may finish after shutdown cancelled the old sessions.
                    crate::provider_auth::cancel_owner(&owner);
                    return Err("Connection closed".to_string());
                }
                result.and_then(|state| serde_json::to_value(state).map_err(|_| "Invalid sign-in response".to_string()))
            }).await;
            count.fetch_sub(1, Ordering::AcqRel);
            let (state, error) = match result { Ok(state) => (Some(state), None), Err(error) => (None, Some(error)) };
            let _ = out.send(ServerMsg::ProviderAuth { request_id, state, error }).await;
        });
    }

    /// Streams `chat_id` to this client from after `after_seq`, replacing any
    /// stream of it already running. Errs (already reported) when it can't.
    /// `paged` (the phone supports `chatPaging`) with nothing seen yet answers
    /// with only the newest page of the log.
    pub(super) fn open_chat(&mut self, chat_id: String, after_seq: u64, paged: bool) {
        let state = self.shared.app.state::<ChatState>();
        let subscribed = if paged && after_seq == 0 {
            crate::chat::subscribe_tail(&state, &chat_id).map(|((events, has_more, first_seq), feed)| (events, Some((has_more, first_seq)), feed))
        } else {
            state.subscribe(&chat_id, after_seq).map(|(events, feed)| (events, None, feed))
        };
        let Ok((replay, page, feed)) = subscribed else {
            self.chat_error(tr("Chat non trovata", "Chat not found"), &chat_id);
            return;
        };
        if let Some((old, _)) = self.chat_subs.remove(&chat_id) {
            old.abort();
        }
        let sent = Arc::new(AtomicU64::new(after_seq));
        let task = tokio::spawn(stream_chat(
            Arc::clone(&self.shared),
            chat_id.clone(),
            after_seq,
            replay,
            page,
            feed,
            self.out_tx.clone(),
            Arc::clone(&sent),
        ));
        self.chat_subs.insert(chat_id, (task, sent));
    }

    /// Enters or leaves background mode. Entering stops every stream (the
    /// phone closes them too); leaving sends the current state again, like
    /// right after the connection was admitted.
    pub(super) fn set_background(&mut self, on: bool) {
        if self.background == on {
            return;
        }
        self.background = on;
        if on {
            for (pty_id, task) in self.subs.drain() {
                task.abort();
                self.shared.release_size(&pty_id, self.id);
                self.paused_ptys.push(pty_id);
            }
            for (chat_id, (task, sent)) in self.chat_subs.drain() {
                task.abort();
                self.paused_chats.push((chat_id, sent.load(Ordering::Relaxed)));
            }
            return;
        }
        // The phone may `open` them again too: that just replaces the stream.
        let ptys = self.shared.app.state::<PtyState>();
        for pty_id in std::mem::take(&mut self.paused_ptys) {
            if ptys.exists(&pty_id) && !self.subs.contains_key(&pty_id) {
                let task = tokio::spawn(stream_pty(Arc::clone(&self.shared), pty_id.clone(), self.out_tx.clone(), self.resized_supported));
                self.subs.insert(pty_id, task);
            }
        }
        // A chat closed meanwhile is just gone from the `chats` sent below.
        let live = self.shared.chat_infos();
        for (chat_id, after_seq) in std::mem::take(&mut self.paused_chats) {
            if live.iter().any(|c| c.chat_id == chat_id) {
                self.open_chat(chat_id, after_seq, false);
            }
        }
        self.last_tabs = self.shared.latest_tabs();
        self.send(ServerMsg::Tabs { tabs: self.last_tabs.clone() });
        self.last_chats = self.shared.chat_infos();
        self.send(ServerMsg::Chats { chats: self.last_chats.clone() });
        self.send(ServerMsg::Usage { items: self.shared.usage.borrow().clone() });
        self.send(ServerMsg::Actions { actions: self.shared.actions.borrow().clone() });
        let settings = self.shared.settings.borrow().clone();
        if !settings.is_null() {
            self.send(ServerMsg::Settings { settings });
        }
        let browser_tabs = self.shared.browser_tabs.borrow().clone();
        if !browser_tabs.is_null() {
            self.send(ServerMsg::BrowserTabs { tabs: browser_tabs });
        }
        let allowed = lock(&self.shared.config).allow_phone_update;
        if let Some(msg) = update_msg(&self.shared.update.borrow(), allowed) {
            self.send(msg);
        }
        if let Some(msg) = profiles_msg(&self.shared.profiles.borrow()) {
            self.send(msg);
        }
    }

    pub(super) fn push_tabs_if_changed(&mut self) {
        let tabs = self.shared.latest_tabs();
        if tabs != self.last_tabs {
            self.last_tabs = tabs.clone();
            self.send(ServerMsg::Tabs { tabs });
        }
    }

    pub(super) fn push_chats_if_changed(&mut self) {
        let chats = self.shared.chat_infos();
        if chats != self.last_chats {
            self.last_chats = chats.clone();
            self.send(ServerMsg::Chats { chats });
        }
    }
}
