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

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use flowcode_remote_proto::{
    self as proto, read_frame, write_frame, Action, ClientMsg, FrameError, LsEntry, PairingTicket, ServerMsg, Tab,
    TabContext, UsageItem,
};
use flowcode_shared::i18n::{is_italian, tr};
use iroh::endpoint::{presets, Connection, IdleTimeout, QuicTransportConfig, RecvStream, SendStream};
use iroh::{Endpoint, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, oneshot, watch};

use crate::pty::{PtyState, RemoteOut};
use crate::util::{lock, now_ms};

/// A pairing code is good for this long, once.
const PAIR_TTL_MS: u64 = 5 * 60 * 1000;
/// After this many wrong codes within `FAIL_WINDOW_MS`, every pairing attempt
/// is refused for `BLOCK_MS`.
const MAX_PAIR_FAILURES: usize = 5;
const FAIL_WINDOW_MS: u64 = 60_000;
const BLOCK_MS: u64 = 60_000;
/// Before authenticating, a peer gets this long for each step (QUIC
/// handshake, opening the stream, its first frame). A phone on a good path
/// needs well under a second, but one on mobile data behind a relay (lost
/// first packets, 1 s retransmits) can need several: 5 s turned those into
/// failed first attempts. Strangers are still bounded by the slot caps.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// `remote.log` is rotated (to `remote.log.old`) once it grows past this.
const LOG_CAP_BYTES: u64 = 256 * 1024;
/// Connections not yet authenticated, however far along; more than this are
/// refused so a flood can't pile up tasks. The node id isn't known until
/// the QUIC handshake is done, so this is the only cap that early.
const MAX_HANDSHAKING: usize = 64;
/// Of those, how many may come from nodes that aren't a paired device (this
/// includes a new phone waiting for the user's confirmation). Paired phones
/// aren't limited by it, so strangers can't lock them out.
const MAX_UNKNOWN_HANDSHAKING: usize = 4;
/// After this many failed `auth`s from one node within `FAIL_WINDOW_MS`, its
/// `auth` is refused for `BLOCK_MS`.
const MAX_AUTH_FAILURES: u32 = 5;
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);
const TABS_INTERVAL: Duration = Duration::from_secs(2);
/// Agent detection walks the process table: connections share one result this
/// old rather than each triggering a scan. Longer than `TABS_INTERVAL`, so
/// a connection's tick never forces a scan of its own.
const TABS_CACHE: Duration = Duration::from_millis(2500);
/// QUIC drops a link after this much silence. The phone pings every 20 s and
/// gives up after 60 s, so this stays comfortably above that (the actual
/// timeout is the smaller of the two peers'); iroh's keep-alive (5 s)
/// keeps a quiet but healthy link from ever reaching it.
const QUIC_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// Frames queued for one phone before it counts as not reading (the pty
/// output of a phone that is merely slow is dropped well before that, see
/// `OUT_RESERVE`). Output frames are at most ~8 KiB, so ~8 MiB per phone.
const OUT_QUEUE: usize = 1024;
/// Slots of `OUT_QUEUE` kept for replies and pushes: terminal output stops
/// (and resyncs later) when only this many are free.
const OUT_RESERVE: usize = 64;
/// Frames from the phone queued before the connection loop gets to them. A
/// phone that outruns this is hung up on.
const IN_QUEUE: usize = 256;
/// Keystroke messages queued per pty (each up to `MAX_INPUT_BYTES`).
const INPUT_QUEUE: usize = 64;
/// Terminals one connection may have open (and, by extension, be typing into).
const MAX_SUBS: usize = 64;
/// A resync waits this long between looks at the phone's queue.
const RESYNC_POLL: Duration = Duration::from_millis(200);
/// Snapshots tried per resync before accepting one that may miss a few bytes.
const RESYNC_ATTEMPTS: u32 = 10;
/// Largest `set` value, as JSON.
const MAX_SET_BYTES: usize = 4096;
/// A snapshot's JSON-encoded size: half a frame, leaving room for the rest.
const SNAPSHOT_MAX_ENCODED: usize = proto::MAX_FRAME / 2;
/// `remote_pair_start` called again within this long returns the same code:
/// a double call (React StrictMode) must not invalidate the code on screen.
const PAIR_REUSE_MS: u64 = 10_000;
/// Reading a transcript's tail is cheap but not free, and the figure only
/// moves when the agent answers.
const CONTEXT_CACHE: Duration = Duration::from_secs(10);
const LAST_SEEN_PERSIST_MS: u64 = 60_000;
/// How long to wait for the endpoint to reach a relay before making a
/// pairing ticket anyway (it then carries only direct addresses).
const ONLINE_TIMEOUT: Duration = Duration::from_secs(5);
/// A text file is read up to this size; the rest is cut off.
const MAX_READ_BYTES: usize = 1024 * 1024;
const MAX_LS_ENTRIES: usize = 5000;
const EVT_DEVICES_CHANGED: &str = "remote://devices-changed";
const EVT_SNAPSHOT_REQUEST: &str = "remote://snapshot-request";
const EVT_SIZE_OVERRIDE: &str = "remote://size-override";
const EVT_RUN_ACTION: &str = "remote://run-action";
const EVT_SET_SETTING: &str = "remote://set-setting";
const EVT_PAIR_REQUEST: &str = "remote://pair-request";
/// `{reqId}`: the request went away unanswered (timeout, phone left).
const EVT_PAIR_CANCEL: &str = "remote://pair-cancel";
/// How long the user has to confirm a new phone on the desktop. The phone
/// waits longer for its reply (see mobile/src-tauri/src/link.rs).
const PAIR_CONFIRM_TIMEOUT: Duration = Duration::from_secs(60);
/// A known phone connecting again within this long of its last connection
/// doesn't raise another notification.
const CONNECT_NOTIFY_QUIET: Duration = Duration::from_secs(10 * 60);

