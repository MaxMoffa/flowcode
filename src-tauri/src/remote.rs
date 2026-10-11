//! Remote access (prototype): a small HTTP + WebSocket server inside the
//! desktop app that serves a mobile web client and streams the terminals to
//! it, meant to be reached from a phone over Tailscale.
//!
//! Security model: off by default; when on, it binds *only* to this machine's
//! Tailscale address (100.64.0.0/10), never to a wildcard. Every API/WS use
//! needs a device token obtained by pairing with a one-time code shown on the
//! desktop; only SHA-256 hashes of tokens are stored. The WebSocket checks
//! `Origin` so a web page open in some other browser tab can't talk to it.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use flowcode_shared::i18n::{is_italian, tr};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch};

use crate::pty::{PtyState, RemoteOut};
use crate::util::{lock, now_ms};

const DEFAULT_PORT: u16 = 7799;
/// A pairing code is good for this long, once.
const PAIR_TTL_MS: u64 = 5 * 60 * 1000;
/// After this many wrong codes within `FAIL_WINDOW_MS`, every pairing attempt
/// is refused for `BLOCK_MS`.
const MAX_PAIR_FAILURES: usize = 5;
const FAIL_WINDOW_MS: u64 = 60_000;
const BLOCK_MS: u64 = 60_000;
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);
const TABS_INTERVAL: Duration = Duration::from_secs(2);
/// Agent detection walks the process table: concurrent connections share one
/// result this old rather than each triggering a scan.
const TABS_CACHE: Duration = Duration::from_millis(1500);
const MAX_INPUT_BYTES: usize = 64 * 1024;
/// WebSocket frame cap: an input message plus its JSON envelope.
const MAX_WS_MESSAGE: usize = MAX_INPUT_BYTES + 4 * 1024;
const LAST_SEEN_PERSIST_MS: u64 = 60_000;
const EVT_DEVICES_CHANGED: &str = "remote://devices-changed";
const EVT_SNAPSHOT_REQUEST: &str = "remote://snapshot-request";

// ---- persistence ---------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    token_hash: String,
    created_at: u64,
    last_seen_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    devices: Vec<Device>,
}

fn default_port() -> u16 {
    DEFAULT_PORT
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: false, port: DEFAULT_PORT, devices: Vec::new() }
    }
}

// ---- tokens, pairing -----------------------------------------------------

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn hash_token(token: &str) -> String {
    Sha256::digest(token.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Equality that doesn't leak, through timing, where two strings first differ.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, PartialEq, Eq)]
enum PairError {
    Invalid,
    RateLimited,
}

/// The one active pairing code plus the failure bookkeeping. Time is passed
/// in (`now`, ms) so the rules are testable.
#[derive(Default)]
struct Pairings {
    active: Option<(String, u64)>,
    failures: Vec<u64>,
    blocked_until: u64,
}

impl Pairings {
    /// A fresh code, replacing any earlier one. Returns (code, expiresAt).
    fn start(&mut self, code: String, now: u64) -> (String, u64) {
        let expires = now + PAIR_TTL_MS;
        self.active = Some((code.clone(), expires));
        (code, expires)
    }

    /// Consumes the code if `code` is the active, unexpired one.
    fn redeem(&mut self, code: &str, now: u64) -> Result<(), PairError> {
        if now < self.blocked_until {
            return Err(PairError::RateLimited);
        }
        let hit = match &self.active {
            Some((active, expires)) => ct_eq(active.as_bytes(), code.as_bytes()) && now < *expires,
            None => false,
        };
        if hit {
            self.active = None;
            self.failures.clear();
            return Ok(());
        }
        if matches!(&self.active, Some((_, expires)) if now >= *expires) {
            self.active = None;
        }
        self.failures.retain(|t| now.saturating_sub(*t) < FAIL_WINDOW_MS);
        self.failures.push(now);
        if self.failures.len() >= MAX_PAIR_FAILURES {
            self.blocked_until = now + BLOCK_MS;
            self.failures.clear();
        }
        Err(PairError::Invalid)
    }
}

// ---- Tailscale address ---------------------------------------------------

fn is_tailscale_ip(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0xC0) == 64
}

/// The address to bind: an IPv4 in 100.64.0.0/10 (Tailscale's CGNAT range),
/// preferring an interface named like Tailscale's when several qualify.
fn pick_tailscale_ip(interfaces: &[(String, Ipv4Addr)]) -> Option<Ipv4Addr> {
    let candidates: Vec<&(String, Ipv4Addr)> = interfaces.iter().filter(|(_, ip)| is_tailscale_ip(*ip)).collect();
    candidates
        .iter()
        .find(|(name, _)| name.to_ascii_lowercase().contains("tailscale"))
        .or_else(|| candidates.first())
        .map(|(_, ip)| *ip)
}

fn find_tailscale_ip() -> Option<Ipv4Addr> {
    let interfaces: Vec<(String, Ipv4Addr)> = if_addrs::get_if_addrs()
        .ok()?
        .into_iter()
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) => Some((i.name, v4.ip)),
            _ => None,
        })
        .collect();
    pick_tailscale_ip(&interfaces)
}

