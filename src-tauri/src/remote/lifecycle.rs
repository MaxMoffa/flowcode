//! Starting and stopping the endpoint, and the device list.

use super::*;

impl RemoteState {
    /// A provider refused startup before it could create a remotely visible chat.
    pub(crate) fn notify_provider_auth_required(&self, cli: &str, profile: Option<&str>) {
        if !crate::agents::registry::is_known(cli) { return; }
        let _ = self.0.notices.send(ServerMsg::ProviderAuthRequired { cli: cli.to_string(), profile: profile.map(str::to_string) });
    }
    /// This desktop's own server node id while the endpoint runs, so the
    /// client side (`remote_client`) can refuse to pair with itself.
    pub(crate) fn node_id(&self) -> Option<String> {
        lock(&self.0.runtime).running.as_ref().map(|r| r.node_id.clone())
    }

    pub fn load(app: &AppHandle) -> RemoteState {
        let dir = app.path().app_config_dir().unwrap_or_default();
        let _ = std::fs::create_dir_all(&dir);
        let config_path = dir.join("remote.json");
        let mut config: Config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        // Pairings from the Tailscale prototype carry no node id and could
        // never authenticate any more.
        config.devices.retain(|d| !d.node_id.is_empty());
        RemoteState(Arc::new(Shared {
            app: app.clone(),
            config_path,
            key_path: dir.join("remote-node.key"),
            host_name: sysinfo::System::host_name().unwrap_or_else(|| "Flowcode".to_string()),
            config: Mutex::new(config),
            lifecycle: tokio::sync::Mutex::new(()),
            runtime: Mutex::new(Runtime::default()),
            pairings: Mutex::new(Pairings::default()),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            handshaking: AtomicUsize::new(0),
            handshaking_unknown: AtomicUsize::new(0),
            auth_limiter: Mutex::new(AuthLimiter::default()),
            unknown_limiter: Mutex::new(UnknownLimiter::default()),
            log: ConnLog::new(dir.join("remote.log")),
            waiters: Mutex::new(HashMap::new()),
            pair_waiters: Mutex::new(HashMap::new()),
            last_active: Mutex::new(HashMap::new()),
            tabs: watch::channel(None).0,
            tabs_build: tokio::sync::Mutex::new(()),
            tabs_wake: tokio::sync::Notify::new(),
            context_cache: Mutex::new(HashMap::new()),
            last_persisted_seen: Mutex::new(0),
            usage: watch::channel(Vec::new()).0,
            actions: watch::channel(Vec::new()).0,
            settings: watch::channel(serde_json::Value::Null).0,
            browser_tabs: watch::channel(serde_json::Value::Null).0,
            update: watch::channel(serde_json::Value::Null).0,
            profiles: watch::channel(serde_json::Value::Null).0,
            notices: broadcast::channel(32).0,
            view_hashes: Mutex::new(HashMap::new()),
            prompt_receipts: prompts::PromptReceipts::default(),
            sizing: Mutex::new(HashMap::new()),
            pending_release: Mutex::new(HashMap::new()),
            release_seq: AtomicU64::new(0),
            size_owners: Mutex::new(HashMap::new()),
        }))
    }

    /// A window reported its tabs: refresh the list now rather than at the
    /// next tick, so a tab opened or closed reaches the phones quickly.
    pub fn tabs_reported(&self) {
        self.0.tabs_wake.notify_one();
    }

    /// Mirrors a desktop notification to the connected phones (a no-op while
    /// none are connected). An empty `tab_id` means it isn't about a tab.
    pub fn broadcast_notify(&self, title: String, body: String, tab_id: Option<String>) {
        let tab_id = tab_id.filter(|id| !id.is_empty());
        let _ = self.0.notices.send(ServerMsg::Notify { title, body, tab_id });
    }

    /// Starts the endpoint at launch if the user left it enabled.
    pub fn autostart(&self) {
        if lock(&self.0.config).enabled {
            let shared = Arc::clone(&self.0);
            tauri::async_runtime::spawn(async move {
                shared.set_enabled(true).await;
            });
        }
    }
}

