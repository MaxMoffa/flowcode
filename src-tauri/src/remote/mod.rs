//! Remote access: an iroh endpoint inside the desktop app that streams the
//! terminals to the Flowcode phone app. iroh gives us QUIC with NAT traversal
//! and a relay fallback, so it works across networks with no VPN and no open
//! port, and every connection is authenticated end-to-end by the peers' keys.
//!
//! Security model: off by default. A new phone proves it saw the QR code by
//! sending the one-time pairing code, and gets a device token back. After
//! that a connection is accepted only if it presents the token *and* comes
//! from the iroh node id that paired - a stolen token alone is useless. Only
//! SHA-256 hashes of tokens are stored. The wire format lives in the
//! `flowcode-remote-proto` crate (docs/remote-protocol.md).

mod auth;
mod chat;
mod connlog;
mod fsbrowse;
mod hex;
pub(crate) mod keystore;
mod stream;
mod views;

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flowcode_remote_proto::{
    self as proto, encode_frame, read_frame, write_frame, Action, ChatInfo, ClientMsg, FrameError, PairingTicket, ServerMsg, Tab,
    TabContext, UsageItem,
};
use flowcode_shared::i18n::{is_italian, tr};
use iroh::endpoint::{presets, Connection, IdleTimeout, QuicTransportConfig, RecvStream, SendStream};
use iroh::Endpoint;
use iroh_tickets::endpoint::EndpointTicket;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::chat::{AlertKind, ChatAlert, ChatState};
use crate::pty::PtyState;
use crate::util::{lock, now_ms};

use self::auth::{clean_name, AuthLimiter, Config, Device, PairError, Pairings};
use self::chat::{agent_name, stream_chat};
use self::stream::stream_pty;
use self::connlog::{short_id, ConnLog};
use self::fsbrowse::{list_dir, read_text};
use self::hex::random_hex;
use self::keystore::{acquire_instance_lock, load_or_create_key};

/// Before authenticating, a peer gets this long for each step (QUIC
/// handshake, opening the stream, its first frame). A phone on a good path
/// needs well under a second, but one on mobile data behind a relay (lost
/// first packets, 1 s retransmits) can need several: 5 s turned those into
/// failed first attempts. Strangers are still bounded by the slot caps.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections not yet authenticated, however far along; more than this are
/// refused so a flood can't pile up tasks. The node id isn't known until
/// the QUIC handshake is done, so this is the only cap that early.
const MAX_HANDSHAKING: usize = 64;
/// Of those, how many may come from nodes that aren't a paired device (this
/// includes a new phone waiting for the user's confirmation). Paired phones
/// aren't limited by it, so strangers can't lock them out.
const MAX_UNKNOWN_HANDSHAKING: usize = 4;
const TABS_INTERVAL: Duration = Duration::from_secs(2);
/// Agent detection walks the process table, so one background task refreshes
/// the tab list (every `TABS_INTERVAL`, while a phone is connected) and the
/// connections only read the latest result. A result this old is too stale to
/// hand a phone that just connected: it is refreshed first.
const TABS_CACHE: Duration = Duration::from_millis(2500);
/// QUIC drops a link after this much silence. The phone pings every 20 s and
/// gives up after 60-90 s, so this stays comfortably above that (the actual
/// timeout is the smaller of the two peers'); the keep-alive below keeps a
/// quiet but healthy link from ever reaching it.
const QUIC_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// How often the desktop sends a QUIC keep-alive. The phone drives liveness
/// (its own pings and keep-alives), so the desktop stays quiet and lets a
/// backgrounded phone's radio idle instead of waking it every 5 s.
const QUIC_KEEP_ALIVE: Duration = Duration::from_secs(25);
/// Frames queued for one phone before it counts as not reading (the pty
/// output of a phone that is merely slow is dropped well before that, see
/// `OUT_RESERVE`). Output frames are at most ~8 KiB, so ~8 MiB per phone.
const OUT_QUEUE: usize = 1024;
/// Slots of `OUT_QUEUE` kept for replies and pushes: terminal output stops
/// (and resyncs later) when only this many are free.
const OUT_RESERVE: usize = 64;
/// Bulk replies (see `is_bulk`) held back while interactive frames go first;
/// past this many the writer sends one before taking more from the queue, so
/// the held ones can't grow without limit.
const BULK_HELD: usize = 64;
/// Frames already queued are written together, up to about this many bytes per write.
const WRITE_BATCH: usize = 64 * 1024;
/// How often a connection's measured link quality (path, round trip, rate,
/// loss) is logged.
const METRICS_EVERY: Duration = Duration::from_secs(60);
/// Frames from the phone queued before the connection loop gets to them. A
/// phone that outruns this is hung up on.
const IN_QUEUE: usize = 256;
/// Terminals one connection may have open.
const MAX_SUBS: usize = 64;
/// Chats one connection may follow.
const MAX_CHAT_SUBS: usize = 16;
/// Longest chat, view, mode or option id a phone may name.
const MAX_ID_BYTES: usize = 128;
/// Longest URL a phone may ask a preview of.
const LINK_URL_MAX_BYTES: usize = 2048;
/// Largest `linkpreview` reply, JSON bytes: under a frame, with room for the envelope.
const LINK_PREVIEW_MAX_BYTES: usize = 900 * 1024;
/// How long a pty keeps the phone's size after the last phone stopped sizing
/// it, so a reattach or reconnect doesn't resize it back and forth.
const RELEASE_GRACE: Duration = Duration::from_secs(4);
/// Largest `set` value, as JSON.
const MAX_SET_BYTES: usize = 4096;
/// Reading a transcript's tail is cheap but not free, and the figure only
/// moves when the agent answers.
const CONTEXT_CACHE: Duration = Duration::from_secs(10);
const LAST_SEEN_PERSIST_MS: u64 = 60_000;
/// How long to wait for the endpoint to reach a relay before making a
/// pairing ticket anyway (it then carries only direct addresses).
const ONLINE_TIMEOUT: Duration = Duration::from_secs(5);
const EVT_DEVICES_CHANGED: &str = "remote://devices-changed";
const EVT_SNAPSHOT_REQUEST: &str = "remote://snapshot-request";
const EVT_SIZE_OVERRIDE: &str = "remote://size-override";
const EVT_RUN_ACTION: &str = "remote://run-action";
const EVT_SET_SETTING: &str = "remote://set-setting";
/// A phone asked for a new terminal tab (see `ClientMsg::NewTab`).
const EVT_NEW_TAB: &str = "remote://new-tab";
/// `{op, id?, name?, color?, copySettings?, deleteFiles?}`: a profile change, to the leader window only.
const EVT_PROFILE: &str = "remote://profile";
/// `{id, cli}`: sign a CLI in under a profile (`id` empty = the default; needs the window's terminal tabs), to the leader window only.
const EVT_PROFILE_LOGIN: &str = "remote://profile-login";
const EVT_PAIR_REQUEST: &str = "remote://pair-request";
/// `{reqId}`: the request went away unanswered (timeout, phone left).
const EVT_PAIR_CANCEL: &str = "remote://pair-cancel";
/// A phone sent an Enter to a pty: its window counts it as a submit (see ptyClient's `lastSubmitAt`).
const EVT_SUBMIT: &str = "remote://submit";
/// `{ptyId, label}`: a phone renamed the tab showing that pty, to its owner window.
const EVT_RENAME_TAB: &str = "remote://rename-tab";
/// `{ptyId}`: a phone closed the tab showing that pty, to its owner window.
const EVT_CLOSE_TAB: &str = "remote://close-tab";
/// `{tabId}`: a phone handed a chat over to a terminal tab, to the window showing the chat.
const EVT_CHAT_TERMINAL: &str = "remote://chat-terminal";
/// `{ptyId}`: a phone asked to reopen a terminal tab's agent as a chat, to its owner window.
const EVT_TERMINAL_CHAT: &str = "remote://terminal-chat";
/// `{tabId, label}`: a phone renamed a chat tab, to the window showing it.
const EVT_CHAT_RENAME: &str = "remote://chat-rename";
/// `{tabId}`: a phone closed a chat tab, to the window showing it.
const EVT_CHAT_CLOSE: &str = "remote://chat-close";
/// A phone asked for a new chat tab (see `ClientMsg::NewChat`).
const EVT_NEW_CHAT: &str = "remote://new-chat";
/// How long the user has to confirm a new phone on the desktop. The phone
/// waits longer for its reply (see mobile/src-tauri/src/link.rs).
const PAIR_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);
/// A known phone connecting again within this long of its last connection
/// doesn't raise another notification.
const CONNECT_NOTIFY_QUIET: Duration = Duration::from_secs(10 * 60);
/// See `Conn::input_error_at`.
const INPUT_ERROR_QUIET: Duration = Duration::from_secs(3);