/// A browser always sends `Origin` on a WebSocket handshake; it must be this
/// very server's origin (a missing one is refused too).
fn origin_allowed(origin: Option<&str>, expected: &str) -> bool {
    origin == Some(expected)
}

// ---- shared state --------------------------------------------------------

struct ConnEntry {
    device_id: String,
    kick: watch::Sender<bool>,
}

struct Running {
    ip: Ipv4Addr,
    port: u16,
    shutdown: watch::Sender<bool>,
}

#[derive(Default)]
struct Runtime {
    running: Option<Running>,
    error: Option<String>,
}

#[derive(Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Tab {
    pty_id: String,
    tab_id: String,
    window: String,
    label: String,
    cwd: String,
    cli: Option<String>,
    status: Option<String>,
    cols: u16,
    rows: u16,
}

type SnapshotReply = (String, u64);

struct Shared {
    app: AppHandle,
    config_path: PathBuf,
    config: Mutex<Config>,
    /// Serializes start/stop so toggling quickly can't race two servers.
    lifecycle: tokio::sync::Mutex<()>,
    runtime: Mutex<Runtime>,
    pairings: Mutex<Pairings>,
    conns: Mutex<HashMap<u64, ConnEntry>>,
    next_conn: AtomicU64,
    waiters: Mutex<HashMap<String, oneshot::Sender<SnapshotReply>>>,
    tabs_cache: tokio::sync::Mutex<Option<(Instant, Vec<Tab>)>>,
    last_persisted_seen: Mutex<u64>,
}

