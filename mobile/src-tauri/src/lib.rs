//! Flowcode Mobile: the phone end of the remote protocol. The Rust side owns
//! the iroh connection (so it survives webview reloads and needs no
//! WebSocket/CORS tricks); the webview gets every server message as an event
//! and sends client messages through `send`.

pub mod link;
mod secure;
pub mod store;

use flowcode_remote_proto::{ClientMsg, PairingTicket, ServerMsg};
use iroh::Endpoint;
use link::{LinkError, Session};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use secure::SecureStore;
use store::Pairing;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Notify, OnceCell};

const PING_EVERY: Duration = Duration::from_secs(20);
/// Pongs answer our pings, so 60 s of total silence means the link is dead
/// even though QUIC has not noticed yet.
const DEAD_AFTER: Duration = Duration::from_secs(60);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(15);

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    /// "unpaired" | "connecting" | "online" | "offline"
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Where a reconnect attempt is: "waiting" (backoff) | "dialing" | "handshake".
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<&'static str>,
    /// Consecutive failures since the link was last online.
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u32>,
    /// Unix ms when the next attempt starts; only while "waiting".
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingState {
    paired: bool,
    host_name: Option<String>,
}

#[derive(Default)]
struct Inner {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Bumped on every (re)start so a finishing task knows whether it is
    /// still the current one.
    generation: u64,
    out: Option<mpsc::UnboundedSender<ClientMsg>>,
    state: StateEvent,
    pending_link: Option<String>,
}

struct Remote {
    dir: PathBuf,
    /// Seals the key and pairing files (Android Keystore; pass-through elsewhere).
    /// Its calls block briefly, which is fine on the async runtime workers.
    codec: SecureStore,
    endpoint: OnceCell<Endpoint>,
    inner: Mutex<Inner>,
    /// Cuts the backoff sleep short (`retry_now`).
    retry: Notify,
}

impl Remote {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("device.key")
    }

    fn pairing_path(&self) -> PathBuf {
        self.dir.join("pairing.json")
    }

    async fn endpoint(&self) -> Result<Endpoint, String> {
        self.endpoint
            .get_or_try_init(|| async {
                let key = store::load_or_create_key(&self.key_path(), &self.codec)?;
                link::bind(key).await
            })
            .await
            .cloned()
    }

    fn set_state(&self, app: &AppHandle, status: &'static str, host_name: Option<String>, error: Option<String>) {
        self.emit(app, StateEvent { status, host_name, error, ..Default::default() });
    }

    fn emit(&self, app: &AppHandle, event: StateEvent) {
        self.lock().state = event.clone();
        let _ = app.emit("remote://state", event);
    }

    /// Reports a reconnect phase for the phone's "connection lost" sheet.
    fn set_phase(&self, app: &AppHandle, status: &'static str, host: Option<String>, error: Option<String>, phase: &'static str, attempt: u32, retry_at: Option<u64>) {
        self.emit(app, StateEvent { status, host_name: host, error, phase: Some(phase), attempt: Some(attempt), retry_at });
    }

    /// Backoff sleep that `retry_now` can end early.
    async fn wait(&self, app: &AppHandle, host: Option<String>, error: String, attempt: u32, delay: Duration) {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64) + delay.as_millis() as u64;
        self.set_phase(app, "offline", host, Some(error), "waiting", attempt, Some(at));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = self.retry.notified() => {}
        }
    }

    /// Stops the reconnect loop (if any) and drops its outbound queue.
    fn stop_task(&self) {
        let mut inner = self.lock();
        inner.generation += 1;
        inner.out = None;
        if let Some(task) = inner.task.take() {
            task.abort();
        }
    }

    fn start_task(self: &Arc<Self>, app: &AppHandle, initial: Option<Session>) {
        let mut inner = self.lock();
        inner.generation += 1;
        let generation = inner.generation;
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        let (remote, app) = (Arc::clone(self), app.clone());
        inner.task = Some(tauri::async_runtime::spawn(async move {
            reconnect_loop(&app, &remote, initial).await;
            let mut inner = remote.lock();
            if inner.generation == generation {
                inner.task = None;
                inner.out = None;
            }
        }));
    }
}

enum Exit {
    /// The desktop refused us for good.
    Fatal(String),
    Lost(String),
}