// ---- shared state --------------------------------------------------------

struct ConnEntry {
    device_id: String,
    kick: watch::Sender<bool>,
}

struct Running {
    endpoint: Endpoint,
    node_id: String,
    shutdown: watch::Sender<bool>,
    /// Keeps the instance lock (see `acquire_instance_lock`) while running.
    _instance_lock: std::fs::File,
}

#[derive(Default)]
struct Runtime {
    running: Option<Running>,
    error: Option<String>,
}

type SnapshotReply = (String, u64);
/// A held-back size release: the owner's id and the (cols, rows) to restore.
type PendingRelease = (u64, (u16, u16));

/// One phone's claim on a pty's size.
struct SizeClaim {
    conn: u64,
    cols: u16,
    rows: u16,
}

struct Shared {
    app: AppHandle,
    config_path: PathBuf,
    key_path: PathBuf,
    host_name: String,
    config: Mutex<Config>,
    /// Serializes start/stop so toggling quickly can't race two endpoints.
    lifecycle: tokio::sync::Mutex<()>,
    runtime: Mutex<Runtime>,
    pairings: Mutex<Pairings>,
    conns: Mutex<HashMap<u64, ConnEntry>>,
    next_conn: AtomicU64,
    handshaking: AtomicUsize,
    /// Of `handshaking`, those from nodes that aren't paired devices.
    handshaking_unknown: AtomicUsize,
    auth_limiter: Mutex<AuthLimiter>,
    /// Connection diagnostics: stderr plus `remote.log` next to the node key.
    log: ConnLog,
    waiters: Mutex<HashMap<String, oneshot::Sender<SnapshotReply>>>,
    /// Pairing requests awaiting the user's answer on the desktop.
    pair_waiters: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    /// device id -> when it last disconnected, to notify only on a "fresh" connect.
    last_active: Mutex<HashMap<String, Instant>>,
    /// The latest tab list and when it was built (`None` until the first
    /// build); connections only read it, `refresh_tabs` is the one writer.
    tabs: watch::Sender<Option<(Instant, Vec<Tab>)>>,
    /// Serializes `refresh_tabs`, so concurrent callers share one scan.
    tabs_build: tokio::sync::Mutex<()>,
    /// Asks the refresh task for a build now (the window reported its tabs).
    tabs_wake: tokio::sync::Notify,
    /// pty id -> (when read, the figure) for the tab's agent.
    context_cache: Mutex<HashMap<String, (Instant, Option<TabContext>)>>,
    last_persisted_seen: Mutex<u64>,
    /// Latest usage / actions the desktop frontend published; connections
    /// watch these and push changes.
    usage: watch::Sender<Vec<UsageItem>>,
    actions: watch::Sender<Vec<Action>>,
    /// Latest desktop settings the frontend published for the phone to mirror
    /// (`Null` until the first publish).
    settings: watch::Sender<serde_json::Value>,
    /// Latest account profiles the frontend published, as `{profiles, defaultLoggedIn}` (`Null` until then).
    profiles: watch::Sender<serde_json::Value>,
    /// Desktop notifications mirrored to every connected phone.
    notices: broadcast::Sender<ServerMsg>,
    /// view id -> hash of its package, as the last listing worked it out.
    view_hashes: Mutex<HashMap<String, String>>,
    /// pty id -> phones sizing it, oldest first (the last one wins).
    sizing: Mutex<HashMap<String, Vec<SizeClaim>>>,
    /// pty id -> (release id, size) for a pty whose last phone let go less
    /// than `RELEASE_GRACE` ago: it still has that size, and the deferred
    /// release only applies if its id is still the one stored here (a new
    /// claim removes the entry).
    pending_release: Mutex<HashMap<String, PendingRelease>>,
    release_seq: AtomicU64,
    /// pty id -> window that showed it when last looked at, for the ptys a
    /// phone is sizing: a change means the tab moved and the new window
    /// must be told about the size override.
    size_owners: Mutex<HashMap<String, String>>,
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
    node_id: Option<String>,
    error: Option<String>,
    devices: Vec<DeviceStatus>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairStart {
    /// The `flowcode://pair?t=...` link the QR code encodes.
    ticket: String,
    code: String,
    expires_at: u64,
}

/// A phone's current claim on a pty's size (see `remote_size_claim`).
#[derive(Serialize)]
pub struct SizeInfo {
    cols: u16,
    rows: u16,
}

impl RemoteState {
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
            profiles: watch::channel(serde_json::Value::Null).0,
            notices: broadcast::channel(32).0,
            view_hashes: Mutex::new(HashMap::new()),
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
        RemoteStatus {
            enabled: config.enabled,
            running: runtime.running.is_some(),
            node_id: runtime.running.as_ref().map(|r| r.node_id.clone()),
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
            self.stop().await;
        }
        self.status()
    }