// ---- persistence ---------------------------------------------------------

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Device {
    id: String,
    name: String,
    token_hash: String,
    /// iroh node id (the phone's public key) the token was issued to. A
    /// device saved by the Tailscale prototype has none and is dropped.
    #[serde(default)]
    node_id: String,
    created_at: u64,
    last_seen_at: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Config {
    enabled: bool,
    #[serde(default)]
    devices: Vec<Device>,
}

impl Config {
    /// The device `token` was issued to, if `node_id` is the node that
    /// paired with it. Both must match.
    fn authenticate(&self, token: &str, node_id: &str) -> Option<Device> {
        let hash = hash_token(token);
        // Compare against every device (no early exit) so timing doesn't
        // reveal how far down the list a match was.
        let mut found = None;
        for device in &self.devices {
            let token_ok = ct_eq(device.token_hash.as_bytes(), hash.as_bytes());
            let node_ok = !device.node_id.is_empty() && ct_eq(device.node_id.as_bytes(), node_id.as_bytes());
            if token_ok && node_ok {
                found = Some(device.clone());
            }
        }
        found
    }

    /// Adds a device for `node_id`, replacing an earlier pairing of the same
    /// phone (re-scanning must not leave a stale duplicate). Returns the new
    /// device and the token that was issued (only its hash is kept).
    fn add_device(&mut self, name: &str, node_id: &str, now: u64) -> Result<(Device, String), String> {
        let token = random_hex(32)?;
        let name = clean_name(name);
        let device = Device {
            id: random_hex(8)?,
            name: if name.is_empty() { "Phone".to_string() } else { name },
            token_hash: hash_token(&token),
            node_id: node_id.to_string(),
            created_at: now,
            last_seen_at: None,
        };
        self.devices.retain(|d| d.node_id != node_id);
        self.devices.push(device.clone());
        Ok((device, token))
    }
}

// ---- tokens, pairing -----------------------------------------------------

/// A device name from the phone, safe to show: no control characters (they
/// could fake lines in a dialog or notification), trimmed, at most 64 chars.
fn clean_name(raw: &str) -> String {
    raw.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(64).collect()
}

fn random_hex(bytes: usize) -> Result<String, String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(to_hex(&buf))
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 || !hex.is_ascii() {
        return None;
    }
    (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect()
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
    /// When `active` was generated.
    started_at: u64,
    /// The code that was last redeemed. Asking for it again (a phone retrying
    /// after the user declined or let the confirmation time out) is just
    /// invalid, not a guess, so it doesn't count towards the rate limit.
    spent: Option<String>,
    failures: Vec<u64>,
    blocked_until: u64,
}

impl Pairings {
    /// A fresh code, replacing any earlier one. Returns (code, expiresAt).
    fn start(&mut self, code: String, now: u64) -> (String, u64) {
        let expires = now + PAIR_TTL_MS;
        self.active = Some((code.clone(), expires));
        self.started_at = now;
        self.spent = None;
        (code, expires)
    }

    /// The active code if it is still unexpired and was generated less than
    /// `PAIR_REUSE_MS` ago: what a repeated start returns.
    fn recent(&self, now: u64) -> Option<(String, u64)> {
        let (code, expires) = self.active.as_ref()?;
        (now < *expires && now.saturating_sub(self.started_at) < PAIR_REUSE_MS).then(|| (code.clone(), *expires))
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
            self.spent = self.active.take().map(|(code, _)| code);
            self.failures.clear();
            return Ok(());
        }
        if matches!(&self.spent, Some(spent) if ct_eq(spent.as_bytes(), code.as_bytes())) {
            return Err(PairError::Invalid);
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

/// Failed `auth`s per node id. A real phone with a stale token retries on a
/// backoff; a stranger guessing tokens is slowed to a crawl (the 256-bit
/// token is the real defence, this just keeps the log and CPU calm).
#[derive(Default)]
struct AuthLimiter {
    /// node id -> (failures in the current window, window start, blocked until)
    nodes: HashMap<String, (u32, u64, u64)>,
}

impl AuthLimiter {
    fn allowed(&self, node: &str, now: u64) -> bool {
        self.nodes.get(node).is_none_or(|(_, _, blocked_until)| now >= *blocked_until)
    }

    fn failed(&mut self, node: &str, now: u64) {
        // Bounded: unknown nodes are free to make up ids.
        if self.nodes.len() >= 1024 {
            self.nodes.retain(|_, (_, start, blocked)| now < *blocked || now.saturating_sub(*start) < FAIL_WINDOW_MS);
            if self.nodes.len() >= 1024 {
                self.nodes.clear();
            }
        }
        let entry = self.nodes.entry(node.to_string()).or_insert((0, now, 0));
        if now.saturating_sub(entry.1) >= FAIL_WINDOW_MS {
            *entry = (0, now, entry.2);
        }
        entry.0 += 1;
        if entry.0 >= MAX_AUTH_FAILURES {
            entry.2 = now + BLOCK_MS;
            entry.0 = 0;
        }
    }

    fn succeeded(&mut self, node: &str) {
        self.nodes.remove(node);
    }
}

// ---- connection log -------------------------------------------------------

/// `YYYY-MM-DD HH:MM:SS.mmm` (UTC) for a Unix time in milliseconds.
fn format_utc(ms: u64) -> String {
    let (secs, millis) = (ms / 1000, ms % 1000);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}.{millis:03}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Appends `line` to `path`; a file already past `cap` bytes first becomes
/// `<path>.old` (replacing the previous one), so the log never exceeds ~2x cap.
fn append_capped(path: &Path, line: &str, cap: u64) {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|m| m.len() >= cap) {
        let mut old = path.as_os_str().to_owned();
        old.push(".old");
        let _ = std::fs::rename(path, old);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// One line per connection event, to stderr (the `tauri dev` console) and a
/// small rotating file. Best effort: logging never fails a connection.
struct ConnLog {
    path: PathBuf,
    /// Keeps lines from two threads from interleaving or racing a rotation.
    write: Mutex<()>,
}

impl ConnLog {
    fn new(path: PathBuf) -> Self {
        ConnLog { path, write: Mutex::new(()) }
    }

    fn line(&self, text: &str) {
        let line = format!("{} {text}", format_utc(now_ms()));
        eprintln!("remote: {line}");
        let _held = lock(&self.write);
        append_capped(&self.path, &line, LOG_CAP_BYTES);
    }
}

/// The first characters of a node id: enough to tell phones apart in a log.
fn short_id(node_id: &str) -> &str {
    node_id.get(..10).unwrap_or(node_id)
}

// ---- node key --------------------------------------------------------------

/// The endpoint's secret key, persisted so the node id (and with it every
/// paired phone's idea of this desktop) survives restarts. 64 hex chars.
///
/// On Windows the file holds the key sealed with DPAPI (tied to the user's
/// login, so a copy of the file is useless elsewhere); an older plain-hex
/// file is converted on first read.
fn load_or_create_key(path: &Path) -> Result<SecretKey, String> {
    if let Ok(text) = std::fs::read_to_string(path) {
        let text = text.trim();
        let (bytes, sealed) = match text.strip_prefix(SEALED_PREFIX) {
            Some(blob) => (from_hex(blob).and_then(|b| unseal(&b)).and_then(|k| decode_key(&String::from_utf8(k).ok()?)), true),
            None => (decode_key(text), false),
        };
        if let Some(bytes) = bytes {
            if !sealed && SEALING {
                if let Err(e) = write_key(path, &bytes) {
                    eprintln!("remote: cannot protect the node key: {e}");
                }
            }
            return Ok(SecretKey::from_bytes(&bytes));
        }
        // An unreadable key is replaced: paired phones then fail to auth and
        // must be paired again, which is better than not starting at all.
        eprintln!("remote: {} is corrupt, generating a new node key", path.display());
    }
    let key = SecretKey::generate();
    write_key(path, &key.to_bytes()).map_err(|e| e.to_string())?;
    Ok(key)
}

fn decode_key(hex: &str) -> Option<[u8; 32]> {
    from_hex(hex.trim()).and_then(|bytes| bytes.try_into().ok())
}

/// Marks a key file whose hex is a DPAPI blob rather than the key itself.
const SEALED_PREFIX: &str = "dpapi1:";
/// Whether this platform seals the key file (see `seal`).
const SEALING: bool = cfg!(windows);

fn write_key(path: &Path, key: &[u8; 32]) -> std::io::Result<()> {
    let hex = to_hex(key);
    let content = match seal(hex.as_bytes()) {
        Some(blob) => format!("{SEALED_PREFIX}{}", to_hex(&blob)),
        None => hex,
    };
    write_private(path, content.as_bytes())
}

/// Encrypts `plain` for the current Windows user (DPAPI). `None` where there
/// is no such facility - or if it failed, in which case the key is kept
/// readable the way it always was rather than lost.
#[cfg(windows)]
fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    dpapi(plain, true)
}

#[cfg(not(windows))]
fn seal(_plain: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn unseal(blob: &[u8]) -> Option<Vec<u8>> {
    dpapi(blob, false)
}

#[cfg(not(windows))]
fn unseal(_blob: &[u8]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn dpapi(input: &[u8], protect: bool) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let blob_in = CRYPT_INTEGER_BLOB { cbData: input.len() as u32, pbData: input.as_ptr() as *mut u8 };
    let mut blob_out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    // SAFETY: both blobs point to live memory for the call; on success the
    // output buffer is ours (allocated by the system) and freed below.
    let ok = unsafe {
        if protect {
            CryptProtectData(&blob_in, std::ptr::null(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut blob_out)
        } else {
            CryptUnprotectData(&blob_in, std::ptr::null_mut(), std::ptr::null(), std::ptr::null(), std::ptr::null(), 0, &mut blob_out)
        }
    };
    if ok == 0 || blob_out.pbData.is_null() {
        return None;
    }
    // SAFETY: the call succeeded, so `pbData` holds `cbData` bytes.
    let out = unsafe { std::slice::from_raw_parts(blob_out.pbData, blob_out.cbData as usize).to_vec() };
    unsafe { LocalFree(blob_out.pbData as _) };
    Some(out)
}

/// An exclusive lock on a file next to the node key, held for as long as the
/// endpoint runs: two Flowcode instances sharing a config dir would otherwise
/// fight over the same node id (each kicking the other's phone). Dropping the
/// returned file releases it.
fn acquire_instance_lock(key_path: &Path) -> Result<std::fs::File, String> {
    let busy = || {
        tr(
            "Accesso remoto già attivo in un'altra finestra/istanza di Flowcode",
            "Remote access is already active in another Flowcode window/instance",
        )
        .to_string()
    };
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(key_path.with_extension("lock"))
        .map_err(|e| e.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => Err(busy()),
        Err(std::fs::TryLockError::Error(e)) => Err(e.to_string()),
    }
}

/// Writes through a temp file renamed into place, readable by the owner only
/// on Unix (the file is the node's identity).
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
    let result = (|| {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

// ---- directory listing and file reading ----------------------------------

fn outside_error() -> String {
    tr("Percorso fuori dalla cartella del terminale", "Path is outside the terminal's folder").to_string()
}

/// `rel` (relative to `root`, or an absolute path inside it) resolved to a
/// real path that is guaranteed to lie within `root`. `..` is refused
/// outright, and canonicalizing both sides resolves symlinks, so a link
/// pointing out of the folder can't be followed either.
fn confine(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(rel.trim());
    if candidate.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(outside_error());
    }
    let root = root
        .canonicalize()
        .map_err(|_| tr("Cartella non disponibile", "Folder not available").to_string())?;
    let full = if candidate.is_absolute() { candidate.to_path_buf() } else { root.join(candidate) };
    let full = full
        .canonicalize()
        .map_err(|_| tr("Percorso non trovato", "Path not found").to_string())?;
    if !full.starts_with(&root) {
        return Err(outside_error());
    }
    Ok(full)
}

/// `full` as shown to the phone: relative to `root`, `/`-separated, empty for
/// the root itself.
fn display_path(root: &Path, full: &Path) -> String {
    let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    full.strip_prefix(&root)
        .map(|p| p.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/"))
        .unwrap_or_default()
}

fn list_dir(root: &Path, rel: &str) -> Result<(String, Vec<LsEntry>), String> {
    let dir = confine(root, rel)?;
    let mut entries: Vec<LsEntry> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.flatten().take(MAX_LS_ENTRIES) {
        // `metadata` follows symlinks so a link to a folder lists as one; a
        // dangling link falls back to the link's own type.
        let (is_dir, size) = match std::fs::metadata(entry.path()) {
            Ok(m) => (m.is_dir(), (!m.is_dir()).then_some(m.len())),
            Err(_) => (entry.file_type().map(|t| t.is_dir()).unwrap_or(false), None),
        };
        entries.push(LsEntry { name: entry.file_name().to_string_lossy().into_owned(), dir: is_dir, size });
    }
    entries.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok((display_path(root, &dir), entries))
}

/// A text file's contents, cut at `MAX_READ_BYTES` and then further if the
/// JSON-escaped text wouldn't fit one protocol frame. Binary files are
/// refused (a NUL byte in the first 8 KiB).
fn read_text(root: &Path, rel: &str) -> Result<(String, String, bool), String> {
    use std::io::Read;
    let path = confine(root, rel)?;
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(tr("Non è un file", "Not a file").to_string());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .take(MAX_READ_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err(tr("File binario: non si può mostrare", "Binary file: cannot be shown").to_string());
    }
    let mut truncated = bytes.len() > MAX_READ_BYTES;
    bytes.truncate(MAX_READ_BYTES);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    // Escaping can inflate text (control characters become six bytes), so
    // trim until the encoded form is safely inside a frame.
    while serde_json::to_string(&text).map(|s| s.len()).unwrap_or(usize::MAX) > proto::MAX_FRAME - 4096 {
        let mut cut = text.len() / 4 * 3;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        truncated = true;
    }
    Ok((display_path(root, &path), text, truncated))
}

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
    tabs_cache: tokio::sync::Mutex<Option<(Instant, Vec<Tab>)>>,
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
    /// pty id -> phones sizing it, oldest first (the last one wins).
    sizing: Mutex<HashMap<String, Vec<SizeClaim>>>,
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
            tabs_cache: tokio::sync::Mutex::new(None),
            context_cache: Mutex::new(HashMap::new()),
            last_persisted_seen: Mutex::new(0),
            usage: watch::channel(Vec::new()).0,
            actions: watch::channel(Vec::new()).0,
            settings: watch::channel(serde_json::Value::Null).0,
            sizing: Mutex::new(HashMap::new()),
            size_owners: Mutex::new(HashMap::new()),
        }))
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
        // iroh's keep-alive (5 s) is already on; only the idle timeout needs
        // to be above the phone's 60 s of tolerated silence.
        let mut transport = QuicTransportConfig::builder();
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
        // Phones that dial before the relay is reachable can only use direct
        // addresses; the log says when that window ended.
        {
            let (shared, endpoint) = (Arc::clone(self), endpoint.clone());
            tauri::async_runtime::spawn(async move {
                let started = Instant::now();
                match tokio::time::timeout(Duration::from_secs(120), endpoint.online()).await {
                    Ok(()) => shared.log.line(&format!("endpoint online (relay reachable) after {} ms", started.elapsed().as_millis())),
                    Err(_) => shared.log.line("endpoint still not online (no relay) after 120 s"),
                }
            });
        }
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
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
        {
            let mut sizing = lock(&self.sizing);
            let claims = sizing.entry(pty_id.to_string()).or_default();
            claims.retain(|c| c.conn != conn);
            claims.push(SizeClaim { conn, cols, rows });
        }
        self.apply_size(pty_id, Some((cols, rows)));
    }

    /// `conn` stopped sizing `pty`: the previous claimant's size comes back,
    /// or the desktop's own when there is none.
    fn release_size(&self, pty_id: &str, conn: u64) {
        let next = {
            let mut sizing = lock(&self.sizing);
            let Some(claims) = sizing.get_mut(pty_id) else { return };
            let before = claims.len();
            claims.retain(|c| c.conn != conn);
            if claims.len() == before {
                return;
            }
            let next = claims.last().map(|c| (c.cols, c.rows));
            if claims.is_empty() {
                sizing.remove(pty_id);
            }
            next
        };
        self.apply_size(pty_id, next);
    }

    fn release_all_sizes(&self, conn: u64) {
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

    /// The tab list, shared between connections for `TABS_CACHE`.
    async fn tabs(&self) -> Vec<Tab> {
        let mut cache = self.tabs_cache.lock().await;
        if let Some((at, tabs)) = &*cache {
            if at.elapsed() < TABS_CACHE {
                return tabs.clone();
            }
        }
        let tabs = self.build_tabs().await;
        self.sync_size_owners(&tabs);
        *cache = Some((Instant::now(), tabs.clone()));
        tabs
    }

    /// `WindowTabs` entries that have a live pty, joined with the agent running
    /// in each (same source as the Agents panel) and its context fill.
    async fn build_tabs(&self) -> Vec<Tab> {
        let app = &self.app;
        let sizes = app.state::<PtyState>().sizes();
        let sessions = crate::agents::collect_agent_sessions(app).await.unwrap_or_default();
        let contexts = self.contexts_for(&sessions).await;
        let agents: HashMap<String, (String, Option<String>)> =
            sessions.into_iter().map(|s| (s.pty_id, (s.cli, s.status))).collect();
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
                let context = contexts.get(&pty_id).cloned().flatten();
                Some(Tab { pty_id, tab_id: tab.tab_id, window, label: tab.label, cwd: tab.cwd, cli, status, cols, rows, context })
            })
            .collect()
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
    let why = run_connection(Arc::clone(&shared), &connection, shutdown, admitted).await;
    shared.log.line(&format!(
        "peer {peer}: closed \"{device_name}\" after {} s: {why}",
        started.elapsed().as_secs()
    ));
}

/// The single writer: it owns the send half, every producer queues into the
/// channel. Ends when the channel closes (after flushing what is queued) or
/// the link breaks.
async fn write_task(mut send: SendStream, mut out_rx: mpsc::Receiver<ServerMsg>) {
    while let Some(msg) = out_rx.recv().await {
        match write_frame(&mut send, &msg).await {
            Ok(()) => {}
            // Nothing was written, so the link is fine: drop the message but
            // say so, rather than leaving the phone waiting for it.
            Err(FrameError::TooLarge(bytes)) => {
                let message = format!(
                    "{} ({} KB)",
                    tr("Messaggio troppo grande, scartato", "Message too large, dropped"),
                    bytes / 1024
                );
                let note = ServerMsg::Error { message, pty_id: msg_pty_id(&msg), fatal: false };
                if write_frame(&mut send, &note).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
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
async fn read_task(mut recv: RecvStream, in_tx: mpsc::Sender<ClientMsg>, out: mpsc::Sender<ServerMsg>) {
    loop {
        match read_frame::<_, ClientMsg>(&mut recv).await {
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
    let mut writer = tokio::spawn(write_task(send, out_rx));
    let (in_tx, mut in_rx) = mpsc::channel::<ClientMsg>(IN_QUEUE);
    let reader = tokio::spawn(read_task(recv, in_tx, out_tx.clone()));

    let mut usage_rx = shared.usage.subscribe();
    let mut actions_rx = shared.actions.subscribe();
    let mut settings_rx = shared.settings.subscribe();
    let mut conn = Conn {
        shared: Arc::clone(&shared),
        id: conn_id,
        out_tx,
        overflow: AtomicBool::new(false),
        subs: HashMap::new(),
        inputs: HashMap::new(),
        last_tabs: Vec::new(),
    };
    if let Some(token) = token {
        conn.send(ServerMsg::Paired { token, device_name: device.name.clone() });
    }
    conn.send(ServerMsg::Ready { device_name: device.name.clone(), host_name: shared.host_name.clone() });
    conn.send(ServerMsg::Usage { items: usage_rx.borrow_and_update().clone() });
    conn.send(ServerMsg::Actions { actions: actions_rx.borrow_and_update().clone() });
    let settings = settings_rx.borrow_and_update().clone();
    if !settings.is_null() {
        conn.send(ServerMsg::Settings { settings });
    }

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
            _ = tick.tick() => {
                conn.prune_subs();
                conn.push_tabs_if_changed().await;
            }
            Ok(()) = usage_rx.changed() => {
                let items = usage_rx.borrow_and_update().clone();
                conn.send(ServerMsg::Usage { items });
            }
            Ok(()) = actions_rx.changed() => {
                let actions = actions_rx.borrow_and_update().clone();
                conn.send(ServerMsg::Actions { actions });
            }
            Ok(()) = settings_rx.changed() => {
                let settings = settings_rx.borrow_and_update().clone();
                if !settings.is_null() {
                    conn.send(ServerMsg::Settings { settings });
                }
            }
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

/// Keystrokes for one pty: a queue and a worker so they reach it in order.
/// Each write can block, so it runs on the blocking pool - and being per pty,
/// a stuck program stalls only its own tab's input.
struct InputWorker {
    tx: mpsc::Sender<String>,
    task: tokio::task::JoinHandle<()>,
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
    inputs: HashMap<String, InputWorker>,
    last_tabs: Vec<Tab>,
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
            if let Some(worker) = self.inputs.remove(&pty_id) {
                worker.task.abort();
            }
        }
    }

    /// Stops every task this connection started.
    fn shutdown(&mut self) {
        for (_, task) in self.subs.drain() {
            task.abort();
        }
        for (_, worker) in self.inputs.drain() {
            worker.task.abort();
        }
    }

    async fn push_tabs_if_changed(&mut self) {
        let tabs = self.shared.tabs().await;
        if tabs != self.last_tabs {
            self.last_tabs = tabs.clone();
            self.send(ServerMsg::Tabs { tabs });
        }
    }

    /// Queues keystrokes for `pty_id`, in order. A phone that floods input
    /// faster than the pty takes it is disconnected.
    fn input(&mut self, pty_id: String, data: String) {
        if !self.inputs.contains_key(&pty_id) {
            if self.inputs.len() >= MAX_SUBS {
                self.error(tr("Troppi terminali", "Too many terminals"), Some(pty_id));
                return;
            }
            let (tx, mut rx) = mpsc::channel::<String>(INPUT_QUEUE);
            let app = self.shared.app.clone();
            let target = pty_id.clone();
            let task = tokio::spawn(async move {
                while let Some(data) = rx.recv().await {
                    let (app, target) = (app.clone(), target.clone());
                    let _ = crate::blocking(move || app.state::<PtyState>().write(&target, &data)).await;
                }
            });
            self.inputs.insert(pty_id.clone(), InputWorker { tx, task });
        }
        let Some(worker) = self.inputs.get(&pty_id) else { return };
        match worker.tx.try_send(data) {
            Ok(()) => {}
            Err(mpsc::error::TrySendError::Full(_)) => self.overflow.store(true, Ordering::Relaxed),
            Err(mpsc::error::TrySendError::Closed(_)) => {
                self.inputs.remove(&pty_id);
            }
        }
    }

    async fn handle(&mut self, msg: ClientMsg) {
        match msg {
            ClientMsg::Auth { .. } | ClientMsg::Pair { .. } => {}
            ClientMsg::Ping => self.send(ServerMsg::Pong),
            ClientMsg::List => {
                let tabs = self.shared.tabs().await;
                self.last_tabs = tabs.clone();
                self.send(ServerMsg::Tabs { tabs });
            }
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
                if let Some(task) = self.subs.remove(&pty_id) {
                    task.abort();
                }
                if let Some(worker) = self.inputs.remove(&pty_id) {
                    // Lets what is queued drain, then the worker ends.
                    drop(worker.tx);
                }
                self.shared.release_size(&pty_id, self.id);
            }
            ClientMsg::Input { pty_id, data } => {
                if data.len() > proto::MAX_INPUT_BYTES {
                    self.error(tr("Input troppo lungo", "Input too large"), Some(pty_id));
                } else {
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
        let cwd = self.shared.app.state::<crate::windows::WindowTabs>().by_pty().get(&pty_id).map(|(_, t)| t.cwd.clone());
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

/// Drops a pending snapshot request if its stream is cancelled or times out.
struct WaiterGuard<'a>(&'a Shared, String);

impl Drop for WaiterGuard<'_> {
    fn drop(&mut self) {
        lock(&self.0.waiters).remove(&self.1);
    }
}

/// Keeps `data` within `SNAPSHOT_MAX_ENCODED` once JSON-encoded (that is what
/// goes on the wire: escapes make colored scrollback much bigger than its raw
/// bytes) by dropping its oldest part, cutting at a line boundary so no line
/// is left half-drawn. Returns whether anything was dropped.
fn fit_snapshot(mut data: String) -> (String, bool) {
    let encoded = |text: &str| serde_json::to_string(text).map_or(usize::MAX, |s| s.len());
    let mut trimmed = false;
    loop {
        let size = encoded(&data);
        if size <= SNAPSHOT_MAX_ENCODED || data.is_empty() {
            break;
        }
        // Encoding never shrinks text, so dropping the excess is a lower bound.
        let mut cut = (size - SNAPSHOT_MAX_ENCODED).min(data.len());
        while !data.is_char_boundary(cut) {
            cut += 1;
        }
        if let Some(newline) = data[cut..].find('\n') {
            cut += newline + 1;
        }
        data.drain(..cut);
        trimmed = true;
    }
    (data, trimmed)
}

/// The desktop's rendering of `pty_id`, asked of the window that owns it.
/// Empty (seq 0) when nobody can answer in time.
async fn request_snapshot(shared: &Shared, pty_id: &str, owner: Option<String>) -> SnapshotReply {
    let Some(owner) = owner else { return (String::new(), 0) };
    let Ok(req_id) = random_hex(8) else { return (String::new(), 0) };
    let (tx, reply) = oneshot::channel();
    lock(&shared.waiters).insert(req_id.clone(), tx);
    let _guard = WaiterGuard(shared, req_id.clone());
    let payload = serde_json::json!({ "reqId": req_id, "ptyId": pty_id });
    if shared.app.emit_to(owner.as_str(), EVT_SNAPSHOT_REQUEST, payload).is_ok() {
        if let Ok(Ok(reply)) = tokio::time::timeout(SNAPSHOT_TIMEOUT, reply).await {
            return reply;
        }
    }
    (String::new(), 0)
}

/// One client's view of one pty: snapshot of the current screen, then the
/// live output. Subscribes *before* asking for the snapshot so no output can
/// fall in the gap; whatever the snapshot already includes (seq <= its seq)
/// is skipped.
///
/// When the phone can't keep up (the pty's queue for it, or its share of the
/// connection's out queue, is full) the output is dropped instead of
/// buffered, and once things drain a new snapshot replaces what was lost.
async fn stream_pty(shared: Arc<Shared>, pty_id: String, out: mpsc::Sender<ServerMsg>) {
    let subscription = shared.app.state::<PtyState>().remote_subscribe(&pty_id);
    let Some((mut feed, mut cols, mut rows, owner)) = subscription else {
        let message = tr("Terminale non trovato", "Terminal not found").to_string();
        let _ = out.send(ServerMsg::Error { message, pty_id: Some(pty_id.clone()), fatal: false }).await;
        let _ = out.send(ServerMsg::Exit { pty_id }).await;
        return;
    };

    let (data, mut snapshot_seq) = request_snapshot(&shared, &pty_id, owner).await;
    if !send_snapshot(&out, &pty_id, data, cols, rows).await {
        return;
    }

    // Set while output is being dropped; `lost_seq` is the newest dropped.
    let mut resync = false;
    let mut lost_seq = 0u64;
    let mut attempts = 0u32;
    loop {
        if feed.is_lagged() {
            resync = true;
        }
        if resync {
            // What is queued is superseded by the snapshot: discard it.
            match feed.rx.try_recv() {
                Ok(RemoteOut::Output { seq, .. }) => {
                    lost_seq = lost_seq.max(seq);
                    continue;
                }
                Ok(RemoteOut::Exit) | Err(mpsc::error::TryRecvError::Disconnected) => break,
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
            if out.is_closed() {
                return;
            }
            // Wait for the phone to work through what it already has.
            if out.capacity() < OUT_QUEUE / 2 {
                tokio::time::sleep(RESYNC_POLL).await;
                continue;
            }
            feed.clear_lag();
            let owner = shared.app.state::<PtyState>().owner_of(&pty_id);
            let (data, seq) = request_snapshot(&shared, &pty_id, owner).await;
            if let Some(size) = shared.app.state::<PtyState>().sizes().get(&pty_id) {
                (cols, rows) = *size;
            }
            if !send_snapshot(&out, &pty_id, data, cols, rows).await {
                return;
            }
            snapshot_seq = seq;
            // The window may not have drawn the newest dropped output yet: if
            // the snapshot predates it, go again (a few times at most).
            attempts += 1;
            if seq >= lost_seq.max(feed.dropped_seq()) || attempts >= RESYNC_ATTEMPTS {
                resync = false;
                attempts = 0;
                lost_seq = 0;
            } else {
                tokio::time::sleep(RESYNC_POLL).await;
            }
            continue;
        }
        let Some(event) = feed.rx.recv().await else { break };
        match event {
            RemoteOut::Output { data, seq } if seq > snapshot_seq => {
                // Keep room in the queue for replies and pushes.
                if out.capacity() <= OUT_RESERVE {
                    lost_seq = lost_seq.max(seq);
                    resync = true;
                    continue;
                }
                match out.try_send(ServerMsg::Output { pty_id: pty_id.clone(), data }) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        lost_seq = lost_seq.max(seq);
                        resync = true;
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => return,
                }
            }
            RemoteOut::Output { .. } => {}
            RemoteOut::Exit => break,
        }
    }
    // Either the program exited or the session vanished: both end the stream.
    let _ = out.send(ServerMsg::Exit { pty_id }).await;
}

/// Queues a snapshot, trimmed to fit a frame (and saying so when it had to
/// be). False when the connection is gone.
async fn send_snapshot(out: &mpsc::Sender<ServerMsg>, pty_id: &str, data: String, cols: u16, rows: u16) -> bool {
    let (data, trimmed) = fit_snapshot(data);
    if trimmed {
        let message = tr(
            "Cronologia del terminale accorciata: era troppo lunga",
            "Terminal history shortened: it was too long",
        )
        .to_string();
        let _ = out.send(ServerMsg::Error { message, pty_id: Some(pty_id.to_string()), fatal: false }).await;
    }
    out.send(ServerMsg::Snapshot { pty_id: pty_id.to_string(), data, cols, rows }).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

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
    fn utc_timestamps_are_formatted() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00.000");
        assert_eq!(format_utc(1_709_210_096_789), "2024-02-29 12:34:56.789");
    }

    #[test]
    fn log_file_rotates_past_its_cap() {
        let dir = std::env::temp_dir().join(format!("flowcode-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote.log");
        let _ = std::fs::remove_file(&path);
        for i in 0..20 {
            append_capped(&path, &format!("line {i:02} xxxxxxxxxx"), 100);
        }
        let current = std::fs::read_to_string(&path).unwrap();
        let old = std::fs::read_to_string(dir.join("remote.log.old")).unwrap();
        assert!(current.len() < 200 && old.len() < 200);
        assert!(current.contains("line 19"));
        assert!(!old.contains("line 19"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn short_id_never_panics() {
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(short_id("0123456789abcdef"), "0123456789");
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
    fn token_is_bound_to_the_node_that_paired() {
        let mut config = Config::default();
        let (device, token) = config.add_device("  Pixel  ", "node-a", 5).unwrap();
        assert_eq!(device.name, "Pixel");
        // The right token from the right node.
        assert_eq!(config.authenticate(&token, "node-a").map(|d| d.id), Some(device.id.clone()));
        // A stolen token from another node is useless...
        assert!(config.authenticate(&token, "node-b").is_none());
        // ...and so is the right node with a wrong token.
        assert!(config.authenticate("nope", "node-a").is_none());
        // Only the hash is stored.
        assert!(config.devices.iter().all(|d| d.token_hash != token));
    }

    #[test]
    fn a_device_without_a_node_id_never_authenticates() {
        let mut config = Config::default();
        let (mut device, token) = config.add_device("Old", "node-a", 5).unwrap();
        device.node_id = String::new();
        config.devices = vec![device];
        assert!(config.authenticate(&token, "").is_none());
        assert!(config.authenticate(&token, "node-a").is_none());
    }

    #[test]
    fn pairing_again_from_the_same_node_replaces_the_device() {
        let mut config = Config::default();
        let (_, first) = config.add_device("Phone", "node-a", 1).unwrap();
        let (second, token) = config.add_device("Phone", "node-a", 2).unwrap();
        assert_eq!(config.devices.len(), 1);
        assert!(config.authenticate(&first, "node-a").is_none());
        assert_eq!(config.authenticate(&token, "node-a").map(|d| d.id), Some(second.id));
        config.add_device("Tablet", "node-b", 3).unwrap();
        assert_eq!(config.devices.len(), 2);
    }

    #[test]
    fn node_key_survives_a_reload() {
        let dir = std::env::temp_dir().join(format!("flowcode-key-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote-node.key");
        let first = load_or_create_key(&path).unwrap();
        let second = load_or_create_key(&path).unwrap();
        assert_eq!(first.public(), second.public());
        std::fs::write(&path, "garbage").unwrap();
        assert_ne!(load_or_create_key(&path).unwrap().public(), first.public());
        let _ = std::fs::remove_dir_all(&dir);
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

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flowcode-remote-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ls_stays_inside_the_tab_folder() {
        let base = scratch("ls");
        let root = base.join("project");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("zeta.txt"), "z").unwrap();
        std::fs::write(root.join(".env"), "x").unwrap();
        std::fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        std::fs::write(base.join("secret.txt"), "s").unwrap();

        // Dirs first, hidden files included.
        let (path, entries) = list_dir(&root, "").unwrap();
        assert_eq!(path, "");
        let names: Vec<_> = entries.iter().map(|e| (e.name.as_str(), e.dir)).collect();
        assert_eq!(names, vec![("src", true), (".env", false), ("zeta.txt", false)]);
        assert_eq!(list_dir(&root, "src").unwrap().0, "src");

        // Parent traversal, however spelled, and absolute paths outside.
        assert!(list_dir(&root, "..").is_err());
        assert!(list_dir(&root, "src/../..").is_err());
        assert!(list_dir(&root, "../project").is_err());
        assert!(read_text(&root, "../secret.txt").is_err());
        assert!(read_text(&root, base.join("secret.txt").to_str().unwrap()).is_err());
        // An absolute path inside the folder is fine.
        assert!(read_text(&root, root.join("zeta.txt").to_str().unwrap()).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_text_truncates_and_refuses_binary() {
        let root = scratch("read");
        std::fs::write(root.join("big.txt"), "a".repeat(MAX_READ_BYTES + 10)).unwrap();
        std::fs::write(root.join("bin.dat"), [1u8, 0, 2]).unwrap();
        std::fs::write(root.join("small.txt"), "héllo").unwrap();
        let (_, text, truncated) = read_text(&root, "big.txt").unwrap();
        assert!(truncated && text.len() <= MAX_READ_BYTES);
        assert!(read_text(&root, "bin.dat").is_err());
        let (path, text, truncated) = read_text(&root, "small.txt").unwrap();
        assert_eq!((path.as_str(), text.as_str(), truncated), ("small.txt", "héllo", false));
        assert!(read_text(&root, "missing.txt").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn escaped_text_is_cut_to_fit_a_frame() {
        let root = scratch("escape");
        // Control characters encode as six bytes each.
        std::fs::write(root.join("ctl.txt"), "\u{1}".repeat(MAX_READ_BYTES)).unwrap();
        let (_, text, truncated) = read_text(&root, "ctl.txt").unwrap();
        assert!(truncated);
        assert!(serde_json::to_string(&text).unwrap().len() < proto::MAX_FRAME);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_is_trimmed_on_a_char_boundary() {
        let big = "é".repeat(proto::MAX_FRAME);
        let (fitted, trimmed) = fit_snapshot(big);
        assert!(trimmed && fitted.len() <= SNAPSHOT_MAX_ENCODED);
        assert_eq!(fit_snapshot("short".into()), ("short".to_string(), false));
    }

    #[test]
    fn snapshot_limit_counts_the_json_encoding_and_cuts_at_a_line() {
        // Escapes (ESC is six bytes once encoded) fit by raw length but not
        // once encoded.
        let line = "\u{1b}[31mred\u{1b}[0m line\n";
        let raw = line.repeat(25_000);
        assert!(raw.len() < SNAPSHOT_MAX_ENCODED);
        assert!(serde_json::to_string(&raw).unwrap().len() > SNAPSHOT_MAX_ENCODED);
        let (fitted, trimmed) = fit_snapshot(raw);
        assert!(trimmed);
        assert!(serde_json::to_string(&fitted).unwrap().len() <= SNAPSHOT_MAX_ENCODED);
        // Whole lines only: the oldest were dropped, the newest kept.
        assert!(fitted.starts_with(line) && fitted.ends_with(line));
        assert_eq!(fitted.len() % line.len(), 0);
    }

    #[test]
    fn device_names_are_sanitized() {
        assert_eq!(clean_name("  Pixel 8\n\u{7}\u{1b}[2J "), "Pixel 8[2J");
        assert_eq!(clean_name(&"x".repeat(200)).chars().count(), 64);
        assert_eq!(clean_name("\n\t"), "");
    }

    #[test]
    fn a_repeated_pair_start_reuses_the_fresh_code() {
        let mut p = Pairings::default();
        let (code, expires) = p.start("first".into(), 1_000);
        // Within the reuse window: same code, same expiry.
        assert_eq!(p.recent(1_000 + PAIR_REUSE_MS - 1), Some((code, expires)));
        // Past it, or once used or cancelled, a new one is needed.
        assert_eq!(p.recent(1_000 + PAIR_REUSE_MS), None);
        p.start("second".into(), 50_000);
        assert_eq!(p.redeem("second", 50_001), Ok(()));
        assert_eq!(p.recent(50_002), None);
        p.start("third".into(), 60_000);
        p.active = None;
        assert_eq!(p.recent(60_001), None);
    }

    #[test]
    fn retrying_a_spent_code_is_not_a_guess() {
        let mut p = Pairings::default();
        p.start("good".into(), 0);
        assert_eq!(p.redeem("good", 10), Ok(()));
        // The phone retries after the user declined: invalid, but never blocks.
        for i in 0..(MAX_PAIR_FAILURES as u64 * 2) {
            assert_eq!(p.redeem("good", 20 + i), Err(PairError::Invalid));
        }
        p.start("next".into(), 1_000);
        assert_eq!(p.redeem("next", 1_001), Ok(()));
        // Real guesses still count.
        p.start("again".into(), 2_000);
        for i in 0..MAX_PAIR_FAILURES as u64 {
            assert_eq!(p.redeem("wrong", 2_001 + i), Err(PairError::Invalid));
        }
        assert_eq!(p.redeem("again", 2_100), Err(PairError::RateLimited));
    }

    #[test]
    fn failed_auths_block_only_that_node() {
        let mut l = AuthLimiter::default();
        for i in 0..MAX_AUTH_FAILURES as u64 {
            assert!(l.allowed("a", i));
            l.failed("a", i);
        }
        assert!(!l.allowed("a", 100));
        assert!(l.allowed("b", 100));
        assert!(l.allowed("a", 10 + BLOCK_MS));
        // A success forgets the failures.
        l.failed("b", 200);
        l.succeeded("b");
        assert!(!l.nodes.contains_key("b"));
    }

    #[test]
    fn a_second_instance_cannot_take_the_endpoint() {
        let dir = scratch("lock");
        let key = dir.join("remote-node.key");
        let first = acquire_instance_lock(&key).unwrap();
        assert!(acquire_instance_lock(&key).is_err());
        drop(first);
        assert!(acquire_instance_lock(&key).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn node_key_is_sealed_on_windows_and_a_plain_one_migrates() {
        let dir = scratch("seal");
        let path = dir.join("remote-node.key");
        let key = load_or_create_key(&path).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(on_disk.starts_with(SEALED_PREFIX));
        assert!(!on_disk.contains(&to_hex(&key.to_bytes())));
        assert_eq!(load_or_create_key(&path).unwrap().public(), key.public());

        // A key written by an earlier version: same identity, now sealed.
        std::fs::write(&path, to_hex(&key.to_bytes())).unwrap();
        assert_eq!(load_or_create_key(&path).unwrap().public(), key.public());
        assert!(std::fs::read_to_string(&path).unwrap().starts_with(SEALED_PREFIX));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