/// Managed by Tauri (see lib.rs).
pub struct RemoteState(Arc<Shared>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStatus {
    id: String,
    name: String,
    created_at: u64,
    last_seen_at: Option<u64>,
    connected: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStatus {
    enabled: bool,
    running: bool,
    address: Option<String>,
    url: Option<String>,
    error: Option<String>,
    devices: Vec<DeviceStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStart {
    url: String,
    code: String,
    expires_at: u64,
}

impl RemoteState {
    pub fn load(app: &AppHandle) -> RemoteState {
        let dir = app.path().app_config_dir().unwrap_or_default();
        let _ = std::fs::create_dir_all(&dir);
        let config_path = dir.join("remote.json");
        let config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        RemoteState(Arc::new(Shared {
            app: app.clone(),
            config_path,
            config: Mutex::new(config),
            lifecycle: tokio::sync::Mutex::new(()),
            runtime: Mutex::new(Runtime::default()),
            pairings: Mutex::new(Pairings::default()),
            conns: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(1),
            waiters: Mutex::new(HashMap::new()),
            tabs_cache: tokio::sync::Mutex::new(None),
            last_persisted_seen: Mutex::new(0),
        }))
    }

    /// Starts the server at launch if the user left it enabled.
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
    fn save(&self) {
        let text = match serde_json::to_vec_pretty(&*lock(&self.config)) {
            Ok(text) => text,
            Err(_) => return,
        };
        if let Err(e) = crate::fs::write_atomic(&self.config_path, &text) {
            eprintln!("remote: cannot save {}: {e}", self.config_path.display());
        }
    }

    fn devices_changed(&self) {
        let _ = self.app.emit(EVT_DEVICES_CHANGED, ());
    }

    fn status(&self) -> RemoteStatus {
        let config = lock(&self.config).clone();
        let runtime = lock(&self.runtime);
        let connected: Vec<String> = lock(&self.conns).values().map(|c| c.device_id.clone()).collect();
        let (address, url) = match &runtime.running {
            Some(r) => (Some(format!("{}:{}", r.ip, r.port)), Some(format!("http://{}:{}/", r.ip, r.port))),
            None => (None, None),
        };
        RemoteStatus {
            enabled: config.enabled,
            running: runtime.running.is_some(),
            address,
            url,
            error: runtime.error.clone(),
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

    async fn set_enabled(self: &Arc<Self>, enabled: bool) -> RemoteStatus {
        let _guard = self.lifecycle.lock().await;
        lock(&self.config).enabled = enabled;
        self.save();
        if enabled {
            self.start().await;
        } else {
            self.stop();
        }
        self.status()
    }

    fn stop(&self) {
        let mut runtime = lock(&self.runtime);
        runtime.error = None;
        if let Some(running) = runtime.running.take() {
            // Every connection watches this and hangs up.
            let _ = running.shutdown.send(true);
        }
        lock(&self.pairings).active = None;
    }

    async fn start(self: &Arc<Self>) {
        if lock(&self.runtime).running.is_some() {
            return;
        }
        match self.try_start().await {
            Ok(running) => {
                let mut runtime = lock(&self.runtime);
                runtime.error = None;
                runtime.running = Some(running);
            }
            Err(message) => lock(&self.runtime).error = Some(message),
        }
    }

    async fn try_start(self: &Arc<Self>) -> Result<Running, String> {
        let ip = find_tailscale_ip().ok_or_else(|| {
            tr(
                "Tailscale non trovato: installalo e collegati, poi riprova.",
                "Tailscale not found: install it and sign in, then try again.",
            )
            .to_string()
        })?;
        let port = lock(&self.config).port;
        // Right after a stop the old listener may take a moment to let go.
        let mut attempt = 0;
        let listener = loop {
            match std::net::TcpListener::bind(SocketAddr::new(IpAddr::V4(ip), port)) {
                Ok(listener) => break listener,
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse && attempt < 5 => {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(200)).await;
                }
                Err(e) => {
                    return Err(if is_italian() {
                        format!("Impossibile aprire {ip}:{port}: {e}")
                    } else {
                        format!("Cannot listen on {ip}:{port}: {e}")
                    })
                }
            }
        };
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;

        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let ctx = Ctx {
            shared: Arc::clone(self),
            origin: Arc::from(format!("http://{ip}:{port}")),
            shutdown: shutdown_rx.clone(),
        };
        let router = Router::new()
            .route("/api/pair", post(pair_handler).layer(DefaultBodyLimit::max(4 * 1024)))
            .route("/ws", get(ws_handler))
            .fallback(static_handler)
            .with_state(ctx);
        let mut graceful = shutdown_rx;
        tauri::async_runtime::spawn(async move {
            let Ok(listener) = tokio::net::TcpListener::from_std(listener) else { return };
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = graceful.wait_for(|stop| *stop).await;
                })
                .await;
        });
        Ok(Running { ip, port, shutdown: shutdown_tx })
    }

    fn find_device_by_token(&self, token: &str) -> Option<Device> {
        let hash = hash_token(token);
        let config = lock(&self.config);
        // Compare against every device (no early exit) so timing doesn't
        // reveal how far down the list a match was.
        let mut found = None;
        for device in &config.devices {
            if ct_eq(device.token_hash.as_bytes(), hash.as_bytes()) {
                found = Some(device.clone());
            }
        }
        found
    }

    fn touch_device(&self, id: &str) {
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

    fn register_conn(&self, device_id: &str, kick: watch::Sender<bool>) -> u64 {
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        lock(&self.conns).insert(id, ConnEntry { device_id: device_id.to_string(), kick });
        self.devices_changed();
        id
    }

    fn unregister_conn(&self, id: u64) {
        lock(&self.conns).remove(&id);
        self.devices_changed();
    }

    fn revoke(&self, device_id: &str) {
        lock(&self.config).devices.retain(|d| d.id != device_id);
        self.save();
        for conn in lock(&self.conns).values().filter(|c| c.device_id == device_id) {
            let _ = conn.kick.send(true);
        }
        self.devices_changed();
    }

    /// The tab list, shared between connections for `TABS_CACHE`.
    async fn tabs(&self) -> Vec<Tab> {
        let mut cache = self.tabs_cache.lock().await;
        if let Some((at, tabs)) = &*cache {
            if at.elapsed() < TABS_CACHE {
                return tabs.clone();
            }
        }
        let tabs = build_tabs(&self.app).await;
        *cache = Some((Instant::now(), tabs.clone()));
        tabs
    }
}

/// `WindowTabs` entries that have a live pty, joined with the agent running
/// in each (same source as the Agents panel).
async fn build_tabs(app: &AppHandle) -> Vec<Tab> {
    let sizes = app.state::<PtyState>().sizes();
    let agents: HashMap<String, (String, Option<String>)> = crate::agents::collect_agent_sessions(app)
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|s| (s.pty_id, (s.cli, s.status)))
        .collect();
    app.state::<crate::windows::WindowTabs>()
        .list()
        .into_iter()
        .filter_map(|(window, tab)| {
            let pty_id = tab.pty_id?;
            let (cols, rows) = *sizes.get(&pty_id)?;
            let (cli, status) = match agents.get(&pty_id) {
                Some((cli, status)) => (Some(cli.clone()), status.clone()),
                None => (None, None),
            };
            Some(Tab { pty_id, tab_id: tab.tab_id, window, label: tab.label, cwd: tab.cwd, cli, status, cols, rows })
        })
        .collect()
}

// ---- Tauri commands --------------------------------------------------------

#[tauri::command]
pub fn remote_status(state: tauri::State<'_, RemoteState>) -> RemoteStatus {
    state.0.status()
}

#[tauri::command]
pub async fn remote_set_enabled(state: tauri::State<'_, RemoteState>, enabled: bool) -> Result<RemoteStatus, String> {
    let shared = Arc::clone(&state.0);
    Ok(shared.set_enabled(enabled).await)
}

#[tauri::command]
pub fn remote_pair_start(state: tauri::State<'_, RemoteState>) -> Result<PairStart, String> {
    let shared = &state.0;
    let base = match &lock(&shared.runtime).running {
        Some(r) => format!("http://{}:{}/", r.ip, r.port),
        None => {
            return Err(tr("Accesso remoto non attivo", "Remote access is not running").to_string());
        }
    };
    let (code, expires_at) = lock(&shared.pairings).start(random_hex(16)?, now_ms());
    Ok(PairStart { url: format!("{base}#pair={code}"), code, expires_at })
}

#[tauri::command]
pub fn remote_revoke(state: tauri::State<'_, RemoteState>, device_id: String) -> RemoteStatus {
    state.0.revoke(&device_id);
    state.0.status()
}

#[tauri::command]
pub fn remote_snapshot_reply(state: tauri::State<'_, RemoteState>, req_id: String, data: String, seq: u64) {
    if let Some(waiter) = lock(&state.0.waiters).remove(&req_id) {
        let _ = waiter.send((data, seq));
    }
}

// ---- HTTP ------------------------------------------------------------------

#[derive(Clone)]
struct Ctx {
    shared: Arc<Shared>,
    /// `http://<bind address>:<port>` - what a legitimate page's Origin is.
    origin: Arc<str>,
    shutdown: watch::Receiver<bool>,
}

fn json_response(status: StatusCode, body: serde_json::Value) -> Response {
    let mut response = (status, Json(body)).into_response();
    response.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    code: String,
    device_name: String,
}

async fn pair_handler(State(ctx): State<Ctx>, headers: HeaderMap, Json(req): Json<PairRequest>) -> Response {
    // A browser always labels a cross-origin POST; refuse one from elsewhere.
    if let Some(origin) = headers.get(header::ORIGIN) {
        if !origin_allowed(origin.to_str().ok(), &ctx.origin) {
            return json_response(StatusCode::FORBIDDEN, serde_json::json!({ "error": "forbidden" }));
        }
    }
    let shared = &ctx.shared;
    let redeemed = lock(&shared.pairings).redeem(req.code.trim(), now_ms());
    match redeemed {
        Err(PairError::RateLimited) => json_response(
            StatusCode::TOO_MANY_REQUESTS,
            serde_json::json!({ "error": tr("Troppi tentativi: riprova tra un minuto", "Too many attempts: try again in a minute") }),
        ),
        Err(PairError::Invalid) => json_response(
            StatusCode::UNAUTHORIZED,
            serde_json::json!({ "error": tr("Codice non valido o scaduto", "Invalid or expired code") }),
        ),
        Ok(()) => {
            let (Ok(token), Ok(id)) = (random_hex(32), random_hex(8)) else {
                return json_response(StatusCode::INTERNAL_SERVER_ERROR, serde_json::json!({ "error": "random" }));
            };
            let name: String = req.device_name.trim().chars().take(64).collect();
            let name = if name.is_empty() { "Phone".to_string() } else { name };
            lock(&shared.config).devices.push(Device {
                id,
                name: name.clone(),
                token_hash: hash_token(&token),
                created_at: now_ms(),
                last_seen_at: None,
            });
            shared.save();
            shared.devices_changed();
            json_response(StatusCode::OK, serde_json::json!({ "token": token, "deviceName": name }))
        }
    }
}

fn with_static_headers(mut response: Response, html: bool) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    if html {
        headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    response
}

async fn static_handler(State(ctx): State<Ctx>, method: Method, uri: Uri) -> Response {
    if method != Method::GET {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let path = uri.path();
    if path.contains("..") || path.contains('\\') {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let path = if path == "/" { "/remote.html" } else { path };
    match fetch_asset(&ctx.shared.app, path, uri.query()).await {
        Some((bytes, mime)) => {
            let html = mime.starts_with("text/html");
            // The embedded asset lookup falls back to the desktop app's own
            // index.html for unknown paths; only the mobile page may be HTML.
            if html && path != "/remote.html" {
                return with_static_headers(StatusCode::NOT_FOUND.into_response(), false);
            }
            let content_type = HeaderValue::from_str(&mime).unwrap_or(HeaderValue::from_static("application/octet-stream"));
            with_static_headers(([(header::CONTENT_TYPE, content_type)], bytes).into_response(), html)
        }
        None => with_static_headers(StatusCode::NOT_FOUND.into_response(), false),
    }
}

/// Release builds: the frontend embedded in the executable.
#[cfg(not(debug_assertions))]
async fn fetch_asset(app: &AppHandle, path: &str, _query: Option<&str>) -> Option<(Vec<u8>, String)> {
    let asset = app.asset_resolver().get(path.to_string())?;
    Some((asset.bytes, asset.mime_type))
}

/// Debug builds: nothing is embedded (`cargo tauri dev` serves the frontend
/// from Vite), so forward the request to the dev server. Vite's HMR
/// websocket isn't proxied - the page just doesn't hot-reload.
#[cfg(debug_assertions)]
async fn fetch_asset(_app: &AppHandle, path: &str, query: Option<&str>) -> Option<(Vec<u8>, String)> {
    let url = match query {
        Some(q) => format!("http://localhost:1420{path}?{q}"),
        None => format!("http://localhost:1420{path}"),
    };
    crate::blocking(move || {
        use std::io::Read;
        let response = match ureq::get(&url).timeout(Duration::from_secs(5)).call() {
            Ok(response) => response,
            Err(_) => return Ok(None),
        };
        let mime = response.header("content-type").unwrap_or("application/octet-stream").to_string();
        let mut bytes = Vec::new();
        response.into_reader().take(32 * 1024 * 1024).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(Some((bytes, mime)))
    })
    .await
    .ok()
    .flatten()
}

// ---- WebSocket -------------------------------------------------------------

async fn ws_handler(State(ctx): State<Ctx>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> Response {
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !origin_allowed(origin, &ctx.origin) {
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade
        .max_message_size(MAX_WS_MESSAGE)
        .max_frame_size(MAX_WS_MESSAGE)
        .on_upgrade(move |socket| connection(ctx, socket))
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
enum ClientMsg {
    Auth { token: String },
    List,
    Open { pty_id: String },
    Close { pty_id: String },
    Input { pty_id: String, data: String },
    Ping,
}

fn text(value: serde_json::Value) -> Message {
    Message::Text(value.to_string().into())
}

async fn authenticate(shared: &Shared, socket: &mut WebSocket) -> Option<Device> {
    let first = tokio::time::timeout(AUTH_TIMEOUT, socket.recv()).await;
    let device = match first {
        Ok(Some(Ok(Message::Text(raw)))) => match serde_json::from_str::<ClientMsg>(raw.as_str()) {
            Ok(ClientMsg::Auth { token }) => shared.find_device_by_token(&token),
            _ => None,
        },
        _ => None,
    };
    if device.is_none() {
        let message = tr("Autenticazione non riuscita", "Authentication failed");
        let _ = socket.send(text(serde_json::json!({ "t": "error", "message": message }))).await;
        let _ = socket.send(Message::Close(None)).await;
    }
    device
}

async fn connection(ctx: Ctx, mut socket: WebSocket) {
    let shared = Arc::clone(&ctx.shared);
    let Some(device) = authenticate(&shared, &mut socket).await else { return };
    // The device may have been revoked, or the server stopped, while the
    // handshake ran.
    if *ctx.shutdown.borrow() {
        return;
    }
    shared.touch_device(&device.id);
    let (kick_tx, mut kick_rx) = watch::channel(false);
    let conn_id = shared.register_conn(&device.id, kick_tx);
    let mut shutdown = ctx.shutdown.clone();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    // Keystrokes go through one queue + one worker so they reach the pty in
    // order; each write can block, so it runs on the blocking pool.
    let (input_tx, mut input_rx) = mpsc::unbounded_channel::<(String, String)>();
    let app = shared.app.clone();
    let writer = tokio::spawn(async move {
        while let Some((pty_id, data)) = input_rx.recv().await {
            let app = app.clone();
            let _ = crate::blocking(move || app.state::<PtyState>().write(&pty_id, &data)).await;
        }
    });

    let mut conn = Conn { shared: Arc::clone(&shared), out_tx, input_tx, subs: HashMap::new(), last_tabs: String::new() };
    let _ = socket
        .send(text(serde_json::json!({ "t": "ready", "deviceName": device.name })))
        .await;
    let mut tick = tokio::time::interval(TABS_INTERVAL);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            msg = socket.recv() => match msg {
                Some(Ok(Message::Text(raw))) => conn.handle(raw.as_str()).await,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                _ => {}
            },
            Some(out) = out_rx.recv() => {
                if socket.send(Message::Text(out.into())).await.is_err() {
                    break;
                }
            }
            _ = tick.tick() => conn.push_tabs_if_changed().await,
            _ = kick_rx.changed() => break,
            _ = shutdown.changed() => break,
        }
    }
    for (_, task) in conn.subs.drain() {
        task.abort();
    }
    writer.abort();
    shared.unregister_conn(conn_id);
    let _ = socket.send(Message::Close(None)).await;
}

struct Conn {
    shared: Arc<Shared>,
    out_tx: mpsc::UnboundedSender<String>,
    input_tx: mpsc::UnboundedSender<(String, String)>,
    /// pty id -> the task streaming it to this client.
    subs: HashMap<String, tokio::task::JoinHandle<()>>,
    last_tabs: String,
}

impl Conn {
    fn send(&self, value: serde_json::Value) {
        let _ = self.out_tx.send(value.to_string());
    }

    async fn tabs_json(&self) -> String {
        serde_json::json!({ "t": "tabs", "tabs": self.shared.tabs().await }).to_string()
    }

    async fn push_tabs_if_changed(&mut self) {
        let json = self.tabs_json().await;
        if json != self.last_tabs {
            self.last_tabs = json.clone();
            let _ = self.out_tx.send(json);
        }
    }

    async fn handle(&mut self, raw: &str) {
        let Ok(msg) = serde_json::from_str::<ClientMsg>(raw) else { return };
        match msg {
            ClientMsg::Auth { .. } => {}
            ClientMsg::Ping => self.send(serde_json::json!({ "t": "pong" })),
            ClientMsg::List => {
                let json = self.tabs_json().await;
                self.last_tabs = json.clone();
                let _ = self.out_tx.send(json);
            }
            ClientMsg::Open { pty_id } => {
                if let Some(old) = self.subs.remove(&pty_id) {
                    old.abort();
                }
                let task = tokio::spawn(stream_pty(Arc::clone(&self.shared), pty_id.clone(), self.out_tx.clone()));
                self.subs.insert(pty_id, task);
            }
            ClientMsg::Close { pty_id } => {
                if let Some(task) = self.subs.remove(&pty_id) {
                    task.abort();
                }
            }
            ClientMsg::Input { pty_id, data } => {
                if data.len() > MAX_INPUT_BYTES {
                    let message = tr("Input troppo lungo", "Input too large");
                    self.send(serde_json::json!({ "t": "error", "ptyId": pty_id, "message": message }));
                } else {
                    let _ = self.input_tx.send((pty_id, data));
                }
            }
        }
    }
}

/// Drops a pending snapshot request if its stream is cancelled or times out.
struct WaiterGuard<'a>(&'a Shared, String);

impl Drop for WaiterGuard<'_> {
    fn drop(&mut self) {
        lock(&self.0.waiters).remove(&self.1);
    }
}

/// One client's view of one pty: snapshot of the current screen, then the
/// live output. Subscribes *before* asking for the snapshot so no output can
/// fall in the gap; whatever the snapshot already includes (seq <= its seq)
/// is skipped.
async fn stream_pty(shared: Arc<Shared>, pty_id: String, out: mpsc::UnboundedSender<String>) {
    let subscription = shared.app.state::<PtyState>().remote_subscribe(&pty_id);
    let Some((mut rx, cols, rows, owner)) = subscription else {
        let message = tr("Terminale non trovato", "Terminal not found");
        let _ = out.send(serde_json::json!({ "t": "error", "ptyId": pty_id, "message": message }).to_string());
        let _ = out.send(serde_json::json!({ "t": "exit", "ptyId": pty_id }).to_string());
        return;
    };

    let mut snapshot: SnapshotReply = (String::new(), 0);
    if let Some(owner) = owner {
        let req_id = match random_hex(8) {
            Ok(id) => id,
            Err(_) => return,
        };
        let (tx, reply) = oneshot::channel();
        lock(&shared.waiters).insert(req_id.clone(), tx);
        let _guard = WaiterGuard(&shared, req_id.clone());
        let payload = serde_json::json!({ "reqId": req_id, "ptyId": pty_id });
        if shared.app.emit_to(owner.as_str(), EVT_SNAPSHOT_REQUEST, payload).is_ok() {
            if let Ok(Ok(reply)) = tokio::time::timeout(SNAPSHOT_TIMEOUT, reply).await {
                snapshot = reply;
            }
        }
    }
    let (data, snapshot_seq) = snapshot;
    let _ = out.send(
        serde_json::json!({ "t": "snapshot", "ptyId": pty_id, "data": data, "cols": cols, "rows": rows }).to_string(),
    );

    while let Some(event) = rx.recv().await {
        match event {
            RemoteOut::Output { data, seq } if seq > snapshot_seq => {
                let _ = out.send(serde_json::json!({ "t": "output", "ptyId": pty_id, "data": data }).to_string());
            }
            RemoteOut::Output { .. } => {}
            RemoteOut::Exit => break,
        }
    }
    // Either the program exited or the session vanished: both end the stream.
    let _ = out.send(serde_json::json!({ "t": "exit", "ptyId": pty_id }).to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_hash_and_constant_time_compare() {
        // Known SHA-256 of "abc".
        assert_eq!(hash_token("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert!(ct_eq(b"same", b"same"));
        assert!(!ct_eq(b"same", b"sama"));
        assert!(!ct_eq(b"same", b"sam"));
        assert_eq!(random_hex(32).unwrap().len(), 64);
    }

    #[test]
    fn pairing_code_is_single_use_and_expires() {
        let mut p = Pairings::default();
        let (code, expires) = p.start("c0de".into(), 1_000);
        assert_eq!(expires, 1_000 + PAIR_TTL_MS);
        assert_eq!(p.redeem(&code, 2_000), Ok(()));
        assert_eq!(p.redeem(&code, 3_000), Err(PairError::Invalid));

        let (code, expires) = p.start("beef".into(), 10_000);
        assert_eq!(p.redeem(&code, expires), Err(PairError::Invalid));
        // Expired codes are gone for good, even if asked again "in time".
        assert_eq!(p.redeem(&code, 10_001), Err(PairError::Invalid));

        // A new code replaces the old one.
        p.start("aaaa".into(), 20_000);
        p.start("bbbb".into(), 20_001);
        assert_eq!(p.redeem("aaaa", 20_002), Err(PairError::Invalid));
        assert_eq!(p.redeem("bbbb", 20_003), Ok(()));
    }

    #[test]
    fn pairing_failures_are_rate_limited() {
        let mut p = Pairings::default();
        p.start("good".into(), 0);
        for i in 0..MAX_PAIR_FAILURES as u64 {
            assert_eq!(p.redeem("bad", 100 + i), Err(PairError::Invalid));
        }
        // Blocked: even the right code is refused...
        assert_eq!(p.redeem("good", 1_000), Err(PairError::RateLimited));
        // ...until the block ends.
        assert_eq!(p.redeem("good", 200 + BLOCK_MS), Ok(()));
    }

    #[test]
    fn old_failures_do_not_count() {
        let mut p = Pairings::default();
        for i in 0..(MAX_PAIR_FAILURES as u64 - 1) {
            assert_eq!(p.redeem("bad", i), Err(PairError::Invalid));
        }
        // The window has passed: this is failure #1 again, not #5.
        assert_eq!(p.redeem("bad", FAIL_WINDOW_MS + 100), Err(PairError::Invalid));
        assert_eq!(p.redeem("bad", FAIL_WINDOW_MS + 101), Err(PairError::Invalid));
    }

    #[test]
    fn picks_the_tailscale_address() {
        let ip = |a, b, c, d| Ipv4Addr::new(a, b, c, d);
        let ifaces = vec![
            ("Ethernet".to_string(), ip(192, 168, 1, 5)),
            ("vpn0".to_string(), ip(100, 100, 1, 1)),
            ("Tailscale".to_string(), ip(100, 90, 2, 3)),
            ("lo".to_string(), ip(127, 0, 0, 1)),
        ];
        assert_eq!(pick_tailscale_ip(&ifaces), Some(ip(100, 90, 2, 3)));
        assert_eq!(pick_tailscale_ip(&ifaces[..2]), Some(ip(100, 100, 1, 1)));
        // Just outside 100.64.0.0/10.
        assert!(!is_tailscale_ip(ip(100, 63, 255, 255)));
        assert!(is_tailscale_ip(ip(100, 64, 0, 0)));
        assert!(is_tailscale_ip(ip(100, 127, 255, 255)));
        assert!(!is_tailscale_ip(ip(100, 128, 0, 0)));
        assert_eq!(pick_tailscale_ip(&ifaces[..1]), None);
        assert_eq!(pick_tailscale_ip(&[]), None);
    }

    #[test]
    fn origin_must_match_exactly() {
        let expected = "http://100.64.1.2:7799";
        assert!(origin_allowed(Some(expected), expected));
        assert!(!origin_allowed(None, expected));
        assert!(!origin_allowed(Some("http://evil.example"), expected));
        assert!(!origin_allowed(Some("http://100.64.1.2:7799/"), expected));
        assert!(!origin_allowed(Some("https://100.64.1.2:7799"), expected));
    }
}
