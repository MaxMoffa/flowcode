//! The desktop as a *client*: connects to other PCs running Flowcode exactly
//! like the phone does (same protocol, same pairing), with one live link per
//! paired PC, all alive at the same time. The server side stays in `remote/`.
//!
//! The Tauri-free pieces of the phone app (dial and handshake, the sealed
//! pairing store, backoff timing, the connection log) are shared with
//! `mobile/src-tauri` by path rather than copied, so a fix there reaches both.

#[allow(dead_code)]
#[path = "../../../mobile/src-tauri/src/link.rs"]
mod link;
#[allow(dead_code)]
#[path = "../../../mobile/src-tauri/src/store.rs"]
mod store;
#[allow(dead_code)]
#[path = "../../../mobile/src-tauri/src/backoff.rs"]
mod backoff;
#[allow(dead_code)]
#[path = "../../../mobile/src-tauri/src/connlog.rs"]
mod connlog;

mod host;

use crate::remote::{keystore, RemoteState};
use flowcode_remote_proto::{ClientMsg, PairingTicket, ServerMsg};
use iroh::Endpoint;
use link::{LinkError, Session};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use store::{Codec, OpenError, Pairing};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Notify};

/// Messages waiting for a link; `remote_host_send` refuses more ("busy")
/// instead of growing without bound while the link is stuck.
const OUT_QUEUE: usize = 256;

const EVT_STATE: &str = "remote-host://state";
const EVT_MSGS: &str = "remote-host://msgs";
const EVT_LIST: &str = "remote-host://list";

// ---- secrets ---------------------------------------------------------------

/// Seals the client key and `hosts.json` with DPAPI on Windows (the tokens in
/// them are credentials for the other PCs); pass-through elsewhere, like the
/// server's node key.
struct Dpapi;

impl Codec for Dpapi {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        if cfg!(windows) {
            keystore::seal(plain).ok_or_else(|| "cannot protect the secret".to_string())
        } else {
            Ok(plain.to_vec())
        }
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, OpenError> {
        if cfg!(windows) {
            keystore::unseal(sealed).ok_or_else(|| OpenError::Lost("cannot unprotect the secret".into()))
        } else {
            Ok(sealed.to_vec())
        }
    }
    fn seals(&self) -> bool {
        cfg!(windows)
    }
}

// ---- wire types ------------------------------------------------------------

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum HostStatus {
    Offline,
    Connecting,
    Online,
}

/// What the webview knows about a paired PC. While the loop waits to redial,
/// the status is `connecting` with `error` holding why the last attempt failed.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    pub id: String,
    pub host_name: String,
    pub device_name: String,
    pub status: HostStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub caps: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
}