    async fn stop(&self) {
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
            Err(message) => {
                self.log.line(&format!("endpoint failed to start: {message}"));
                lock(&self.runtime).error = Some(message);
            }
        }
    }

    async fn try_start(self: &Arc<Self>) -> Result<Running, String> {
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
    fn is_known_node(&self, node_id: &str) -> bool {
        lock(&self.config).devices.iter().any(|d| d.node_id == node_id)
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
        if let Some(entry) = lock(&self.conns).remove(&id) {
            lock(&self.last_active).insert(entry.device_id, Instant::now());
        }
        self.devices_changed();
    }

    /// Whether a connection from `device_id` is worth a notification: not if
    /// it is already connected or was within `CONNECT_NOTIFY_QUIET`.
    fn is_fresh_connect(&self, device_id: &str) -> bool {
        if lock(&self.conns).values().any(|c| c.device_id == device_id) {
            return false;
        }
        lock(&self.last_active).get(device_id).is_none_or(|t| t.elapsed() >= CONNECT_NOTIFY_QUIET)
    }

    /// Native notification, off the caller's thread (the first one registers
    /// the toast source).
    fn notify(&self, title: String, body: String) {
        let app = self.app.clone();
        let label = self.default_window().unwrap_or_default();
        tauri::async_runtime::spawn_blocking(move || crate::notify::show(app, label, String::new(), title, body));
    }

    fn focus_window(&self, label: &str) {
        if let Some(window) = self.app.get_webview_window(label) {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    fn revoke(&self, device_id: &str) {
        lock(&self.config).devices.retain(|d| d.id != device_id);
        self.save();
        for conn in lock(&self.conns).values().filter(|c| c.device_id == device_id) {
            let _ = conn.kick.send(true);
        }
        self.devices_changed();
    }

    // ---- phone-sized terminals ---------------------------------------------

    /// `conn` sizes `pty` for its screen; the most recent claimant wins.
    fn claim_size(&self, pty_id: &str, conn: u64, cols: u16, rows: u16) {
        // A phone could name any id: a claim on a pty that isn't there would
        // just linger.
        if !self.app.state::<PtyState>().exists(pty_id) {
            return;
        }
        // A sane range: zero would panic the terminal, huge values waste memory.
        let (cols, rows) = (cols.clamp(10, 500), rows.clamp(3, 300));
        let before = {
            let mut sizing = lock(&self.sizing);
            let claims = sizing.entry(pty_id.to_string()).or_default();
            let before = claims.last().map(|c| (c.cols, c.rows));
            claims.retain(|c| c.conn != conn);
            claims.push(SizeClaim { conn, cols, rows });
            before
        };
        // A claim during the grace period cancels the deferred release; the
        // pty still has the size it was left with.
        let held = lock(&self.pending_release).remove(pty_id).map(|(_, size)| size);
        // Same size as before: resizing again would only make a TUI redraw.
        if before.or(held) == Some((cols, rows)) {
            return;
        }
        self.apply_size(pty_id, Some((cols, rows)));
    }

    /// `conn` stopped sizing `pty`: the previous claimant's size comes back,
    /// or the desktop's own when there is none.
    /// When no phone is left the desktop's size only comes back after
    /// `RELEASE_GRACE`, unless a phone claims the pty again before.
    fn release_size(self: &Arc<Self>, pty_id: &str, conn: u64) {
        let (prev, next) = {
            let mut sizing = lock(&self.sizing);
            let Some(claims) = sizing.get_mut(pty_id) else { return };
            let before = claims.len();
            let prev = claims.last().map(|c| (c.cols, c.rows));
            claims.retain(|c| c.conn != conn);
            if claims.len() == before {
                return;
            }
            let next = claims.last().map(|c| (c.cols, c.rows));
            if claims.is_empty() {
                sizing.remove(pty_id);
            }
            (prev, next)
        };
        match (prev, next) {
            // Another phone keeps the size in force: nothing changes.
            (Some(p), Some(n)) if p == n => {}
            (_, Some(_)) => self.apply_size(pty_id, next),
            (None, None) => {}
            (Some(size), None) => {
                let id = self.release_seq.fetch_add(1, Ordering::Relaxed) + 1;
                lock(&self.pending_release).insert(pty_id.to_string(), (id, size));
                let shared = Arc::clone(self);
                let pty_id = pty_id.to_string();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(RELEASE_GRACE).await;
                    let due = {
                        let mut pending = lock(&shared.pending_release);
                        if pending.get(&pty_id).is_some_and(|(i, _)| *i == id) {
                            pending.remove(&pty_id);
                            true
                        } else {
                            false
                        }
                    };
                    if due && !lock(&shared.sizing).contains_key(&pty_id) {
                        shared.apply_size(&pty_id, None);
                    }
                });
            }
        }
    }

    fn release_all_sizes(self: &Arc<Self>, conn: u64) {
        let ptys: Vec<String> =
            lock(&self.sizing).iter().filter(|(_, c)| c.iter().any(|c| c.conn == conn)).map(|(p, _)| p.clone()).collect();
        for pty in ptys {
            self.release_size(&pty, conn);
        }
    }

    /// Resizes the pty and tells the window showing it (it shrinks its
    /// terminal to match). `None` hands control back: the window refits and
    /// resizes the pty itself through its normal path.
    fn apply_size(&self, pty_id: &str, size: Option<(u16, u16)>) {
        let pty = self.app.state::<PtyState>();
        if let Some((cols, rows)) = size {
            let _ = pty.resize(pty_id, cols, rows);
        }
        if let Some(owner) = pty.owner_of(pty_id) {
            self.emit_size_override(&owner, pty_id, size);
        }
    }

    fn emit_size_override(&self, window: &str, pty_id: &str, size: Option<(u16, u16)>) {
        let payload = serde_json::json!({ "ptyId": pty_id, "cols": size.map(|s| s.0), "rows": size.map(|s| s.1) });
        let _ = self.app.emit_to(window, EVT_SIZE_OVERRIDE, payload);
    }

    /// The size the most recent phone claimed for `pty_id`, if any.
    fn size_claim(&self, pty_id: &str) -> Option<(u16, u16)> {
        lock(&self.sizing).get(pty_id)?.last().map(|c| (c.cols, c.rows))
    }

    /// Tells the window now showing a phone-sized pty about the override when
    /// the tab moved there from another window (it would otherwise fit the
    /// terminal to its own size and resize the pty back under the phone).
    fn sync_size_owners(&self, tabs: &[Tab]) {
        let mut moved: Vec<(String, String, (u16, u16))> = Vec::new();
        {
            let sizing = lock(&self.sizing);
            let mut owners = lock(&self.size_owners);
            owners.retain(|pty, _| sizing.contains_key(pty));
            for tab in tabs {
                let Some(claim) = sizing.get(&tab.pty_id).and_then(|c| c.last()) else { continue };
                let previous = owners.insert(tab.pty_id.clone(), tab.window.clone());
                if previous.is_some_and(|window| window != tab.window) {
                    moved.push((tab.window.clone(), tab.pty_id.clone(), (claim.cols, claim.rows)));
                }
            }
        }
        for (window, pty_id, size) in moved {
            self.emit_size_override(&window, &pty_id, Some(size));
        }
    }

    // ---- tabs --------------------------------------------------------------

    /// The latest tab list, never scanning: empty until the first build.
    fn latest_tabs(&self) -> Vec<Tab> {
        self.tabs.borrow().as_ref().map(|(_, tabs)| tabs.clone()).unwrap_or_default()
    }

    /// Rebuilds the tab list unless one younger than `max_age` exists (a
    /// concurrent caller's counts), and returns the latest. This is where the
    /// process scan happens; only `tabs_task` and a new connection call it,
    /// never the loop that serves a phone's input.
    async fn refresh_tabs(&self, max_age: Duration) -> Vec<Tab> {
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
    fn has_conns(&self) -> bool {
        !lock(&self.conns).is_empty()
    }

    /// `WindowTabs` entries that have a live pty, joined with the agent running
    /// in each (same source as the Agents panel) and its context fill.
    async fn build_tabs(&self) -> Vec<Tab> {
        let app = &self.app;
        let sizes = app.state::<PtyState>().sizes();
        let sessions = crate::agents::collect_agent_sessions(app).await.unwrap_or_default();
        let contexts = self.contexts_for(&sessions).await;
        let agents: HashMap<String, (String, Option<String>, Option<String>)> =
            sessions.into_iter().map(|s| (s.pty_id, (s.cli, s.status, s.profile))).collect();
        app.state::<crate::windows::WindowTabs>()
            .list()
            .into_iter()
            .filter_map(|(window, tab)| {
                let pty_id = tab.pty_id?;
                let (cols, rows) = *sizes.get(&pty_id)?;
                let (cli, status, profile) = match agents.get(&pty_id) {
                    Some((cli, status, profile)) => (Some(cli.clone()), status.clone(), profile.clone()),
                    None => (None, None, None),
                };
                let context = contexts.get(&pty_id).cloned().flatten();
                Some(Tab { pty_id, tab_id: tab.tab_id, window, label: tab.label, cwd: tab.cwd, cli, profile, status, cols, rows, context })
            })
            .collect()
    }

    /// The running chats that have a tab (one reported by its window), in the
    /// order the windows report them. A chat is matched to its tab by agent
    /// session: the frontend knows the tab, the backend the chat, and both know
    /// the session.
    fn chat_infos(&self) -> Vec<ChatInfo> {
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
                })
            })
            .collect()
    }

    /// Tells the phones a chat needs them: an agent waiting for a permission
    /// answer, or one that finished its turn.
    fn notify_chat(&self, alert: ChatAlert) {
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
    async fn contexts_for(&self, sessions: &[crate::agents::AgentSession]) -> HashMap<String, Option<TabContext>> {
        let wanted: Vec<_> = sessions
            .iter()
            .filter(|s| matches!(s.cli.as_str(), "claude" | "codex"))
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
    fn default_window(&self) -> Option<String> {
        if self.app.get_webview_window("main").is_some() {
            return Some("main".to_string());
        }
        let mut labels: Vec<String> = self.app.webview_windows().into_keys().collect();
        labels.sort();
        labels.into_iter().next()
    }
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

/// A pairing code and the QR link carrying it. A code generated less than
/// `PAIR_REUSE_MS` ago is returned again unless `force` (the "Regenerate"
/// button) asks for a new one.
#[tauri::command]
pub async fn remote_pair_start(state: tauri::State<'_, RemoteState>, force: Option<bool>) -> Result<PairStart, String> {
    let shared = Arc::clone(&state.0);
    let endpoint = lock(&shared.runtime).running.as_ref().map(|r| r.endpoint.clone());
    let Some(endpoint) = endpoint else {
        return Err(tr("Accesso remoto non attivo", "Remote access is not running").to_string());
    };
    // Decided before the awaits below: two calls racing each other (React
    // StrictMode runs effects twice) must end up with the same code.
    let (code, expires_at) = {
        let mut pairings = lock(&shared.pairings);
        let now = now_ms();
        match pairings.recent(now).filter(|_| !force.unwrap_or(false)) {
            Some(current) => current,
            None => pairings.start(random_hex(16)?, now),
        }
    };
    // Wait for the relay so the ticket tells the phone how to reach us from
    // another network; without it only the (usually unreachable) direct
    // addresses would be in the QR code.
    let _ = tokio::time::timeout(ONLINE_TIMEOUT, endpoint.online()).await;
    let node = EndpointTicket::new(endpoint.addr()).to_string();
    let ticket = PairingTicket { node, code: code.clone(), host: shared.host_name.clone() }.encode();
    Ok(PairStart { ticket, code, expires_at })
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

/// The desktop's current usage readings, for the phone's usage screen.
#[tauri::command]
pub fn remote_publish_usage(state: tauri::State<'_, RemoteState>, items: Vec<UsageItem>) {
    publish(&state.0.usage, items);
}

/// The desktop settings the phone mirrors (built by the frontend's RemoteSettingsBridge).
#[tauri::command]
pub fn remote_publish_settings(state: tauri::State<'_, RemoteState>, settings: serde_json::Value) {
    publish(&state.0.settings, settings);
}

/// The account profiles the phone lists (built by the frontend's RemoteSettingsBridge).
#[tauri::command]
pub fn remote_publish_profiles(state: tauri::State<'_, RemoteState>, profiles: serde_json::Value, default_logged_in: Option<serde_json::Value>) {
    publish(&state.0.profiles, serde_json::json!({ "profiles": profiles, "defaultLoggedIn": default_logged_in }));
}

/// The `profiles` message for what the frontend published; none until it has.
fn profiles_msg(published: &serde_json::Value) -> Option<ServerMsg> {
    let profiles = published.get("profiles").filter(|p| !p.is_null())?.clone();
    let default_logged_in = published.get("defaultLoggedIn").filter(|d| !d.is_null()).cloned();
    Some(ServerMsg::Profiles { profiles, default_logged_in })
}

/// The quick actions the phone may trigger.
#[tauri::command]
pub fn remote_publish_actions(state: tauri::State<'_, RemoteState>, actions: Vec<Action>) {
    publish(&state.0.actions, actions);
}

/// Stores `value` in the watch channel, waking the connections only if it
/// differs from what they already have.
fn publish<T: PartialEq>(tx: &watch::Sender<T>, value: T) {
    tx.send_if_modified(|current| {
        let changed = *current != value;
        if changed {
            *current = value;
        }
        changed
    });
}

/// The user's answer to a pairing request shown on the desktop.
#[tauri::command]
pub fn remote_pair_decide(state: tauri::State<'_, RemoteState>, req_id: String, accept: bool) {
    if let Some(waiter) = lock(&state.0.pair_waiters).remove(&req_id) {
        let _ = waiter.send(accept);
    }
}

/// Invalidates the active pairing code (the QR dialog was closed).
#[tauri::command]
pub fn remote_pair_cancel(state: tauri::State<'_, RemoteState>) {
    lock(&state.0.pairings).active = None;
}

/// The size a phone currently claims for `pty_id`, so a window that has just
/// adopted the tab can re-apply the override.
#[tauri::command]
pub fn remote_size_claim(state: tauri::State<'_, RemoteState>, pty_id: String) -> Option<SizeInfo> {
    state.0.size_claim(&pty_id).map(|(cols, rows)| SizeInfo { cols, rows })
}

// ---- connections -----------------------------------------------------------

async fn accept_loop(shared: Arc<Shared>, endpoint: Endpoint, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break };
                // Counted before the task is spawned, so a burst can't slip
                // past the cap while its tasks are still starting.
                if shared.handshaking.fetch_add(1, Ordering::AcqRel) >= MAX_HANDSHAKING {
                    shared.handshaking.fetch_sub(1, Ordering::AcqRel);
                    shared.log.line(&format!("refused {:?}: {MAX_HANDSHAKING} handshakes already in progress", incoming.remote_addr()));
                    incoming.refuse();
                    continue;
                }
                let guard = HandshakeGuard { shared: Arc::clone(&shared), counted: true, unknown: false };
                let shutdown = shutdown.clone();
                tauri::async_runtime::spawn(async move {
                    let shared = Arc::clone(&guard.shared);
                    let from = format!("{:?}", incoming.remote_addr());
                    let started = Instant::now();
                    let connection = match incoming.accept() {
                        Ok(accepting) => match tokio::time::timeout(HANDSHAKE_TIMEOUT, accepting).await {
                            Ok(Ok(connection)) => Some(connection),
                            Ok(Err(e)) => {
                                shared.log.line(&format!("incoming {from}: QUIC handshake failed after {} ms: {e}", started.elapsed().as_millis()));
                                None
                            }
                            Err(_) => {
                                shared.log.line(&format!("incoming {from}: QUIC handshake timed out after {} s", HANDSHAKE_TIMEOUT.as_secs()));
                                None
                            }
                        },
                        Err(e) => {
                            shared.log.line(&format!("incoming {from}: not accepted: {e}"));
                            None
                        }
                    };
                    // Without a connection the guard just drops.
                    if let Some(connection) = connection {
                        shared.log.line(&format!(
                            "peer {}: QUIC connected from {from} in {} ms",
                            short_id(&connection.remote_id().to_string()),
                            started.elapsed().as_millis()
                        ));
                        serve(guard, connection, shutdown).await;
                    }
                });
            }
            _ = shutdown.changed() => break,
        }
    }
}

