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


mod accept;
mod auth;
mod chat;
mod commands;
mod conn;
mod connlog;
mod dictation;
mod dispatch;
mod fsbrowse;
mod explorer;
mod handshake;
mod hex;
pub(crate) mod keystore;
mod lifecycle;
mod preview;
mod prompts;
mod replies;
mod sizes;
mod stream;
mod tabs;
mod transport;
mod views;


use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flowcode_remote_proto::{
    self as proto, encode_frame, read_frame, write_frame, Action, ChatInfo, ClientMsg, FrameError, PairingTicket, ServerMsg, Tab,
    TabContext, TabOp, TabTarget, UsageItem,
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

use self::auth::{clean_name, AuthLimiter, Config, Device, PairError, Pairings, UnknownLimiter};
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
/// An `agentinsight` reply's tools beyond this many bytes lose their long lists.
const AGENT_INSIGHT_TOOLS_MAX_BYTES: usize = 256 * 1024;
/// Entries kept of the `mcp` and `skills` lists of a too big reply.
const AGENT_INSIGHT_LIST_KEEP: usize = 200;
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
const EVT_TAB_OP: &str = "remote://tab-op";
/// `{tabId}`: a phone closed a chat tab, to the window showing it.
const EVT_CHAT_CLOSE: &str = "remote://chat-close";
/// `{chatId}`: a phone cleared a chat (`/clear`), to the window showing it.
const EVT_CHAT_CLEAR: &str = "remote://chat-clear";
/// A phone asked for a new chat tab (see `ClientMsg::NewChat`).
/// A phone asks the desktop to check for a new release.
const EVT_UPDATE_CHECK: &str = "remote://update-check";
/// A phone asks the desktop to install the release it found (only emitted when allowed).
const EVT_UPDATE_INSTALL: &str = "remote://update-install";
const EVT_NEW_CHAT: &str = "remote://new-chat";
/// A phone resuming an agent session from the history (see `ClientMsg::Resume`).
const EVT_RESUME_SESSION: &str = "remote://resume-session";
/// `{op, ...}`: a phone changed the shared browser tabs (see `ClientMsg::BrowserOp`), to all windows; only the leader acts.
const EVT_BROWSER_OP: &str = "remote://browser-op";
/// How long the user has to confirm a new phone on the desktop. The phone
/// waits longer for its reply (see mobile/src-tauri/src/link.rs).
const PAIR_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);
/// A known phone connecting again within this long of its last connection
/// doesn't raise another notification.
const CONNECT_NOTIFY_QUIET: Duration = Duration::from_secs(10 * 60);
/// See `Conn::input_error_at`.
const INPUT_ERROR_QUIET: Duration = Duration::from_secs(3);

// ---- shared state --------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kick {
    Revoked,
    Replaced,
}

struct ConnEntry {
    device_id: String,
    kick: watch::Sender<Option<Kick>>,
    connection: Connection,
}

/// Only called after token and node identity authentication. Closing the old
/// transport also interrupts its writer even if its control loop is busy.
fn install_connection(conns: &mut HashMap<u64, ConnEntry>, id: u64, entry: ConnEntry) {
    conns.retain(|_, old| {
        if old.device_id != entry.device_id {
            return true;
        }
        old.kick.send_replace(Some(Kick::Replaced));
        old.connection.close(0u32.into(), b"replaced");
        false
    });
    conns.insert(id, entry);
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
    /// Stranger handshakes per source, so one can't hold the stranger slots.
    unknown_limiter: Mutex<UnknownLimiter>,
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
    /// Latest browser tabs snapshot the leader window published (`Null` until then).
    browser_tabs: watch::Sender<serde_json::Value>,
    /// Latest update state the frontend published (`Null` until then); `allowed` is added on send.
    update: watch::Sender<serde_json::Value>,
    /// Latest account profiles the frontend published, as `{profiles, defaultLoggedIn}` (`Null` until then).
    profiles: watch::Sender<serde_json::Value>,
    /// Desktop notifications mirrored to every connected phone.
    notices: broadcast::Sender<ServerMsg>,
    /// view id -> hash of its package, as the last listing worked it out.
    view_hashes: Mutex<HashMap<String, String>>,
    prompt_receipts: prompts::PromptReceipts,
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
    allow_phone_update: bool,
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


pub use commands::*;
use accept::*;
use conn::*;
use handshake::*;
use transport::*;

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

    #[tokio::test]
    async fn authenticated_replacement_closes_only_old_device_transport_and_never_revokes() {
        tokio::time::timeout(Duration::from_secs(10), async {
            let server = Endpoint::builder(iroh::endpoint::presets::Minimal)
                .alpns(vec![proto::ALPN.to_vec()])
                .bind_addr("127.0.0.1:0").unwrap().bind().await.unwrap();
            let mut clients = Vec::new();
            let mut connections = Vec::new();
            for _ in 0..3 {
                let client = Endpoint::builder(iroh::endpoint::presets::Minimal)
                    .bind_addr("127.0.0.1:0").unwrap().bind().await.unwrap();
                let incoming = async { server.accept().await.unwrap().await.unwrap() };
                let (connection, peer) = tokio::join!(incoming, client.connect(server.addr(), proto::ALPN));
                connections.push(connection);
                clients.push((client, peer.unwrap()));
            }
            let mut conns = HashMap::new();
            let (old_kick, old_rx) = watch::channel(None);
            let (other_kick, other_rx) = watch::channel(None);
            let (new_kick, new_rx) = watch::channel(None);
            install_connection(&mut conns, 1, ConnEntry { device_id: "phone".into(), kick: old_kick, connection: connections[0].clone() });
            install_connection(&mut conns, 2, ConnEntry { device_id: "other".into(), kick: other_kick, connection: connections[1].clone() });
            install_connection(&mut conns, 3, ConnEntry { device_id: "phone".into(), kick: new_kick, connection: connections[2].clone() });
            assert_eq!(conns.len(), 2);
            assert_eq!(*old_rx.borrow(), Some(Kick::Replaced));
            assert_eq!(*other_rx.borrow(), None);
            assert_eq!(*new_rx.borrow(), None);
            assert!(connections[0].close_reason().is_some());
            assert!(connections[1].close_reason().is_none());
            assert!(connections[2].close_reason().is_none());
            // Cleanup from the old session cannot unregister its replacement.
            assert!(conns.remove(&1).is_none());
            assert!(conns.contains_key(&3));
            // Real revocation keeps its distinct, fatal signal.
            conns[&3].kick.send(Some(Kick::Revoked)).unwrap();
            assert_eq!(*new_rx.borrow(), Some(Kick::Revoked));
            for (client, _) in &clients {
                client.close().await;
            }
            server.close().await;
        }).await.expect("replacement waited for the old QUIC idle timeout");
    }


    #[test]
    fn pairing_ticket_carries_a_parsable_endpoint_ticket() {
        let addr = iroh::EndpointAddr::new(SecretKey::generate().public());
        let node = EndpointTicket::new(addr.clone()).to_string();
        let url = PairingTicket { node, code: "abc".into(), host: "PC".into() }.encode();
        let parsed = PairingTicket::parse(&url).unwrap();
        assert_eq!(EndpointTicket::from_str(&parsed.node).unwrap().endpoint_addr(), &addr);
        assert_eq!(parsed.code, "abc");
    }

}