impl HostInfo {
    fn offline(pairing: &Pairing) -> HostInfo {
        HostInfo {
            id: link::computer_id(&pairing.node),
            host_name: pairing.host_name.clone(),
            device_name: pairing.device_name.clone(),
            status: HostStatus::Offline,
            error: None,
            caps: Vec::new(),
            app_version: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInspect {
    host_name: String,
    fingerprint: String,
    is_self: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MsgsEvent<'a> {
    host_id: &'a str,
    msgs: &'a [ServerMsg],
}

// ---- per-host state --------------------------------------------------------

/// Everything known about one PC while the app runs. Kept (offline) after a
/// disconnect so the diagnostics log survives; dropped on forget.
struct Conn {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Bumped on every (re)start so a finishing task knows whether it is
    /// still the current one.
    generation: u64,
    out: Option<mpsc::Sender<ClientMsg>>,
    info: HostInfo,
    /// Cuts the backoff sleep short. Only `notify_waiters` is used, so a call
    /// with nobody waiting leaves no permit behind to skip a later backoff.
    retry: Arc<Notify>,
    log: Arc<connlog::ConnLog>,
    /// Latest message of each replayable kind (see `cache_kind`).
    cache: Vec<(&'static str, ServerMsg)>,
    /// How many windows have each pty / chat open on this link.
    ptys: HashMap<String, u32>,
    chats: HashMap<String, u32>,
}

impl Conn {
    fn new(info: HostInfo) -> Conn {
        Conn {
            task: None,
            generation: 0,
            out: None,
            info,
            retry: Arc::new(Notify::new()),
            log: Arc::new(connlog::ConnLog::default()),
            cache: Vec::new(),
            ptys: HashMap::new(),
            chats: HashMap::new(),
        }
    }

    /// The server forgot every stream when the link went down.
    fn clear_streams(&mut self) {
        self.ptys.clear();
        self.chats.clear();
    }
}

/// Which messages a window that mounts later replays instead of waiting for
/// the next push: the desktop only sends these on change.
fn cache_kind(msg: &ServerMsg) -> Option<&'static str> {
    Some(match msg {
        ServerMsg::Tabs { .. } => "tabs",
        ServerMsg::Chats { .. } => "chats",
        ServerMsg::Settings { .. } => "settings",
        ServerMsg::Actions { .. } => "actions",
        ServerMsg::Profiles { .. } => "profiles",
        ServerMsg::Usage { .. } => "usage",
        ServerMsg::Views { .. } => "views",
        _ => return None,
    })
}

/// Keeps only the last message of each cached kind.
fn cache_put(cache: &mut Vec<(&'static str, ServerMsg)>, msg: &ServerMsg) {
    let Some(kind) = cache_kind(msg) else { return };
    match cache.iter_mut().find(|(k, _)| *k == kind) {
        Some(slot) => slot.1 = msg.clone(),
        None => cache.push((kind, msg.clone())),
    }
}

/// One more window has `id` open.
fn track_open(map: &mut HashMap<String, u32>, id: &str) {
    *map.entry(id.to_string()).or_insert(0) += 1;
}

/// One window closed `id`. True when it was the last one, i.e. the server
/// should hear about it; false (and nothing changes) when none was open.
fn track_close(map: &mut HashMap<String, u32>, id: &str) -> bool {
    match map.get_mut(id) {
        None => false,
        Some(count) if *count > 1 => {
            *count -= 1;
            false
        }
        Some(_) => {
            map.remove(id);
            true
        }
    }
}

// ---- state -----------------------------------------------------------------

pub struct RemoteClients {
    dir: PathBuf,
    codec: Dpapi,
    /// Created lazily and rebuilt after repeated failures (`reset_endpoint`).
    /// One endpoint serves every host.
    endpoint: tokio::sync::Mutex<Option<Endpoint>>,
    conns: Mutex<HashMap<String, Conn>>,
    /// A `pair` is running; a second one is refused.
    pairing: AtomicBool,
    /// Wakes a running `pair` to abandon the wait for the other PC's confirmation.
    pair_cancel: Notify,
    /// Serializes read-modify-write of hosts.json.
    hosts_lock: Mutex<()>,
}

/// Clears `RemoteClients::pairing` however `remote_host_pair` ends.
struct PairGuard<'a>(&'a AtomicBool);

impl Drop for PairGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl RemoteClients {
    pub fn new(app: &AppHandle) -> Arc<RemoteClients> {
        let dir = app.path().app_data_dir().unwrap_or_default().join("remote-client");
        Arc::new(RemoteClients {
            dir,
            codec: Dpapi,
            endpoint: tokio::sync::Mutex::new(None),
            conns: Mutex::new(HashMap::new()),
            pairing: AtomicBool::new(false),
            pair_cancel: Notify::new(),
            hosts_lock: Mutex::new(()),
        })
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Conn>> {
        self.conns.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("client.key")
    }

    fn hosts_path(&self) -> PathBuf {
        self.dir.join("hosts.json")
    }

    // -- hosts.json --

    fn load_hosts(&self) -> Result<Vec<Pairing>, String> {
        let _guard = self.hosts_lock.lock().unwrap_or_else(|e| e.into_inner());
        store::load_others(&self.hosts_path(), &self.codec)
    }

    /// Read-modify-write of hosts.json under the lock.
    fn modify_hosts<R>(&self, f: impl FnOnce(&mut Vec<Pairing>) -> R) -> Result<R, String> {
        let _guard = self.hosts_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut list = store::load_others(&self.hosts_path(), &self.codec)?;
        let result = f(&mut list);
        store::save_others(&self.hosts_path(), &list, &self.codec)?;
        Ok(result)
    }

    fn pairing_of(&self, id: &str) -> Result<Option<Pairing>, String> {
        Ok(self.load_hosts()?.into_iter().find(|p| link::computer_id(&p.node) == id))
    }

    // -- endpoint --

    async fn endpoint(&self) -> Result<Endpoint, String> {
        let mut slot = self.endpoint.lock().await;
        if let Some(endpoint) = slot.as_ref().filter(|e| !e.is_closed()) {
            return Ok(endpoint.clone());
        }
        let key = store::load_or_create_key(&self.key_path(), &self.codec)?;
        let endpoint = link::bind(key).await?;
        *slot = Some(endpoint.clone());
        Ok(endpoint)
    }

    /// Throws the endpoint away; the next `endpoint()` binds a fresh one.
    async fn reset_endpoint(&self) {
        let old = self.endpoint.lock().await.take();
        if let Some(old) = old {
            // Closed before the next bind: two endpoints with one key alive at
            // once would fight over the relay's single slot for this node id.
            let _ = tokio::time::timeout(Duration::from_secs(2), old.close()).await;
        }
    }

    // -- state --

    /// Updates a host's info and tells every window.
    fn update_info(&self, app: &AppHandle, id: &str, f: impl FnOnce(&mut HostInfo)) {
        let info = {
            let mut conns = self.lock();
            let Some(conn) = conns.get_mut(id) else { return };
            f(&mut conn.info);
            conn.info.clone()
        };
        let _ = app.emit(EVT_STATE, info);
    }

    fn set_status(&self, app: &AppHandle, id: &str, status: HostStatus, error: Option<String>) {
        self.update_info(app, id, |info| {
            info.status = status;
            info.error = error;
        });
    }

    /// The connection record for `pairing`, created offline on first use.
    fn ensure_conn(&self, pairing: &Pairing) {
        let info = HostInfo::offline(pairing);
        self.lock().entry(info.id.clone()).or_insert_with(|| Conn::new(info));
    }

    // -- loop lifecycle --

    /// Stops the host's loop (if any) and drops its outbound queue and streams.
    fn stop_host(&self, id: &str) {
        let mut conns = self.lock();
        if let Some(conn) = conns.get_mut(id) {
            conn.generation += 1;
            conn.out = None;
            conn.clear_streams();
            if let Some(task) = conn.task.take() {
                task.abort();
            }
        }
    }

    /// Starts the host's loop unless one is running (`only_if_idle`), else
    /// replaces it. Checked and started under one lock so two callers at once
    /// cannot abort each other's dial. `initial` is a session `pair` already
    /// established.
    fn start_host(self: &Arc<Self>, app: &AppHandle, pairing: &Pairing, initial: Option<Session>, only_if_idle: bool) {
        self.ensure_conn(pairing);
        let id = link::computer_id(&pairing.node);
        let mut conns = self.lock();
        let Some(conn) = conns.get_mut(&id) else { return };
        if only_if_idle && conn.task.is_some() {
            return;
        }
        conn.generation += 1;
        let generation = conn.generation;
        if let Some(task) = conn.task.take() {
            task.abort();
        }
        let (clients, app, task_id) = (Arc::clone(self), app.clone(), id.clone());
        conn.task = Some(tauri::async_runtime::spawn(async move {
            host::host_loop(&app, &clients, &task_id, initial).await;
            let mut conns = clients.lock();
            if let Some(conn) = conns.get_mut(&task_id).filter(|c| c.generation == generation) {
                conn.task = None;
                conn.out = None;
                conn.clear_streams();
            }
        }));
    }

    /// Whether some host other than `id` has a live link on the endpoint.
    fn other_online(&self, id: &str) -> bool {
        self.lock().iter().any(|(k, c)| k != id && c.info.status == HostStatus::Online)
    }
}

// ---- commands --------------------------------------------------------------

fn is_self(remote: &RemoteState, node: &str) -> bool {
    remote.node_id().is_some_and(|own| own == link::computer_id(node))
}

/// Every paired PC with its live status (offline when no link was started).
// `(async)`: reading hosts.json is a DPAPI call, off the main thread.
#[tauri::command(async)]
pub fn remote_hosts(clients: State<'_, Arc<RemoteClients>>) -> Vec<HostInfo> {
    let Ok(hosts) = clients.load_hosts() else { return Vec::new() };
    let conns = clients.lock();
    hosts
        .iter()
        .map(|p| conns.get(&link::computer_id(&p.node)).map_or_else(|| HostInfo::offline(p), |c| c.info.clone()))
        .collect()
}

/// What a pairing link points at, to ask "connect to <host>?" before pairing.
#[tauri::command]
pub fn remote_host_inspect(remote: State<'_, RemoteState>, ticket: String) -> Result<HostInspect, String> {
    let (host_name, fingerprint) = link::inspect_ticket(&ticket)?;
    let host_name = host::clean_peer_name(&host_name, "Flowcode");
    let parsed = PairingTicket::parse(&ticket).map_err(|e| e.to_string())?;
    Ok(HostInspect { host_name, fingerprint, is_self: is_self(&remote, &parsed.node) })
}

/// Fingerprint of this desktop's client node id; the other PC shows the same
/// one in its confirm dialog, so the user can compare.
#[tauri::command]
pub async fn remote_host_fingerprint(clients: State<'_, Arc<RemoteClients>>) -> Result<String, String> {
    let endpoint = clients.endpoint().await?;
    Ok(flowcode_remote_proto::node_fingerprint(&endpoint.id().to_string()))
}

#[tauri::command]
pub async fn remote_host_pair(
    app: AppHandle,
    clients: State<'_, Arc<RemoteClients>>,
    remote: State<'_, RemoteState>,
    ticket: String,
    device_name: String,
) -> Result<HostInfo, String> {
    let clients = Arc::clone(&clients);
    // A second pair while one waits for the other PC's confirmation is refused
    // before it can touch any state.
    if clients.pairing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("a pairing is already in progress".into());
    }
    let _guard = PairGuard(&clients.pairing);
    // Registered before anything else: a cancel that lands before the select
    // below first polls it must still count.
    let cancelled = clients.pair_cancel.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();
    let parsed = PairingTicket::parse(&ticket).map_err(|e| e.to_string())?;
    let device_name = device_name.trim().to_string();
    if device_name.is_empty() {
        return Err("device name is empty".into());
    }
    if is_self(&remote, &parsed.node) {
        return Err("this is the same computer".into());
    }
    // Checked before the other PC registers this one: failing after the
    // handshake would leave an orphan device there.
    clients.load_hosts()?;
    let result = tokio::select! {
        r = async {
            let endpoint = clients.endpoint().await.map_err(LinkError::Transient)?;
            let device_name = device_name.clone();
            link::handshake_with(&endpoint, &parsed.node, ClientMsg::Pair { code: parsed.code.clone(), device_name }, || {}, |_| {}).await
        } => Some(r),
        _ = &mut cancelled => None,
    };
    let session = match result {
        Some(Ok(s)) => s,
        Some(Err(e)) => return Err(e.message().to_string()),
        None => return Err("cancelled".into()),
    };
    let token = session.token.clone().ok_or_else(|| "the computer did not issue a token".to_string())?;
    // What the other PC says is shown as is in the list: cleaned first, with
    // the ticket's own host name / the name we asked for when nothing is left.
    let host_name = host::clean_peer_name(&session.host_name, &host::clean_peer_name(&parsed.host, "Flowcode"));
    let device_name = host::clean_peer_name(&session.device_name, &device_name);
    let pairing = Pairing { node: parsed.node, token, host_name, device_name };
    let id = link::computer_id(&pairing.node);
    // Paired again with a known PC replaces its entry (new token).
    clients.modify_hosts(|list| {
        list.retain(|p| link::computer_id(&p.node) != id);
        list.push(pairing.clone());
    })?;
    // A fresh pairing resets what the record knew (name, error).
    clients.ensure_conn(&pairing);
    clients.update_info(&app, &id, |info| {
        info.host_name = pairing.host_name.clone();
        info.device_name = pairing.device_name.clone();
    });
    let _ = app.emit(EVT_LIST, ());
    clients.start_host(&app, &pairing, Some(session), false);
    let info = clients.lock().get(&id).map(|c| c.info.clone());
    info.ok_or_else(|| "the computer vanished".to_string())
}

/// "Cancel" on the waiting page: stops a pair that waits for the other PC.
#[tauri::command]
pub fn remote_host_cancel_pair(clients: State<'_, Arc<RemoteClients>>) {
    clients.pair_cancel.notify_waiters();
}

/// Starts the host's reconnect loop; harmless when it already runs (it
/// republishes the state and ends a backoff sleep early).
// `(async)`: reading hosts.json is a DPAPI call, off the main thread.
#[tauri::command(async)]
pub fn remote_host_connect(app: AppHandle, clients: State<'_, Arc<RemoteClients>>, id: String) -> Result<(), String> {
    let clients = Arc::clone(&clients);
    let pairing = clients.pairing_of(&id)?.ok_or_else(|| "unknown computer".to_string())?;
    clients.ensure_conn(&pairing);
    let (running, info, retry) = {
        let conns = clients.lock();
        let conn = conns.get(&id).ok_or_else(|| "unknown computer".to_string())?;
        (conn.task.is_some(), conn.info.clone(), Arc::clone(&conn.retry))
    };
    if running {
        retry.notify_waiters();
        let _ = app.emit(EVT_STATE, info);
        return Ok(());
    }
    clients.start_host(&app, &pairing, None, true);
    Ok(())
}

#[tauri::command]
pub fn remote_host_disconnect(app: AppHandle, clients: State<'_, Arc<RemoteClients>>, id: String) {
    clients.stop_host(&id);
    clients.set_status(&app, &id, HostStatus::Offline, None);
}

#[tauri::command(async)]
pub fn remote_host_forget(app: AppHandle, clients: State<'_, Arc<RemoteClients>>, id: String) -> Result<(), String> {
    clients.stop_host(&id);
    clients.lock().remove(&id);
    clients.modify_hosts(|list| list.retain(|p| link::computer_id(&p.node) != id))?;
    let _ = app.emit(EVT_LIST, ());
    Ok(())
}

#[tauri::command]
pub fn remote_host_send(clients: State<'_, Arc<RemoteClients>>, id: String, msg: serde_json::Value) -> Result<(), String> {
    let msg: ClientMsg = serde_json::from_value(msg).map_err(|e| format!("invalid message: {e}"))?;
    // Handshake messages are the Rust side's business only.
    if matches!(msg, ClientMsg::Pair { .. } | ClientMsg::Auth { .. }) {
        return Err("handshake messages cannot be sent".into());
    }
    // Several windows may view the same stream: every open is forwarded (each
    // opener needs the snapshot), but the server only hears about the close
    // of the last one.
    let out = {
        let mut conns = clients.lock();
        let conn = conns.get_mut(&id).ok_or_else(|| "not connected".to_string())?;
        let out = conn.out.clone().ok_or_else(|| "not connected".to_string())?;
        let forward = match &msg {
            ClientMsg::Open { pty_id, .. } => {
                track_open(&mut conn.ptys, pty_id);
                true
            }
            ClientMsg::Close { pty_id } => track_close(&mut conn.ptys, pty_id),
            ClientMsg::ChatOpen { chat_id, .. } => {
                track_open(&mut conn.chats, chat_id);
                true
            }
            ClientMsg::ChatClose { chat_id } => track_close(&mut conn.chats, chat_id),
            _ => true,
        };
        if !forward {
            return Ok(());
        }
        out
    };
    out.try_send(msg.clone()).map_err(|e| {
        // The open never reached the server: undo its count.
        let mut conns = clients.lock();
        if let Some(conn) = conns.get_mut(&id) {
            match &msg {
                ClientMsg::Open { pty_id, .. } => {
                    track_close(&mut conn.ptys, pty_id);
                }
                ClientMsg::ChatOpen { chat_id, .. } => {
                    track_close(&mut conn.chats, chat_id);
                }
                _ => {}
            }
        }
        match e {
            mpsc::error::TrySendError::Full(_) => "busy".to_string(),
            mpsc::error::TrySendError::Closed(_) => "not connected".to_string(),
        }
    })
}

/// The latest replayable messages of a host, for a window that mounts (or
/// reloads) after they were sent.
#[tauri::command]
pub fn remote_host_cached(clients: State<'_, Arc<RemoteClients>>, id: String) -> Vec<ServerMsg> {
    clients.lock().get(&id).map(|c| c.cache.iter().map(|(_, m)| m.clone()).collect()).unwrap_or_default()
}

/// The recent connection events of a host, oldest first.
#[tauri::command]
pub fn remote_host_log(clients: State<'_, Arc<RemoteClients>>, id: String) -> Vec<connlog::Entry> {
    clients.lock().get(&id).map(|c| c.log.snapshot()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_are_counted_and_only_the_last_close_counts() {
        let mut map = HashMap::new();
        track_open(&mut map, "p1");
        track_open(&mut map, "p1");
        assert!(!track_close(&mut map, "p1"));
        assert!(track_close(&mut map, "p1"));
        assert!(map.is_empty());
    }

    #[test]
    fn closing_something_not_open_is_a_no_op() {
        let mut map = HashMap::new();
        assert!(!track_close(&mut map, "ghost"));
        track_open(&mut map, "a");
        assert!(!track_close(&mut map, "b"));
        assert_eq!(map["a"], 1);
    }

    #[test]
    fn host_info_serializes_camel_case_with_lowercase_status() {
        let info = HostInfo {
            id: "n".into(),
            host_name: "PC".into(),
            device_name: "me".into(),
            status: HostStatus::Connecting,
            error: None,
            caps: vec!["compress".into()],
            app_version: None,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["status"], "connecting");
        assert_eq!(json["hostName"], "PC");
        assert_eq!(json["deviceName"], "me");
        assert!(json.get("error").is_none());
        assert!(json.get("appVersion").is_none());
        let json = serde_json::to_value(HostInfo { error: Some("x".into()), app_version: Some("1".into()), status: HostStatus::Online, ..info }).unwrap();
        assert_eq!(json["status"], "online");
        assert_eq!(json["error"], "x");
        assert_eq!(json["appVersion"], "1");
    }

    #[test]
    fn the_cache_keeps_only_the_last_message_of_each_kind() {
        let mut cache = Vec::new();
        cache_put(&mut cache, &ServerMsg::Tabs { tabs: vec![] });
        cache_put(&mut cache, &ServerMsg::Settings { settings: serde_json::json!({ "a": 1 }) });
        cache_put(&mut cache, &ServerMsg::Settings { settings: serde_json::json!({ "a": 2 }) });
        cache_put(&mut cache, &ServerMsg::Pong);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache[1].1, ServerMsg::Settings { settings: serde_json::json!({ "a": 2 }) });
    }
}