/// Connects, serves, and reconnects until the pairing is gone or the task is
/// aborted. `initial` is a session `pair` already established.
async fn reconnect_loop(app: &AppHandle, remote: &Arc<Remote>, mut initial: Option<Session>) {
    let mut backoff = BACKOFF_MIN;
    let mut failures: u32 = 0;
    loop {
        let Some(pairing) = store::load_pairing(&remote.pairing_path(), &remote.codec) else {
            remote.set_state(app, "unpaired", None, None);
            return;
        };
        let host = Some(pairing.host_name.clone());
        let session = match initial.take() {
            Some(s) => s,
            None => {
                remote.set_phase(app, "connecting", host.clone(), None, "dialing", failures, None);
                let result = async {
                    let endpoint = remote.endpoint().await.map_err(LinkError::Transient)?;
                    link::handshake_with(&endpoint, &pairing.node, ClientMsg::Auth { token: pairing.token.clone() }, || {
                        remote.set_phase(app, "connecting", host.clone(), None, "handshake", failures, None)
                    })
                    .await
                }
                .await;
                match result {
                    Ok(s) => s,
                    Err(LinkError::Fatal(message)) => {
                        forget(app, remote, message);
                        return;
                    }
                    Err(LinkError::Transient(message)) => {
                        failures += 1;
                        remote.wait(app, host, message, failures, backoff).await;
                        backoff = (backoff * 2).min(BACKOFF_MAX);
                        continue;
                    }
                }
            }
        };
        backoff = BACKOFF_MIN;
        let host_name = session.host_name.clone();
        let _ = app.emit(
            "remote://msg",
            ServerMsg::Ready { device_name: session.device_name.clone(), host_name: host_name.clone() },
        );
        remote.set_state(app, "online", Some(host_name.clone()), None);
        match serve(app, remote, session).await {
            Exit::Fatal(message) => {
                forget(app, remote, message);
                return;
            }
            Exit::Lost(message) => {
                failures = 1;
                remote.wait(app, Some(host_name), message, failures, BACKOFF_MIN).await;
            }
        }
    }
}

/// A fatal error means the desktop no longer knows this device (revoked,
/// wrong token): keeping the pairing would just loop on refusals.
fn forget(app: &AppHandle, remote: &Remote, message: String) {
    store::forget_pairing(&remote.pairing_path());
    remote.set_state(app, "unpaired", None, Some(message));
}

async fn serve(app: &AppHandle, remote: &Remote, mut session: Session) -> Exit {
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<ClientMsg>();
    remote.lock().out = Some(out_tx);

    // read_frame is not cancel-safe, so it lives in its own task and the
    // select below only touches the channel.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Result<ServerMsg, String>>();
    let mut recv = session.recv;
    let reader = tokio::spawn(async move {
        loop {
            let item = flowcode_remote_proto::read_frame::<_, ServerMsg>(&mut recv).await.map_err(|e| e.to_string());
            let stop = item.is_err();
            if in_tx.send(item).is_err() || stop {
                break;
            }
        }
    });

    let exit = async {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        let mut last_rx = Instant::now();
        if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::List).await {
            return Exit::Lost(e.to_string());
        }
        loop {
            tokio::select! {
                incoming = in_rx.recv() => match incoming {
                    Some(Ok(msg)) => {
                        last_rx = Instant::now();
                        let _ = app.emit("remote://msg", &msg);
                        if let ServerMsg::Error { message, fatal: true, .. } = msg {
                            return Exit::Fatal(message);
                        }
                    }
                    Some(Err(e)) => return Exit::Lost(e),
                    None => return Exit::Lost("connection closed".into()),
                },
                outgoing = out_rx.recv() => {
                    let Some(msg) = outgoing else { return Exit::Lost("stopped".into()) };
                    if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &msg).await {
                        return Exit::Lost(e.to_string());
                    }
                }
                _ = ping.tick() => {
                    if last_rx.elapsed() > DEAD_AFTER {
                        return Exit::Lost("the desktop stopped answering".into());
                    }
                    if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::Ping).await {
                        return Exit::Lost(e.to_string());
                    }
                }
            }
        }
    }
    .await;

    remote.lock().out = None;
    reader.abort();
    session.conn.close(0u32.into(), b"bye");
    exit
}

#[tauri::command]
fn platform() -> &'static str {
    if cfg!(mobile) {
        "mobile"
    } else {
        "desktop"
    }
}

// `(async)`: off the main thread, which the Android Keystore call needs free.
#[tauri::command(async)]
fn pairing_state(remote: State<'_, Arc<Remote>>) -> PairingState {
    let pairing = store::load_pairing(&remote.pairing_path(), &remote.codec);
    PairingState { paired: pairing.is_some(), host_name: pairing.map(|p| p.host_name) }
}

/// A `flowcode://pair` link the OS opened the app with, if any (taken once).
#[tauri::command]
fn take_pending_link(remote: State<'_, Arc<Remote>>) -> Option<String> {
    remote.lock().pending_link.take()
}