impl Shared {
    pub(super) fn save(&self) {
        let text = match serde_json::to_vec_pretty(&*lock(&self.config)) {
            Ok(text) => text,
            Err(_) => return,
        };
        if let Err(e) = crate::fs::write_atomic(&self.config_path, &text) {
            eprintln!("remote: cannot save {}: {e}", self.config_path.display());
        }
    }

    pub(super) fn devices_changed(&self) {
        let _ = self.app.emit(EVT_DEVICES_CHANGED, ());
    }

    pub(super) fn status(&self) -> RemoteStatus {
        let config = lock(&self.config).clone();
        let runtime = lock(&self.runtime);
        let connected: Vec<String> = lock(&self.conns).values().map(|c| c.device_id.clone()).collect();
        RemoteStatus {
            enabled: config.enabled,
            running: runtime.running.is_some(),
            node_id: runtime.running.as_ref().map(|r| r.node_id.clone()),
            error: runtime.error.clone(),
            allow_phone_update: config.allow_phone_update,
            devices: config
                .devices
                .iter()
                .map(|d| DeviceStatus {
                    id: d.id.clone(),
                    name: d.name.clone(),
                    created_at: d.created_at,
                    last_seen_at: d.last_seen_at,
                    connected: connected.contains(&d.id),
                })
                .collect(),
        }
    }

    pub(super) async fn set_enabled(self: &Arc<Self>, enabled: bool) -> RemoteStatus {
        let _guard = self.lifecycle.lock().await;
        lock(&self.config).enabled = enabled;
        self.save();
        if enabled {
            self.start().await;
        } else {
            self.stop().await;
        }
        self.status()
    }

    pub(super) async fn stop(&self) {
        let running = {
            let mut runtime = lock(&self.runtime);
            runtime.error = None;
            runtime.running.take()
        };
        lock(&self.pairings).active = None;
        if let Some(running) = running {
            // Every connection watches this and hangs up.
            let _ = running.shutdown.send(true);
            running.endpoint.close().await;
        }
    }

    pub(super) async fn start(self: &Arc<Self>) {
        if lock(&self.runtime).running.is_some() {
            return;
        }
        match self.try_start().await {
            Ok(running) => {
                let mut runtime = lock(&self.runtime);
                runtime.error = None;
                runtime.running = Some(running);
            }
            Err(message) => {
                self.log.line(&format!("endpoint failed to start: {message}"));
                lock(&self.runtime).error = Some(message);
            }
        }
    }

    pub(super) async fn try_start(self: &Arc<Self>) -> Result<Running, String> {
        let key_path = self.key_path.clone();
        let (instance_lock, secret) = crate::blocking(move || {
            let held = acquire_instance_lock(&key_path)?;
            Ok((held, load_or_create_key(&key_path)?))
        })
        .await?;
        // The idle timeout has to be above the phone's tolerated silence, and
        // the keep-alive is stretched from iroh's 5 s (see `QUIC_KEEP_ALIVE`).
        // iroh ignores a per-path keep-alive above 5 s and clamps the path
        // idle timeout to 15 s, so those stay at their defaults.
        let mut transport = QuicTransportConfig::builder().keep_alive_interval(QUIC_KEEP_ALIVE);
        if let Ok(idle) = IdleTimeout::try_from(QUIC_IDLE_TIMEOUT) {
            transport = transport.max_idle_timeout(Some(idle));
        }
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(secret)
            .alpns(vec![proto::ALPN.to_vec()])
            .transport_config(transport.build())
            .bind()
            .await
            .map_err(|e| {
                if is_italian() {
                    format!("Impossibile avviare la connessione: {e}")
                } else {
                    format!("Cannot start the connection: {e}")
                }
            })?;
        let node_id = endpoint.id().to_string();
        self.log.line(&format!("endpoint started, node {}", short_id(&node_id)));
        // The addresses a phone can reach us on directly: every interface iroh
        // found, a VPN's (Tailscale 100.x) and the LAN's included.
        self.log.line(&format!("local addresses: {}", describe_addrs(&endpoint.addr())));
        // Phones that dial before the relay is reachable can only use direct
        // addresses; the log says when that window ended.
        {
            let (shared, endpoint) = (Arc::clone(self), endpoint.clone());
            tauri::async_runtime::spawn(async move {
                let started = Instant::now();
                match tokio::time::timeout(Duration::from_secs(120), endpoint.online()).await {
                    Ok(()) => {
                        shared.log.line(&format!("endpoint online (relay reachable) after {} ms", started.elapsed().as_millis()));
                        shared.log.line(&format!("addresses once online: {}", describe_addrs(&endpoint.addr())));
                    }
                    Err(_) => shared.log.line("endpoint still not online (no relay) after 120 s"),
                }
            });
        }
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        tauri::async_runtime::spawn(tabs_task(Arc::clone(self), shutdown_rx.clone()));
        tauri::async_runtime::spawn(chat_alerts_task(Arc::clone(self), shutdown_rx.clone()));
        tauri::async_runtime::spawn(accept_loop(Arc::clone(self), endpoint.clone(), shutdown_rx));
        Ok(Running { endpoint, node_id, shutdown: shutdown_tx, _instance_lock: instance_lock })
    }