/// Keeps `Shared::tabs` current while a phone is connected, on the
/// `TABS_INTERVAL` cadence or as soon as a window reports its tabs.
async fn tabs_task(shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(TABS_INTERVAL) => {}
            _ = shared.tabs_wake.notified() => {}
            _ = shutdown.changed() => break,
        }
        if shared.has_conns() {
            // A burst of reports can't scan more than a few times a second.
            shared.refresh_tabs(Duration::from_millis(250)).await;
        }
    }
}

/// Turns the chats' permission requests and finished turns into notifications
/// for the phones, while one is connected.
async fn chat_alerts_task(shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    let mut alerts = shared.app.state::<ChatState>().watch_alerts();
    loop {
        tokio::select! {
            alert = alerts.recv() => match alert {
                Ok(alert) => {
                    if shared.has_conns() {
                        shared.notify_chat(alert);
                    }
                }
                // Lagging just drops the alerts missed.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = shutdown.changed() => break,
        }
    }
}

/// Releases the handshake counters exactly once, whichever way `serve`
/// leaves its handshake.
struct HandshakeGuard {
    shared: Arc<Shared>,
    /// Counted in `Shared::handshaking` (every connection before its auth).
    counted: bool,
    /// Also holds one of the few `Shared::handshaking_unknown` slots.
    unknown: bool,
}

impl HandshakeGuard {
    /// Takes one of the `MAX_UNKNOWN_HANDSHAKING` slots for a node that isn't
    /// a paired device; false when they are all in use.
    fn claim_unknown(&mut self) -> bool {
        if self.unknown {
            return true;
        }
        if self.shared.handshaking_unknown.fetch_add(1, Ordering::AcqRel) >= MAX_UNKNOWN_HANDSHAKING {
            self.shared.handshaking_unknown.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        self.unknown = true;
        true
    }

    fn done(&mut self) {
        if std::mem::take(&mut self.counted) {
            self.shared.handshaking.fetch_sub(1, Ordering::AcqRel);
        }
        if std::mem::take(&mut self.unknown) {
            self.shared.handshaking_unknown.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

impl Drop for HandshakeGuard {
    fn drop(&mut self) {
        self.done();
    }
}

/// What the first frame of a connection amounts to.
enum Admission {
    /// A known device came back.
    Known(Device),
    /// A valid pairing code was presented; the user still has to confirm on
    /// the desktop before the device is created.
    PairRequest { device_name: String },
}

fn admit(shared: &Shared, first: ClientMsg, node_id: &str) -> Result<Admission, String> {
    match first {
        ClientMsg::Auth { token } => {
            let now = now_ms();
            let device = lock(&shared.config).authenticate(&token, node_id);
            match device {
                // A right token is never held back by the limiter: it only
                // exists to slow guessing, and a phone whose earlier attempts
                // failed must not be locked out of (and told to forget) a
                // pairing that is perfectly good.
                Some(device) => {
                    lock(&shared.auth_limiter).succeeded(node_id);
                    Ok(Admission::Known(device))
                }
                None if !lock(&shared.auth_limiter).allowed(node_id, now) => {
                    Err(tr("Troppi tentativi: riprova tra un minuto", "Too many attempts: try again in a minute").to_string())
                }
                None => {
                    lock(&shared.auth_limiter).failed(node_id, now);
                    Err(tr("Autenticazione non riuscita", "Authentication failed").to_string())
                }
            }
        }
        ClientMsg::Pair { code, device_name } => {
            let redeemed = lock(&shared.pairings).redeem(code.trim(), now_ms());
            match redeemed {
                Err(PairError::RateLimited) => {
                    Err(tr("Troppi tentativi: riprova tra un minuto", "Too many attempts: try again in a minute").to_string())
                }
                Err(PairError::Invalid) => Err(tr("Codice non valido o scaduto", "Invalid or expired code").to_string()),
                // Shown in a dialog and a notification: never raw.
                Ok(()) => Ok(Admission::PairRequest { device_name: clean_name(&device_name) }),
            }
        }
        _ => Err(tr("Autenticazione non riuscita", "Authentication failed").to_string()),
    }
}

/// Drops a pending pairing request however `confirm_pairing` is left, and
/// tells the desktop's dialog to go away if the user never answered.
struct PairWaiterGuard<'a>(&'a Shared, String);

impl Drop for PairWaiterGuard<'_> {
    fn drop(&mut self) {
        // Answered requests were already taken out by `remote_pair_decide`.
        if lock(&self.0.pair_waiters).remove(&self.1).is_some() {
            let _ = self.0.app.emit(EVT_PAIR_CANCEL, serde_json::json!({ "reqId": self.1 }));
        }
    }
}

/// Asks the user, on the desktop, whether to let this phone in; only a yes
/// creates the device. Waiting counts as handshaking, which keeps strangers
/// with a stolen code from piling up pending requests.
async fn confirm_pairing(
    shared: &Shared,
    node_id: &str,
    device_name: &str,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(Device, String), String> {
    let declined = || tr("Collegamento rifiutato sul computer", "Pairing declined on the computer").to_string();
    let Some(window) = shared.default_window() else { return Err(declined()) };
    let req_id = random_hex(8)?;
    let (tx, answer) = oneshot::channel();
    lock(&shared.pair_waiters).insert(req_id.clone(), tx);
    let _guard = PairWaiterGuard(shared, req_id.clone());
    let name = clean_name(device_name);
    // The phone shows the same fingerprint, so the user can tell which request is theirs.
    let payload = serde_json::json!({ "reqId": req_id, "deviceName": name, "fingerprint": proto::node_fingerprint(node_id) });
    if shared.app.emit_to(window.as_str(), EVT_PAIR_REQUEST, payload).is_err() {
        return Err(declined());
    }
    shared.focus_window(&window);
    shared.notify(tr("Richiesta di collegamento", "Pairing request").to_string(), name.clone());

    let accepted = tokio::select! {
        answer = tokio::time::timeout(PAIR_CONFIRM_TIMEOUT, answer) => match answer {
            Ok(Ok(accepted)) => accepted,
            Ok(Err(_)) => false,
            Err(_) => {
                return Err(tr("Nessuna conferma sul computer: riprova", "Not confirmed on the computer: try again").to_string())
            }
        },
        _ = shutdown.changed() => false,
    };
    if !accepted {
        return Err(declined());
    }
    let (device, token) = lock(&shared.config).add_device(device_name, node_id, now_ms())?;
    shared.save();
    shared.devices_changed();
    shared.notify(tr("Nuovo telefono collegato", "New phone paired").to_string(), device.name.clone());
    Ok((device, token))
}

/// A connection that passed the handshake, with its (still unused) stream.
struct Admitted {
    device: Device,
    /// Set when the connection was a pairing: the new device token to hand over.
    token: Option<String>,
    send: SendStream,
    recv: RecvStream,
}

/// Sends a fatal `error` and hangs up.
async fn reject(connection: &Connection, send: &mut SendStream, message: String, code: u32, reason: &[u8]) {
    let _ = write_frame(send, &ServerMsg::Error { message, pty_id: None, fatal: true }).await;
    let _ = send.finish();
    // Closing right away could discard the error still in flight.
    let _ = tokio::time::timeout(Duration::from_secs(2), send.stopped()).await;
    connection.close(code.into(), reason);
}

/// The handshake: the phone's first frame (`auth` or `pair`, plus the
/// desktop's confirmation for a new phone). `None` once the connection has
/// been refused and closed.
async fn handshake(
    shared: &Arc<Shared>,
    guard: &mut HandshakeGuard,
    connection: &Connection,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<Admitted> {
    // Verified by iroh during the TLS handshake: this really is that key.
    let node_id = connection.remote_id().to_string();
    let peer = short_id(&node_id);
    // Strangers get only a few handshake slots, so they can't crowd out the
    // phones that are actually paired.
    let known = shared.is_known_node(&node_id);
    if !known && !guard.claim_unknown() {
        shared.log.line(&format!("peer {peer}: rejected, unknown node and all {MAX_UNKNOWN_HANDSHAKING} stranger slots busy"));
        connection.close(4u32.into(), b"busy");
        return None;
    }
    let started = Instant::now();
    let stream = tokio::time::timeout(AUTH_TIMEOUT, connection.accept_bi()).await;
    let (mut send, mut recv) = match stream {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            shared.log.line(&format!("peer {peer}: no stream opened ({e})"));
            connection.close(1u32.into(), b"no stream");
            return None;
        }
        Err(_) => {
            shared.log.line(&format!("peer {peer}: timeout, no stream opened within {} s", AUTH_TIMEOUT.as_secs()));
            connection.close(1u32.into(), b"no stream");
            return None;
        }
    };
    let first = tokio::time::timeout(AUTH_TIMEOUT, read_frame::<_, ClientMsg>(&mut recv)).await;
    let msg = match first {
        Ok(Ok(msg)) => msg,
        // Not a verdict on the phone: say nothing fatal (a fatal error makes
        // the phone forget its pairing), just hang up and let it retry.
        other => {
            let why = match other {
                Ok(Err(e)) => format!("first frame unreadable: {e}"),
                _ => format!("timeout, no first frame within {} s", AUTH_TIMEOUT.as_secs()),
            };
            shared.log.line(&format!("peer {peer}: {why}"));
            connection.close(1u32.into(), b"no auth");
            return None;
        }
    };
    let kind = match &msg {
        ClientMsg::Auth { .. } => "auth",
        ClientMsg::Pair { .. } => "pair",
        _ => "other",
    };
    shared.log.line(&format!(
        "peer {peer}: first frame `{kind}` after {} ms ({})",
        started.elapsed().as_millis(),
        if known { "paired node" } else { "unknown node" }
    ));
    let admission = admit(shared, msg, &node_id);
    let admitted = match admission {
        Ok(Admission::Known(device)) => Ok((device, None)),
        Ok(Admission::PairRequest { device_name }) => confirm_pairing(shared, &node_id, &device_name, shutdown)
            .await
            .map(|(device, token)| (device, Some(token))),
        Err(message) => Err(message),
    };
    match admitted {
        Ok((device, token)) => {
            shared.log.line(&format!("peer {peer}: {} for device \"{}\"", if token.is_some() { "paired" } else { "auth ok" }, device.name));
            Some(Admitted { device, token, send, recv })
        }
        Err(message) => {
            shared.log.line(&format!("peer {peer}: rejected: {message}"));
            reject(connection, &mut send, message, 2, b"auth").await;
            None
        }
    }
}

/// The addresses of `addr` for a log line: IP addresses, then relay URLs.
fn describe_addrs(addr: &iroh::EndpointAddr) -> String {
    let ips: Vec<String> = addr.ip_addrs().map(|a| a.to_string()).collect();
    let relays: Vec<String> = addr.relay_urls().map(|u| u.to_string()).collect();
    format!("{} direct [{}], {} relay [{}]", ips.len(), ips.join(", "), relays.len(), relays.join(", "))
}

/// The selected path of a connection snapshot: direct (IP) or
/// through the relay, with its round trip. `None` when no path is selected.
fn selected_path(paths: &iroh::endpoint::PathList<'_>) -> Option<(String, String)> {
    let path = paths.iter().find(|p| p.is_selected())?;
    let kind = if path.is_relay() { "relay" } else { "direct" };
    let addr = path.remote_addr();
    Some((format!("{kind} {addr}"), format!("{kind} {addr} (rtt {} ms, {} paths open)", path.rtt().as_millis(), paths.len())))
}

/// UDP bytes sent and received so far, to rate between two looks.
struct LinkCounters {
    at: Instant,
    tx: u64,
    rx: u64,
}

impl LinkCounters {
    fn of(connection: &Connection) -> LinkCounters {
        let stats = connection.stats();
        LinkCounters { at: Instant::now(), tx: stats.udp_tx.bytes, rx: stats.udp_rx.bytes }
    }
}

/// `1.5 KB/s` for `bytes` over `secs` seconds.
fn rate(bytes: u64, secs: f64) -> String {
    format!("{:.1} KB/s", bytes as f64 / 1024.0 / secs.max(0.001))
}

/// One line of link quality: the selected path, its round trip, the traffic
/// since `last` and the packets lost in all. Moves `last` forward.
fn link_metrics(connection: &Connection, last: &mut LinkCounters) -> Option<String> {
    let paths = connection.paths();
    let path = paths.iter().find(|p| p.is_selected())?;
    let kind = if path.is_relay() { "relay" } else { "direct" };
    let now = LinkCounters::of(connection);
    let secs = now.at.duration_since(last.at).as_secs_f64();
    let line = format!(
        "link {kind} {} ms, tx {}, rx {}, {} packets lost",
        path.rtt().as_millis(),
        rate(now.tx.saturating_sub(last.tx), secs),
        rate(now.rx.saturating_sub(last.rx), secs),
        connection.stats().lost_packets
    );
    *last = now;
    Some(line)
}

/// Logs which path `connection` uses (direct or relay, and its round trip)
/// each time the selection changes, and its quality every `METRICS_EVERY`;
/// ends when the connection closes.
async fn watch_paths(shared: Arc<Shared>, connection: Connection, peer: String) {
    use futures_lite::StreamExt;
    let mut last = String::new();
    let mut counters = LinkCounters::of(&connection);
    let mut metrics = tokio::time::interval_at(tokio::time::Instant::now() + METRICS_EVERY, METRICS_EVERY);
    let mut paths = connection.paths_stream();
    loop {
        tokio::select! {
            list = paths.next() => {
                let Some(list) = list else { break };
                let Some((key, line)) = selected_path(&list) else { continue };
                if key != last {
                    shared.log.line(&format!("peer {peer}: path {line}"));
                    last = key;
                }
            }
            _ = metrics.tick() => {
                if let Some(line) = link_metrics(&connection, &mut counters) {
                    shared.log.line(&format!("peer {peer}: {line}"));
                }
            }
        }
    }
}

async fn serve(mut guard: HandshakeGuard, connection: Connection, mut shutdown: watch::Receiver<bool>) {
    let shared = Arc::clone(&guard.shared);
    let Some(mut admitted) = handshake(&shared, &mut guard, &connection, &mut shutdown).await else { return };
    guard.done();
    // The device may have been revoked, or the endpoint stopped, while the
    // handshake ran.
    if *shutdown.borrow() || !lock(&shared.config).devices.iter().any(|d| d.id == admitted.device.id) {
        let message = tr("Dispositivo revocato", "Device revoked").to_string();
        shared.log.line(&format!("peer {}: rejected: revoked or shutting down during the handshake", short_id(&connection.remote_id().to_string())));
        reject(&connection, &mut admitted.send, message, 3, b"gone").await;
        return;
    }
    let (peer, device_name) = (short_id(&connection.remote_id().to_string()).to_string(), admitted.device.name.clone());
    let started = Instant::now();
    let watcher = tokio::spawn(watch_paths(Arc::clone(&shared), connection.clone(), peer.clone()));
    let why = run_connection(Arc::clone(&shared), &connection, shutdown, admitted).await;
    watcher.abort();
    shared.log.line(&format!(
        "peer {peer}: closed \"{device_name}\" after {} s: {why}",
        started.elapsed().as_secs()
    ));
}

/// Replies that don't depend on the order of anything else and can be big:
/// they wait for interactive frames (terminal output, echoes, replies to a
/// tap) instead of delaying them. Their own order is kept.
fn is_bulk(msg: &ServerMsg) -> bool {
    matches!(msg, ServerMsg::ViewFile { .. } | ServerMsg::LinkPreview { .. })
}

/// The next message to write: anything interactive in the queue first, then a
/// held bulk one, and only then a wait for more. `None` once the queue is
/// closed and nothing is held.
async fn next_to_write(out_rx: &mut mpsc::Receiver<ServerMsg>, bulk: &mut VecDeque<ServerMsg>) -> Option<ServerMsg> {
    loop {
        if bulk.len() >= BULK_HELD {
            return bulk.pop_front();
        }
        match out_rx.try_recv() {
            Ok(msg) if is_bulk(&msg) => bulk.push_back(msg),
            Ok(msg) => return Some(msg),
            Err(mpsc::error::TryRecvError::Empty) => {
                if let Some(msg) = bulk.pop_front() {
                    return Some(msg);
                }
                match out_rx.recv().await {
                    Some(msg) if is_bulk(&msg) => bulk.push_back(msg),
                    other => return other,
                }
            }
            Err(mpsc::error::TryRecvError::Disconnected) => return bulk.pop_front(),
        }
    }
}

/// Encodes `msg` onto the end of `buf`. A message too large for a frame is
/// replaced by a note saying so, rather than leaving the phone waiting for it;
/// any other encoding error is dropped silently (serialising our own types
/// cannot fail).
fn append_frame(buf: &mut Vec<u8>, msg: &ServerMsg, compress: bool) {
    match encode_frame(msg, compress) {
        Ok(bytes) => buf.extend_from_slice(&bytes),
        Err(FrameError::TooLarge(bytes)) => {
            let message = format!(
                "{} ({} KB)",
                tr("Messaggio troppo grande, scartato", "Message too large, dropped"),
                bytes / 1024
            );
            let note = ServerMsg::Error { message, pty_id: msg_pty_id(msg), fatal: false };
            if let Ok(bytes) = encode_frame(&note, false) {
                buf.extend_from_slice(&bytes);
            }
        }
        Err(_) => {}
    }
}

/// The single writer: it owns the send half, every producer queues into the
/// channel. Frames already queued are written together in one go. Ends when
/// the channel closes (after flushing what is queued) or the link breaks.
/// Large frames are deflated once the phone has said it reads them
/// (`compress`).
async fn write_task(mut send: SendStream, mut out_rx: mpsc::Receiver<ServerMsg>, compress: Arc<AtomicBool>) {
    let mut bulk = VecDeque::new();
    let mut buf = Vec::with_capacity(WRITE_BATCH);
    while let Some(msg) = next_to_write(&mut out_rx, &mut bulk).await {
        let compress = compress.load(Ordering::Relaxed);
        buf.clear();
        append_frame(&mut buf, &msg, compress);
        // Interactive frames that queued up meanwhile ride along; bulk ones keep waiting their turn.
        while buf.len() < WRITE_BATCH {
            match out_rx.try_recv() {
                Ok(msg) if is_bulk(&msg) => bulk.push_back(msg),
                Ok(msg) => append_frame(&mut buf, &msg, compress),
                Err(_) => break,
            }
        }
        if buf.is_empty() {
            continue;
        }
        if send.write_all(&buf).await.is_err() {
            break;
        }
    }
    let _ = send.finish();
    let _ = tokio::time::timeout(Duration::from_secs(2), send.stopped()).await;
}

fn msg_pty_id(msg: &ServerMsg) -> Option<String> {
    match msg {
        ServerMsg::Snapshot { pty_id, .. }
        | ServerMsg::Output { pty_id, .. }
        | ServerMsg::Exit { pty_id }
        | ServerMsg::Ls { pty_id, .. }
        | ServerMsg::File { pty_id, .. } => Some(pty_id.clone()),
        ServerMsg::Error { pty_id, .. } => pty_id.clone(),
        _ => None,
    }
}

/// Reading in its own task: `read_frame` isn't cancel-safe, so it can't sit
/// directly in the connection's `select!`. A phone that sends faster than the
/// queue drains is hung up on.
async fn read_task(mut recv: RecvStream, in_tx: mpsc::Sender<ClientMsg>, out: mpsc::Sender<ServerMsg>, compress: Arc<AtomicBool>) {
    loop {
        match read_frame::<_, ClientMsg>(&mut recv).await {
            // Meant for the transport, not the connection loop.
            Ok(ClientMsg::Hello { caps }) => {
                compress.store(caps.iter().any(|c| c == "compress"), Ordering::Relaxed);
            }
            Ok(msg) => {
                if in_tx.try_send(msg).is_err() {
                    break;
                }
            }
            // The frame was consumed whole: say so and carry on.
            Err(FrameError::Json(_)) => {
                let message = tr("Messaggio non valido", "Invalid message").to_string();
                let _ = out.try_send(ServerMsg::Error { message, pty_id: None, fatal: false });
            }
            Err(_) => break,
        }
    }
}

async fn run_connection(
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
        shared.notify(tr("Telefono connesso", "Phone connected").to_string(), body);
    }

    let (kick_tx, mut kick_rx) = watch::channel(false);
    let conn_id = shared.register_conn(&device.id, kick_tx);

    let (out_tx, out_rx) = mpsc::channel::<ServerMsg>(OUT_QUEUE);
    let compress = Arc::new(AtomicBool::new(false));
    let mut writer = tokio::spawn(write_task(send, out_rx, Arc::clone(&compress)));
    let (in_tx, mut in_rx) = mpsc::channel::<ClientMsg>(IN_QUEUE);
    let reader = tokio::spawn(read_task(recv, in_tx, out_tx.clone(), compress));

    let mut tabs_rx = shared.tabs.subscribe();
    let mut usage_rx = shared.usage.subscribe();
    let mut actions_rx = shared.actions.subscribe();
    let mut settings_rx = shared.settings.subscribe();
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
            Ok(()) = profiles_rx.changed() => {
                let msg = profiles_msg(&profiles_rx.borrow_and_update());
                if let Some(msg) = msg.filter(|_| !conn.background) {
                    conn.send(msg);
                }
            }
            // Lagging just drops the notifications missed; a closed channel
            // (never, `Shared` holds the sender) would only disable this arm.
            notice = notices_rx.recv() => match notice {
                Ok(msg) => conn.send(msg),
                Err(_) => continue,
            },
            // The device was revoked.
            _ = kick_rx.changed() => {
                let message = tr("Dispositivo revocato", "Device revoked").to_string();
                conn.send(ServerMsg::Error { message, pty_id: None, fatal: true });
                why = "device revoked";
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

struct Conn {
    shared: Arc<Shared>,
    id: u64,
    out_tx: mpsc::Sender<ServerMsg>,
    /// Set when something couldn't be queued because the phone isn't keeping
    /// up; the connection loop then hangs up.
    overflow: AtomicBool,
    /// pty id -> the task streaming it to this client.
    subs: HashMap<String, tokio::task::JoinHandle<()>>,
    /// chat id -> the task streaming it to this client, and the last event it sent.
    chat_subs: HashMap<String, (tokio::task::JoinHandle<()>, Arc<AtomicU64>)>,
    /// Chats followed when the phone went to the background, with the last
    /// event sent: the phone still counts them as open, so they resume by
    /// themselves when it comes back.
    paused_chats: Vec<(String, u64)>,
    /// Terminals streamed when the phone went to the background. They are
    /// streamed again (fresh snapshot first) when it comes back, so a phone
    /// whose page never saw itself hidden doesn't stay on a frozen screen.
    paused_ptys: Vec<String>,
    last_tabs: Vec<Tab>,
    last_chats: Vec<ChatInfo>,
    /// The phone said it is in the background: only notifications go out.
    background: bool,
    /// The last input error reported (pty id, when): repeats for the same pty
    /// are held back for `INPUT_ERROR_QUIET`, or each keystroke would toast.
    input_error_at: Option<(String, Instant)>,
}

impl Conn {
    /// Queues a message without waiting: a full queue means the phone stopped
    /// reading, which ends the connection (see `overflow`).
    fn send(&self, msg: ServerMsg) {
        if let Err(mpsc::error::TrySendError::Full(_)) = self.out_tx.try_send(msg) {
            self.overflow.store(true, Ordering::Relaxed);
        }
    }

    fn error(&self, message: &str, pty_id: Option<String>) {
        self.send(ServerMsg::Error { message: message.to_string(), pty_id, fatal: false });
    }

    /// Forgets streams that ended on their own (the program exited), with
    /// everything tied to them.
    fn prune_subs(&mut self) {
        let ended: Vec<String> = self.subs.iter().filter(|(_, task)| task.is_finished()).map(|(p, _)| p.clone()).collect();
        for pty_id in ended {
            self.subs.remove(&pty_id);
            self.shared.release_size(&pty_id, self.id);
        }
        self.chat_subs.retain(|_, (task, _)| !task.is_finished());
    }

    /// Stops every task this connection started.
    fn shutdown(&mut self) {
        for (_, task) in self.subs.drain() {
            task.abort();
        }
        for (_, (task, _)) in self.chat_subs.drain() {
            task.abort();
        }
    }

    /// Streams `chat_id` to this client from after `after_seq`, replacing any
    /// stream of it already running. Errs (already reported) when it can't.
    fn open_chat(&mut self, chat_id: String, after_seq: u64) {
        let subscribed = self.shared.app.state::<ChatState>().subscribe(&chat_id, after_seq);
        let Ok((replay, feed)) = subscribed else {
            self.error(tr("Chat non trovata", "Chat not found"), None);
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
            feed,
            self.out_tx.clone(),
            Arc::clone(&sent),
        ));
        self.chat_subs.insert(chat_id, (task, sent));
    }

    /// Enters or leaves background mode. Entering stops every stream (the
    /// phone closes them too); leaving sends the current state again, like
    /// right after the connection was admitted.
    fn set_background(&mut self, on: bool) {
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
                let task = tokio::spawn(stream_pty(Arc::clone(&self.shared), pty_id.clone(), self.out_tx.clone()));
                self.subs.insert(pty_id, task);
            }
        }
        // A chat closed meanwhile is just gone from the `chats` sent below.
        let live = self.shared.chat_infos();
        for (chat_id, after_seq) in std::mem::take(&mut self.paused_chats) {
            if live.iter().any(|c| c.chat_id == chat_id) {
                self.open_chat(chat_id, after_seq);
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
        if let Some(msg) = profiles_msg(&self.shared.profiles.borrow()) {
            self.send(msg);
        }
    }

    fn push_tabs_if_changed(&mut self) {
        let tabs = self.shared.latest_tabs();
        if tabs != self.last_tabs {
            self.last_tabs = tabs.clone();
            self.send(ServerMsg::Tabs { tabs });
        }
    }

    fn push_chats_if_changed(&mut self) {
        let chats = self.shared.chat_infos();
        if chats != self.last_chats {
            self.last_chats = chats.clone();
            self.send(ServerMsg::Chats { chats });
        }
    }

    /// Lists the agent view plugins for the phone. Reading and hashing the
    /// packages happens on the blocking pool, and `viewfile` chunks reuse the hashes.
    fn send_views(&self) {
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
    fn send_view_file(&self, view_id: String, path: String) {
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

    /// Answers a `linkpreview`: the page's preview, or none if the desktop's
    /// link preview setting is "never" or the page has nothing to show.
    fn send_link_preview(&self, url: String) {
        let (shared, out) = (Arc::clone(&self.shared), self.out_tx.clone());
        tauri::async_runtime::spawn(async move {
            let never = shared.settings.borrow().get("linkPreviews").and_then(|v| v.as_str()) == Some("never");
            let preview = if never { None } else { crate::link_preview::link_preview(url.clone()).await.ok() };
            // A reply is one frame: the pictures go first if it would not fit.
            let preview = preview.and_then(|p| serde_json::to_value(p.fit(LINK_PREVIEW_MAX_BYTES)).ok());
            let _ = out.send(ServerMsg::LinkPreview { url, preview }).await;
        });
    }

    /// Runs a call on a chat on the blocking pool (it writes to the agent) and
    /// reports a failure to the phone.
    fn spawn_chat<F>(&self, work: F)
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

    /// The chat with that id, as the phone lists it; reports an unknown one.
    fn chat(&self, chat_id: &str) -> Option<ChatInfo> {
        let chat = self.shared.chat_infos().into_iter().find(|c| c.chat_id == chat_id);
        if chat.is_none() {
            self.error(tr("Chat non trovata", "Chat not found"), None);
        }
        chat
    }

    /// Whether the folder, agent and profile of a `newtab` / `newchat` make
    /// sense; tells the phone what doesn't.
    fn new_target_ok(&self, cwd: &Option<String>, cli: Option<&str>, profile: &Option<String>) -> bool {
        if cli.is_some_and(|c| !matches!(c, "claude" | "codex" | "vibe" | "gemini")) {
            self.error(tr("Agente sconosciuto", "Unknown agent"), None);
            return false;
        }
        if cwd.as_deref().is_some_and(|c| c.len() > 4096 || !std::path::Path::new(c).is_dir()) {
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
    fn input(&mut self, pty_id: String, data: String) {
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

    async fn handle(&mut self, msg: ClientMsg) {
        match msg {
            // `Hello` is consumed by `read_task`.
            ClientMsg::Auth { .. } | ClientMsg::Pair { .. } | ClientMsg::Hello { .. } => {}
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
            ClientMsg::ChatPrompt { chat_id, text } => {
                if text.len() > proto::MAX_INPUT_BYTES {
                    self.error(tr("Messaggio troppo lungo", "Message too large"), None);
                } else if chat_id.len() > MAX_ID_BYTES {
                    self.error(tr("Chat non trovata", "Chat not found"), None);
                } else if !text.trim().is_empty() {
                    self.spawn_chat(move |chats| chats.prompt(&chat_id, text, Vec::new()));
                }
            }
            ClientMsg::ChatCancel { chat_id } => {
                if chat_id.len() > MAX_ID_BYTES {
                    self.error(tr("Chat non trovata", "Chat not found"), None);
                } else {
                    self.spawn_chat(move |chats| chats.cancel(&chat_id));
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
            ClientMsg::Views => self.send_views(),
            ClientMsg::ViewFile { view_id, path } => {
                if view_id.len() > MAX_ID_BYTES || path.len() > 1024 {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                } else {
                    self.send_view_file(view_id, path);
                }
            }
            ClientMsg::LinkPreview { url } => {
                if url.len() > LINK_URL_MAX_BYTES {
                    self.error(tr("Richiesta non valida", "Invalid request"), None);
                } else {
                    self.send_link_preview(url);
                }
            }
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
                    && (!matches!(op.as_str(), "login" | "logout") || matches!(cli.as_deref(), Some("claude" | "codex" | "vibe" | "gemini")));
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
        }
    }

    /// Runs a filesystem request rooted at the tab's working directory on the
    /// blocking pool and queues the reply (or an error).
    fn spawn_fs<F>(&self, pty_id: String, work: F)
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

#[cfg(test)]
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("flowcode-remote-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[cfg(test)]
mod tests {
    use super::*;
    use iroh::SecretKey;
    use std::str::FromStr;



    #[test]
    fn pairing_ticket_carries_a_parsable_endpoint_ticket() {
        let addr = iroh::EndpointAddr::new(SecretKey::generate().public());
        let node = EndpointTicket::new(addr.clone()).to_string();
        let url = PairingTicket { node, code: "abc".into(), host: "PC".into() }.encode();
        let parsed = PairingTicket::parse(&url).unwrap();
        assert_eq!(EndpointTicket::from_str(&parsed.node).unwrap().endpoint_addr(), &addr);
        assert_eq!(parsed.code, "abc");
    }

    fn view_file(path: &str) -> ServerMsg {
        ServerMsg::ViewFile { view_id: "v".into(), hash: "h".into(), path: path.into(), offset: 0, total: 0, data: String::new() }
    }

    #[tokio::test]
    async fn bulk_replies_wait_for_interactive_frames_but_keep_their_order() {
        let (tx, mut rx) = mpsc::channel(16);
        for msg in [view_file("a"), ServerMsg::Output { pty_id: "p".into(), data: "$".into() }, view_file("b"), ServerMsg::Pong] {
            tx.send(msg).await.unwrap();
        }
        drop(tx);
        let mut bulk = VecDeque::new();
        let mut order = Vec::new();
        while let Some(msg) = next_to_write(&mut rx, &mut bulk).await {
            order.push(match msg {
                ServerMsg::Output { .. } => "output".to_string(),
                ServerMsg::Pong => "pong".to_string(),
                ServerMsg::ViewFile { path, .. } => path,
                _ => unreachable!(),
            });
        }
        assert_eq!(order, ["output", "pong", "a", "b"]);
    }

    #[tokio::test]
    async fn held_bulk_replies_are_capped_and_stay_in_order() {
        let (tx, mut rx) = mpsc::channel(256);
        let mut bulk = VecDeque::new();
        for i in 0..BULK_HELD + 3 {
            tx.send(view_file(&i.to_string())).await.unwrap();
        }
        drop(tx);
        let mut paths = Vec::new();
        while let Some(ServerMsg::ViewFile { path, .. }) = next_to_write(&mut rx, &mut bulk).await {
            assert!(bulk.len() <= BULK_HELD);
            paths.push(path);
        }
        assert_eq!(paths, (0..BULK_HELD + 3).map(|i| i.to_string()).collect::<Vec<_>>());
    }
}