#[tauri::command]
async fn pair(app: AppHandle, remote: State<'_, Arc<Remote>>, ticket: String, device_name: String) -> Result<(), String> {
    let remote = Arc::clone(&remote);
    let parsed = PairingTicket::parse(&ticket).map_err(|e| e.to_string())?;
    let device_name = device_name.trim().to_string();
    if device_name.is_empty() {
        return Err("device name is empty".into());
    }
    remote.stop_task();
    remote.set_state(&app, "connecting", Some(parsed.host.clone()), None);
    let result = async {
        let endpoint = remote.endpoint().await.map_err(LinkError::Transient)?;
        link::handshake(&endpoint, &parsed.node, ClientMsg::Pair { code: parsed.code.clone(), device_name }).await
    }
    .await;
    let session = match result {
        Ok(s) => s,
        Err(e) => {
            remote.set_state(&app, "unpaired", None, None);
            return Err(e.message().to_string());
        }
    };
    let Some(token) = session.token.clone() else {
        remote.set_state(&app, "unpaired", None, None);
        return Err("the desktop did not issue a token".into());
    };
    let pairing = Pairing {
        node: parsed.node,
        token,
        host_name: session.host_name.clone(),
        device_name: session.device_name.clone(),
    };
    if let Err(e) = store::save_pairing(&remote.pairing_path(), &pairing, &remote.codec) {
        remote.set_state(&app, "unpaired", None, None);
        return Err(e);
    }
    remote.start_task(&app, Some(session));
    Ok(())
}

/// Starts the reconnect loop for a stored pairing; harmless when it is
/// already running (it just republishes the state, e.g. after a reload).
// `(async)`: off the main thread, which the Android Keystore call needs free.
#[tauri::command(async)]
fn connect(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    let remote = Arc::clone(&remote);
    if store::load_pairing(&remote.pairing_path(), &remote.codec).is_none() {
        remote.set_state(&app, "unpaired", None, None);
        return;
    }
    let (running, state) = {
        let inner = remote.lock();
        (inner.task.is_some(), inner.state.clone())
    };
    if running {
        let _ = app.emit("remote://state", state);
        return;
    }
    remote.start_task(&app, None);
}

#[tauri::command]
fn send(remote: State<'_, Arc<Remote>>, msg: serde_json::Value) -> Result<(), String> {
    let msg: ClientMsg = serde_json::from_value(msg).map_err(|e| format!("invalid message: {e}"))?;
    // Handshake messages are the Rust side's business only.
    if matches!(msg, ClientMsg::Pair { .. } | ClientMsg::Auth { .. }) {
        return Err("handshake messages cannot be sent".into());
    }
    let out = remote.lock().out.clone();
    out.ok_or_else(|| "not connected".to_string())?.send(msg).map_err(|_| "not connected".to_string())
}

/// "Retry now": ends the backoff sleep. Ignored unless the loop is waiting, so
/// a stray permit cannot skip a later backoff.
#[tauri::command]
fn retry_now(remote: State<'_, Arc<Remote>>) {
    if remote.lock().state.phase == Some("waiting") {
        remote.retry.notify_one();
    }
}

#[tauri::command]
fn unpair(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    remote.stop_task();
    store::forget_pairing(&remote.pairing_path());
    remote.set_state(&app, "unpaired", None, None);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(secure::init());
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_biometric::init()).plugin(tauri_plugin_deep_link::init());
    }
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let remote = Arc::new(Remote {
                dir,
                codec: app.state::<SecureStore>().inner().clone(),
                endpoint: OnceCell::new(),
                inner: Mutex::new(Inner { state: StateEvent { status: "connecting", ..Default::default() }, ..Default::default() }),
                retry: Notify::new(),
            });
            app.manage(Arc::clone(&remote));
            #[cfg(mobile)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Kept for the webview to pick up (it may not be listening
                // yet on a cold start) and also pushed live.
                let on_link = {
                    let (remote, handle) = (Arc::clone(&remote), app.handle().clone());
                    move |urls: Vec<String>| {
                        if let Some(url) = urls.into_iter().find(|u| u.starts_with("flowcode://")) {
                            remote.lock().pending_link = Some(url.clone());
                            let _ = handle.emit("remote://deeplink", url);
                        }
                    }
                };
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    on_link(urls.iter().map(|u| u.to_string()).collect());
                }
                app.deep_link().on_open_url(move |event| on_link(event.urls().iter().map(|u| u.to_string()).collect()));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![platform, pairing_state, take_pending_link, pair, connect, send, retry_now, unpair])
        .run(tauri::generate_context!())
        .expect("error while running Flowcode Mobile");
}