    /// Whether `node_id` is the node of a paired device.
    pub(super) fn is_known_node(&self, node_id: &str) -> bool {
        lock(&self.config).devices.iter().any(|d| d.node_id == node_id)
    }

    pub(super) fn touch_device(&self, id: &str) {
        let now = now_ms();
        let persist = {
            let mut config = lock(&self.config);
            if let Some(device) = config.devices.iter_mut().find(|d| d.id == id) {
                device.last_seen_at = Some(now);
            }
            let mut last = lock(&self.last_persisted_seen);
            if now.saturating_sub(*last) >= LAST_SEEN_PERSIST_MS {
                *last = now;
                true
            } else {
                false
            }
        };
        if persist {
            self.save();
        }
    }

    pub(super) fn register_conn(&self, device_id: &str, kick: watch::Sender<Option<Kick>>, connection: &Connection) -> u64 {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        install_connection(&mut lock(&self.conns), id, ConnEntry { device_id: device_id.to_string(), kick, connection: connection.clone() });
        self.devices_changed();
        id
    }

    pub(super) fn unregister_conn(&self, id: u64) {
        if let Some(entry) = lock(&self.conns).remove(&id) {
            lock(&self.last_active).insert(entry.device_id, Instant::now());
        }
        self.devices_changed();
    }

    /// Whether a connection from `device_id` is worth a notification: not if
    /// it is already connected or was within `CONNECT_NOTIFY_QUIET`.
    pub(super) fn is_fresh_connect(&self, device_id: &str) -> bool {
        if lock(&self.conns).values().any(|c| c.device_id == device_id) {
            return false;
        }
        lock(&self.last_active).get(device_id).is_none_or(|t| t.elapsed() >= CONNECT_NOTIFY_QUIET)
    }

    /// Native notification, off the caller's thread (the first one registers
    /// the toast source).
    pub(super) fn notify(&self, title: String, body: String) {
        let app = self.app.clone();
        let label = self.default_window().unwrap_or_default();
        tauri::async_runtime::spawn_blocking(move || crate::notify::show(app, label, String::new(), title, body));
    }

    pub(super) fn focus_window(&self, label: &str) {
        if let Some(window) = self.app.get_window(label) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    /// Hangs up the live connections of devices already removed from the config.
    /// As "replaced", not "revoked": the same phone may be re-pairing, and a
    /// revoked error would make it forget the pairing it just got.
    pub(super) fn kick_removed(&self, device_ids: &[String]) {
        if device_ids.is_empty() {
            return;
        }
        for conn in lock(&self.conns).values().filter(|c| device_ids.contains(&c.device_id)) {
            let _ = conn.kick.send(Some(Kick::Replaced));
        }
    }

    pub(super) fn revoke(&self, device_id: &str) {
        lock(&self.config).devices.retain(|d| d.id != device_id);
        self.save();
        for conn in lock(&self.conns).values().filter(|c| c.device_id == device_id) {
            let _ = conn.kick.send(Some(Kick::Revoked));
        }
        self.devices_changed();
    }
}
