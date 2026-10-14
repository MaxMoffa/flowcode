//! Flowcode Mobile: the phone end of the remote protocol. The Rust side owns
//! the iroh connection (so it survives webview reloads and needs no
//! WebSocket/CORS tricks); the webview gets every server message as an event
//! and sends client messages through `send`.

mod background;
pub mod connlog;
pub mod link;
mod secure;
pub mod store;

use background::Background;
use flowcode_remote_proto::{ClientMsg, FrameError, PairingTicket, ServerMsg};
use iroh::Endpoint;
use connlog::ConnLog;
use link::{LinkError, Session};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use secure::SecureStore;
use store::Pairing;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Notify};

const PING_EVERY: Duration = Duration::from_secs(20);
/// Pongs answer our pings, so 60 s of total silence means the link is dead
/// even though QUIC has not noticed yet. (The QUIC idle timeout is 90 s, see
/// `link::IDLE_TIMEOUT`, so this timer always fires first.)
const DEAD_AFTER: Duration = Duration::from_secs(60);
/// When the app comes back to the foreground the link may be a zombie (the OS
/// froze the process, or Wi-Fi/mobile data switched meanwhile): a ping must be
/// answered within this long or the link is dropped and redialed at once.
/// (Right after a network switch the first round trip can take several
/// seconds, so a shorter fuse falsely killed healthy links.)
const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
/// A link that dies sooner than this after coming online counts as a failed
/// attempt for the backoff (a desktop that accepts and immediately hangs up
/// must not be redialed once a second forever).
const STABLE_AFTER: Duration = Duration::from_secs(10);
/// After this many consecutive failed dials the iroh endpoint is rebuilt:
/// its sockets may be bound to a network that no longer exists.
const REBUILD_ENDPOINT_EVERY: u32 = 4;
/// A deep link that was not picked up by the pairing screen goes stale.
const PENDING_LINK_TTL: Duration = Duration::from_secs(120);

/// Reconnect delay after `failures` consecutive failures (>= 1): 1, 2, 4, 8 s
/// and then 8 s. Kept low on purpose: someone is looking at the phone. With
/// the app hidden and nothing keeping it alive (`idle`) nobody is, so it
/// goes on to 16 and then 30 s to spare the battery.
fn backoff_delay(failures: u32, idle: bool) -> Duration {
    let exp = failures.saturating_sub(1).min(if idle { 5 } else { 3 });
    Duration::from_secs((1u64 << exp).min(if idle { 30 } else { 8 }))
}

/// Failure count after a link that was online for `lived` ended: a link that
/// held is a fresh start; one that died at once keeps counting.
fn failures_after_link(failures: u32, lived: Duration) -> u32 {
    if lived >= STABLE_AFTER {
        1
    } else {
        failures + 1
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
enum Status {
    #[default]
    Unpaired,
    Connecting,
    Online,
    Offline,
}

/// Where a reconnect attempt is.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
enum Phase {
    /// Backoff sleep.
    Waiting,
    Dialing,
    Handshake,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    host_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<Phase>,
    /// Consecutive failures since the link was last online.
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u32>,
    /// Unix ms when the next attempt starts; only while waiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_at: Option<u64>,
}

impl StateEvent {
    fn new(status: Status) -> Self {
        StateEvent { status, ..Default::default() }
    }

    fn host(mut self, host_name: Option<String>) -> Self {
        self.host_name = host_name;
        self
    }

    fn error(mut self, error: Option<String>) -> Self {
        self.error = error;
        self
    }

    fn phase(mut self, phase: Phase, attempt: u32, retry_at: Option<u64>) -> Self {
        self.phase = Some(phase);
        self.attempt = Some(attempt);
        self.retry_at = retry_at;
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingState {
    paired: bool,
    host_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TicketInfo {
    host_name: String,
    /// Fingerprint of the desktop's node id, to confirm before pairing.
    fingerprint: String,
}

#[derive(Default)]
struct Inner {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Bumped on every (re)start so a finishing task knows whether it is
    /// still the current one.
    generation: u64,
    out: Option<mpsc::Sender<ClientMsg>>,
    state: StateEvent,
    /// A `flowcode://pair` link and when it arrived; see `PENDING_LINK_TTL`.
    pending_link: Option<(String, Instant)>,
}

struct Remote {
    dir: PathBuf,
    /// Seals the key and pairing files (Android Keystore; pass-through elsewhere).
    /// Its calls block briefly, which is fine on the async runtime workers.
    codec: SecureStore,
    /// Created lazily and rebuilt after repeated failures (`reset_endpoint`).
    endpoint: tokio::sync::Mutex<Option<Endpoint>>,
    inner: Mutex<Inner>,
    /// Cuts the backoff sleep short (`retry_now`). Only `notify_waiters` is
    /// used, so a call with nobody waiting leaves no permit behind to skip a
    /// later backoff.
    retry: Notify,
    /// The app came back to the foreground: probe an online link. Signalled
    /// with `notify_one` so a resume that lands while `serve` is busy writing
    /// is kept (the future is recreated every iteration of its select).
    resume: Notify,
    /// A `pair` is running; a second one is refused.
    pairing: AtomicBool,
    /// Wakes a running `pair` to abandon the wait for the desktop's confirmation.
    pair_cancel: Notify,
    /// The last events of the connection, for Settings > diagnostics.
    log: ConnLog,
    /// Foreground service + notifications (Android only).
    background: Background,
    /// "Stay connected in the background", kept in memory and in `background.json`.
    bg: Mutex<background::Settings>,
    /// Title and text of the service's ongoing notification, as the webview
    /// worded them (it knows the language and the desktop's name).
    bg_texts: Mutex<(String, String)>,
    /// The webview is visible. Starts true: the app launches in the foreground.
    visible: AtomicBool,
}

/// Messages waiting for the link; `send` refuses more instead of growing
/// without bound while the link is stuck.
const OUT_QUEUE: usize = 256;

/// What the reader task hands to `serve`.
enum Inbound {
    Msg(ServerMsg),
    /// A frame that arrived whole but is not a message we know (a newer
    /// desktop): skipped, the link goes on.
    Skipped(String),
    /// I/O or framing error: the stream cannot be trusted any more.
    Failed(String),
}

fn classify_frame(frame: Result<ServerMsg, FrameError>) -> Inbound {
    match frame {
        Ok(msg) => Inbound::Msg(msg),
        Err(FrameError::Json(e)) => Inbound::Skipped(e.to_string()),
        Err(e) => Inbound::Failed(e.to_string()),
    }
}

/// Clears `Remote::pairing` however `pair` ends.
struct PairGuard<'a>(&'a AtomicBool);

impl Drop for PairGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Dropped when `serve` ends or its task is aborted (`stop_task`): without it
/// an aborted loop would leave the reader task and the QUIC connection alive.
struct ServeGuard {
    reader: tokio::task::AbortHandle,
    conn: iroh::endpoint::Connection,
}

impl Drop for ServeGuard {
    fn drop(&mut self) {
        self.reader.abort();
        self.conn.close(0u32.into(), b"bye");
    }
}

impl Remote {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn background_path(&self) -> PathBuf {
        self.dir.join("background.json")
    }

    fn bg_settings(&self) -> background::Settings {
        *self.bg.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Tells the Kotlin side whether to keep the app alive in the background:
    /// only when the mode is on and a desktop is paired.
    fn rearm_with(&self, paired: bool) {
        let settings = self.bg_settings();
        let (title, text) = self.bg_texts.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Err(e) = self.background.set_armed(settings.enabled && paired, &title, &text, settings.cap_minutes) {
            self.log.push(format!("background service not armed: {e}"));
        }
    }

    /// Like `rearm_with`, reading the pairing (a Keystore call: not on the main thread).
    fn rearm(&self) {
        self.rearm_with(store::load_pairing(&self.pairing_path(), &self.codec).is_paired());
    }

    /// Queues a message on the live link, if there is one.
    fn queue(&self, msg: ClientMsg) {
        let out = self.lock().out.clone();
        if let Some(out) = out {
            let _ = out.try_send(msg);
        }
    }

    /// A desktop notification arrived: with the app out of sight and the mode
    /// on, show it as an Android notification (the webview shows it otherwise).
    fn on_notify(&self, title: &str, body: &str, tab_id: Option<&str>) {
        let post = !self.visible.load(Ordering::SeqCst) && self.bg_settings().enabled;
        self.log.push(format!("notification from the desktop ({})", if post { "posted" } else { "app visible or mode off" }));
        if post {
            if let Err(e) = self.background.notify(title, body, tab_id) {
                self.log.push(format!("notification failed: {e}"));
            }
        }
    }

    /// Hidden with the background mode off: see `backoff_delay`.
    fn idle(&self) -> bool {
        !self.visible.load(Ordering::SeqCst) && !self.bg_settings().enabled
    }

    fn key_path(&self) -> PathBuf {
        self.dir.join("device.key")
    }

    fn pairing_path(&self) -> PathBuf {
        self.dir.join("pairing.json")
    }

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
        if let Some(old) = self.endpoint.lock().await.take() {
            // Closed before the next bind: two endpoints with one key alive at
            // once would fight over the relay's single slot for this node id.
            let _ = tokio::time::timeout(Duration::from_secs(2), old.close()).await;
        }
    }

    /// Tells iroh the network may have changed (Android does not expose that to
    /// native code), so it re-probes its paths instead of trusting stale ones.
    async fn network_change(&self) {
        let endpoint = self.endpoint.lock().await.clone();
        if let Some(endpoint) = endpoint {
            endpoint.network_change().await;
        }
    }

    fn emit(&self, app: &AppHandle, event: StateEvent) {
        self.lock().state = event.clone();
        let _ = app.emit("remote://state", event);
    }

    fn set_state(&self, app: &AppHandle, status: Status, host_name: Option<String>, error: Option<String>) {
        self.emit(app, StateEvent::new(status).host(host_name).error(error));
    }

    /// Backoff sleep that `retry_now` can end early.
    async fn wait(&self, app: &AppHandle, host: Option<String>, error: String, attempt: u32, delay: Duration) {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64) + delay.as_millis() as u64;
        // Registered before the state is published: a `retry_now` the UI sends
        // on seeing "waiting" can then never slip in between.
        let notified = self.retry.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        self.log.push(format!("attempt failed ({error}); retry in {} s (failure {attempt})", delay.as_secs()));
        self.emit(app, StateEvent::new(Status::Offline).host(host).error(Some(error)).phase(Phase::Waiting, attempt, Some(at)));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = &mut notified => {}
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

    /// Starts the loop unless one is running. Checked and started under one
    /// lock: `connect` and `app_resumed` arrive together at launch, and the
    /// second must not abort the first one's dial in progress.
    fn ensure_task(self: &Arc<Self>, app: &AppHandle) {
        self.spawn_task(app, None, true);
    }

    fn start_task(self: &Arc<Self>, app: &AppHandle, initial: Option<Session>) {
        self.spawn_task(app, initial, false);
    }

    fn spawn_task(self: &Arc<Self>, app: &AppHandle, initial: Option<Session>, only_if_idle: bool) {
        let mut inner = self.lock();
        if only_if_idle && inner.task.is_some() {
            return;
        }
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

/// One dial + handshake with the stored desktop.
async fn connect_once(app: &AppHandle, remote: &Remote, pairing: &Pairing, failures: u32) -> Result<Session, LinkError> {
    let host = Some(pairing.host_name.clone());
    // Repeated failures may mean the endpoint is stuck on a dead network
    // (Wi-Fi <-> mobile switch, Android suspending the app): start over with a
    // fresh one. Not while a `pair` holds the current endpoint.
    if failures > 0 && failures.is_multiple_of(REBUILD_ENDPOINT_EVERY) && !remote.pairing.load(Ordering::SeqCst) {
        remote.log.push(format!("endpoint rebuilt after {failures} failed attempts"));
        remote.reset_endpoint().await;
    }
    remote.emit(app, StateEvent::new(Status::Connecting).host(host.clone()).phase(Phase::Dialing, failures, None));
    let endpoint = remote.endpoint().await.map_err(LinkError::Transient)?;
    // Cheap and harmless when nothing changed; cures stale paths when it did.
    if failures > 0 {
        remote.log.push("network change signalled to iroh before dialing");
        endpoint.network_change().await;
    }
    link::handshake_with(
        &endpoint,
        &pairing.node,
        ClientMsg::Auth { token: pairing.token.clone() },
        || remote.emit(app, StateEvent::new(Status::Connecting).host(host.clone()).phase(Phase::Handshake, failures, None)),
        |line| remote.log.push(line),
    )
    .await
}

/// Connects, serves, and reconnects until the pairing is gone or the task is
/// aborted. `initial` is a session `pair` already established.
async fn reconnect_loop(app: &AppHandle, remote: &Arc<Remote>, mut initial: Option<Session>) {
    let mut failures: u32 = 0;
    remote.log.push("connection loop started");
    loop {
        let pairing = match store::load_pairing(&remote.pairing_path(), &remote.codec) {
            store::PairingLoad::Found(p) => p,
            store::PairingLoad::Missing => {
                remote.set_state(app, Status::Unpaired, None, None);
                return;
            }
            // Still paired, the Keystore just did not answer: try again later.
            store::PairingLoad::Unreadable(message) => {
                failures += 1;
                remote.wait(app, None, message, failures, backoff_delay(failures, remote.idle())).await;
                continue;
            }
        };
        let session = match initial.take() {
            Some(s) => s,
            None => match connect_once(app, remote, &pairing, failures).await {
                Ok(s) => s,
                Err(LinkError::Fatal(message)) => {
                    remote.log.push(format!("refused for good, pairing forgotten: {message}"));
                    forget(app, remote, message);
                    return;
                }
                Err(LinkError::Transient(message)) => {
                    failures += 1;
                    remote.wait(app, Some(pairing.host_name), message, failures, backoff_delay(failures, remote.idle())).await;
                    continue;
                }
            },
        };
        let host_name = session.host_name.clone();
        let _ = app.emit(
            "remote://msg",
            ServerMsg::Ready { device_name: session.device_name.clone(), host_name: host_name.clone() },
        );
        remote.set_state(app, Status::Online, Some(host_name.clone()), None);
        remote.log.push(format!("online with {host_name}"));
        let online_since = Instant::now();
        match serve(app, remote, session).await {
            Exit::Fatal(message) => {
                remote.log.push(format!("desktop sent a fatal error, pairing forgotten: {message}"));
                forget(app, remote, message);
                return;
            }
            Exit::Lost(message) => {
                let lived = online_since.elapsed();
                remote.log.push(format!("link closed after {} s: {message}", lived.as_secs()));
                // A link that held is a fresh start; one that died at once keeps
                // counting, so the backoff grows and the endpoint gets rebuilt.
                failures = failures_after_link(failures, lived);
                remote.wait(app, Some(host_name), message, failures, backoff_delay(failures, remote.idle())).await;
            }
        }
    }
}

/// A fatal error means the desktop no longer knows this device (revoked,
/// wrong token): keeping the pairing would just loop on refusals.
fn forget(app: &AppHandle, remote: &Remote, message: String) {
    store::forget_pairing(&remote.pairing_path());
    remote.rearm_with(false);
    remote.set_state(app, Status::Unpaired, None, Some(message));
}

async fn serve(app: &AppHandle, remote: &Remote, mut session: Session) -> Exit {
    let (out_tx, mut out_rx) = mpsc::channel::<ClientMsg>(OUT_QUEUE);
    remote.lock().out = Some(out_tx);

    // read_frame is not cancel-safe, so it lives in its own task and the
    // select below only touches the channel.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Inbound>();
    let mut recv = session.recv;
    let reader = tokio::spawn(async move {
        loop {
            let item = classify_frame(flowcode_remote_proto::read_frame::<_, ServerMsg>(&mut recv).await);
            let stop = matches!(item, Inbound::Failed(_));
            if in_tx.send(item).is_err() || stop {
                break;
            }
        }
    });
    // Also covers the loop being aborted mid-`serve`.
    let _guard = ServeGuard { reader: reader.abort_handle(), conn: session.conn.clone() };

    let exit = async {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        let mut last_rx = Instant::now();
        // Set when the app resumes: the link must prove itself by then.
        let mut probe_until: Option<tokio::time::Instant> = None;
        if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::List).await {
            return Exit::Lost(e.to_string());
        }
        // Back on a link while hidden: the desktop starts out sending everything.
        if !remote.visible.load(Ordering::SeqCst) && remote.bg_settings().enabled {
            if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::Background { on: true }).await {
                return Exit::Lost(e.to_string());
            }
        }
        let mut warned_unknown = false;
        loop {
            let probe = async {
                match probe_until {
                    Some(t) => tokio::time::sleep_until(t).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                incoming = in_rx.recv() => match incoming {
                    Some(Inbound::Msg(msg)) => {
                        last_rx = Instant::now();
                        probe_until = None;
                        let _ = app.emit("remote://msg", &msg);
                        if let ServerMsg::Notify { title, body, tab_id } = &msg {
                            remote.on_notify(title, body, tab_id.as_deref());
                        }
                        if let ServerMsg::Error { message, fatal: true, .. } = msg {
                            return Exit::Fatal(message);
                        }
                    }
                    Some(Inbound::Skipped(e)) => {
                        // Still proof that the link is alive.
                        last_rx = Instant::now();
                        probe_until = None;
                        if !warned_unknown {
                            warned_unknown = true;
                            remote.log.push(format!("skipped a message this version does not understand: {e}"));
                        }
                    }
                    Some(Inbound::Failed(e)) => return Exit::Lost(e),
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
                _ = remote.resume.notified() => {
                    remote.log.push("app resumed: probing the link");
                    if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::Ping).await {
                        return Exit::Lost(e.to_string());
                    }
                    probe_until.get_or_insert_with(|| tokio::time::Instant::now() + PROBE_TIMEOUT);
                }
                _ = probe => return Exit::Lost("the desktop did not answer after resuming".into()),
            }
        }
    }
    .await;

    remote.lock().out = None;
    // Before the guard closes the connection ourselves: what QUIC saw end it.
    match session.conn.close_reason() {
        Some(reason) => remote.log.push(format!("QUIC connection closed: {reason}")),
        None => remote.log.push("QUIC connection still open when the link was given up"),
    }
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
    match store::load_pairing(&remote.pairing_path(), &remote.codec) {
        store::PairingLoad::Found(p) => PairingState { paired: true, host_name: Some(p.host_name) },
        // Paired, only unreadable for now (the host name is unknown).
        store::PairingLoad::Unreadable(_) => PairingState { paired: true, host_name: None },
        store::PairingLoad::Missing => PairingState { paired: false, host_name: None },
    }
}

/// A `flowcode://pair` link the OS opened the app with, if any. Taken once,
/// dropped after `PENDING_LINK_TTL`, and never offered while a pairing exists:
/// a link only ever fills in the pairing screen, it never pairs by itself.
// `(async)`: reads the pairing, a Keystore call.
#[tauri::command(async)]
fn take_pending_link(remote: State<'_, Arc<Remote>>) -> Option<String> {
    let taken = remote.lock().pending_link.take();
    let (url, at) = taken?;
    if at.elapsed() > PENDING_LINK_TTL || store::load_pairing(&remote.pairing_path(), &remote.codec).is_paired() {
        return None;
    }
    Some(url)
}

/// What a pairing link points at, to ask "connect to <host>?" before pairing.
#[tauri::command]
fn inspect_ticket(ticket: String) -> Result<TicketInfo, String> {
    let (host_name, fingerprint) = link::inspect_ticket(&ticket)?;
    Ok(TicketInfo { host_name, fingerprint })
}

/// Fingerprint of this phone's own node id; the desktop shows the same one in
/// its confirm dialog, so the user can compare.
#[tauri::command]
async fn my_fingerprint(remote: State<'_, Arc<Remote>>) -> Result<String, String> {
    let endpoint = remote.endpoint().await?;
    Ok(flowcode_remote_proto::node_fingerprint(&endpoint.id().to_string()))
}

#[tauri::command]
async fn pair(app: AppHandle, remote: State<'_, Arc<Remote>>, ticket: String, device_name: String) -> Result<(), String> {
    let remote = Arc::clone(&remote);
    // A second pair while one waits for the desktop's confirmation is refused
    // before it can touch any state.
    if remote.pairing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("a pairing is already in progress".into());
    }
    let _guard = PairGuard(&remote.pairing);
    let parsed = PairingTicket::parse(&ticket).map_err(|e| e.to_string())?;
    let device_name = device_name.trim().to_string();
    if device_name.is_empty() {
        return Err("device name is empty".into());
    }
    // The running connection (if any) stays up until the new pairing exists.
    let running = remote.lock().task.is_some();
    if !running {
        remote.set_state(&app, Status::Connecting, Some(parsed.host.clone()), None);
    }
    let result = tokio::select! {
        r = async {
            let endpoint = remote.endpoint().await.map_err(LinkError::Transient)?;
            remote.log.push("pairing started");
            link::handshake_with(&endpoint, &parsed.node, ClientMsg::Pair { code: parsed.code.clone(), device_name }, || {}, |line| remote.log.push(line)).await
        } => Some(r),
        _ = remote.pair_cancel.notified() => None,
    };
    let failed = |message: String| {
        // Without a running loop the state still says "connecting": go back
        // to the stored pairing's reconnect loop, or to unpaired if none.
        if !running {
            if store::load_pairing(&remote.pairing_path(), &remote.codec).is_paired() {
                remote.ensure_task(&app);
            } else {
                remote.set_state(&app, Status::Unpaired, None, None);
            }
        }
        Err(message)
    };
    let session = match result {
        Some(Ok(s)) => s,
        Some(Err(e)) => return failed(e.message().to_string()),
        None => {
            remote.log.push("pairing cancelled by the user");
            return failed("cancelled".into());
        }
    };
    let Some(token) = session.token.clone() else {
        return failed("the desktop did not issue a token".into());
    };
    let pairing = Pairing {
        node: parsed.node,
        token,
        host_name: session.host_name.clone(),
        device_name: session.device_name.clone(),
    };
    if let Err(e) = store::save_pairing(&remote.pairing_path(), &pairing, &remote.codec) {
        return failed(e);
    }
    remote.start_task(&app, Some(session));
    remote.rearm_with(true);
    Ok(())
}

/// "Annulla" on the waiting page: stops a `pair` that waits for the desktop.
#[tauri::command]
fn cancel_pair(remote: State<'_, Arc<Remote>>) {
    remote.pair_cancel.notify_waiters();
}

/// Starts the reconnect loop for a stored pairing; harmless when it is
/// already running (it just republishes the state, e.g. after a reload).
// `(async)`: off the main thread, which the Android Keystore call needs free.
#[tauri::command(async)]
fn connect(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    let remote = Arc::clone(&remote);
    if !store::load_pairing(&remote.pairing_path(), &remote.codec).is_paired() {
        remote.set_state(&app, Status::Unpaired, None, None);
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
    remote.ensure_task(&app);
}

#[tauri::command]
fn send(remote: State<'_, Arc<Remote>>, msg: serde_json::Value) -> Result<(), String> {
    let msg: ClientMsg = serde_json::from_value(msg).map_err(|e| format!("invalid message: {e}"))?;
    // Handshake messages are the Rust side's business only.
    if matches!(msg, ClientMsg::Pair { .. } | ClientMsg::Auth { .. }) {
        return Err("handshake messages cannot be sent".into());
    }
    let out = remote.lock().out.clone();
    out.ok_or_else(|| "not connected".to_string())?.try_send(msg).map_err(|e| match e {
        mpsc::error::TrySendError::Full(_) => "busy".to_string(),
        mpsc::error::TrySendError::Closed(_) => "not connected".to_string(),
    })
}

/// "Retry now": ends the backoff sleep. Ignored unless the loop is waiting.
#[tauri::command]
fn retry_now(remote: State<'_, Arc<Remote>>) {
    if remote.lock().state.phase == Some(Phase::Waiting) {
        remote.log.push("retry requested by the user");
        remote.retry.notify_waiters();
    }
}

/// The app is visible again (call on `visibilitychange` -> visible). The
/// network may have changed while it was in the background and Android gives
/// native code no notification, so: tell iroh, redial at once if the link is in
/// backoff, probe it if it looks online, restart the loop if it is not running.
#[tauri::command]
async fn app_resumed(app: AppHandle, remote: State<'_, Arc<Remote>>) -> Result<(), String> {
    let remote = Arc::clone(&remote);
    remote.log.push("app resumed");
    // First, so it reaches the desktop before the webview opens its streams.
    remote.visible.store(true, Ordering::SeqCst);
    if remote.bg_settings().enabled {
        remote.queue(ClientMsg::Background { on: false });
    }
    remote.network_change().await;
    let (running, phase) = {
        let inner = remote.lock();
        (inner.task.is_some(), inner.state.phase)
    };
    if !running {
        if store::load_pairing(&remote.pairing_path(), &remote.codec).is_paired() && !remote.pairing.load(Ordering::SeqCst) {
            remote.ensure_task(&app);
        }
    } else if phase == Some(Phase::Waiting) {
        remote.retry.notify_waiters();
    } else {
        remote.resume.notify_one();
    }
    Ok(())
}

/// The app went out of sight (call on `visibilitychange` -> hidden). With the
/// background mode on, the desktop is asked to send notifications only.
#[tauri::command]
fn app_hidden(remote: State<'_, Arc<Remote>>) {
    remote.log.push("app hidden");
    remote.visible.store(false, Ordering::SeqCst);
    if remote.bg_settings().enabled {
        remote.queue(ClientMsg::Background { on: true });
    }
}

/// The webview has been hidden for a while (it calls this ~30 s after
/// `app_hidden`). With the background mode off nobody is listening, so the
/// loop stops pinging and redialing; `app_resumed` restarts it. With the mode
/// on the service keeps the link, so nothing happens.
#[tauri::command]
fn suspend_link(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    if remote.visible.load(Ordering::SeqCst) || remote.bg_settings().enabled || remote.pairing.load(Ordering::SeqCst) {
        return;
    }
    let (running, host_name, status) = {
        let inner = remote.lock();
        (inner.task.is_some(), inner.state.host_name.clone(), inner.state.status)
    };
    if !running || status == Status::Unpaired {
        return;
    }
    remote.stop_task();
    remote.log.push("suspended in background");
    remote.set_state(&app, Status::Offline, host_name, None);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundState {
    enabled: bool,
    cap_minutes: u32,
}

#[tauri::command]
fn background_settings(remote: State<'_, Arc<Remote>>) -> BackgroundState {
    let s = remote.bg_settings();
    BackgroundState { enabled: s.enabled, cap_minutes: s.cap_minutes }
}

// `(async)`: arming reads the pairing, a Keystore call.
#[tauri::command(async)]
fn set_background_settings(remote: State<'_, Arc<Remote>>, enabled: bool, cap_minutes: u32) -> Result<(), String> {
    let settings = background::Settings { enabled, cap_minutes };
    background::save(&remote.background_path(), &settings)?;
    *remote.bg.lock().unwrap_or_else(|e| e.into_inner()) = settings;
    remote.log.push(format!("background mode {} (cap {} min)", if enabled { "on" } else { "off" }, cap_minutes));
    remote.rearm();
    Ok(())
}

/// The wording of the service's ongoing notification (the webview knows the
/// language and the desktop's name); re-arms with it.
// `(async)`: arming reads the pairing, a Keystore call.
#[tauri::command(async)]
fn background_texts(remote: State<'_, Arc<Remote>>, title: String, text: String) {
    *remote.bg_texts.lock().unwrap_or_else(|e| e.into_inner()) = (title, text);
    remote.rearm();
}

// `(async)`: the plugin calls block, the permission one until the user answers.
#[tauri::command(async)]
fn notification_permission(remote: State<'_, Arc<Remote>>) -> Result<bool, String> {
    remote.background.notification_permission()
}

#[tauri::command(async)]
fn request_notification_permission(remote: State<'_, Arc<Remote>>) -> Result<bool, String> {
    remote.background.request_notification_permission()
}

/// The tab of the notification the app was opened from, once.
#[tauri::command(async)]
fn take_pending_tab(remote: State<'_, Arc<Remote>>) -> Option<String> {
    remote.background.take_pending_tab().ok().flatten()
}

/// The recent connection events, oldest first (Settings > diagnostics).
#[tauri::command]
fn connection_log(remote: State<'_, Arc<Remote>>) -> Vec<connlog::Entry> {
    remote.log.snapshot()
}

#[tauri::command]
fn unpair(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    // A `pair` in flight must not save a pairing after this. The file goes
    // first so a loop that is still running cannot find it again.
    remote.pair_cancel.notify_waiters();
    store::forget_pairing(&remote.pairing_path());
    remote.stop_task();
    remote.rearm_with(false);
    remote.set_state(&app, Status::Unpaired, None, None);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(secure::init()).plugin(background::init());
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_biometric::init()).plugin(tauri_plugin_deep_link::init()).plugin(tauri_plugin_haptics::init());
    }
    builder
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let bg_path = dir.join("background.json");
            let remote = Arc::new(Remote {
                dir,
                codec: app.state::<SecureStore>().inner().clone(),
                endpoint: tokio::sync::Mutex::new(None),
                inner: Mutex::new(Inner { state: StateEvent::new(Status::Connecting), ..Default::default() }),
                retry: Notify::new(),
                resume: Notify::new(),
                pairing: AtomicBool::new(false),
                pair_cancel: Notify::new(),
                log: ConnLog::default(),
                background: app.state::<Background>().inner().clone(),
                bg: Mutex::new(background::load(&bg_path)),
                bg_texts: Mutex::new((String::new(), String::new())),
                visible: AtomicBool::new(true),
            });
            app.manage(Arc::clone(&remote));
            #[cfg(mobile)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Kept for the webview to pick up (it may not be listening
                // yet on a cold start) and also pushed live. A link is only
                // ever a suggestion for the pairing screen, and is dropped
                // while a pairing exists. The pairing check (Keystore) runs
                // on its own thread, off the one that delivers the link.
                let on_link = {
                    let (remote, handle) = (Arc::clone(&remote), app.handle().clone());
                    move |urls: Vec<String>| {
                        let Some(url) = urls.into_iter().find(|u| u.starts_with("flowcode://")) else { return };
                        let (remote, handle) = (Arc::clone(&remote), handle.clone());
                        std::thread::spawn(move || {
                            if store::load_pairing(&remote.pairing_path(), &remote.codec).is_paired() {
                                return;
                            }
                            remote.lock().pending_link = Some((url.clone(), Instant::now()));
                            let _ = handle.emit("remote://deeplink", url);
                        });
                    }
                };
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    on_link(urls.iter().map(|u| u.to_string()).collect());
                }
                app.deep_link().on_open_url(move |event| on_link(event.urls().iter().map(|u| u.to_string()).collect()));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            platform,
            pairing_state,
            take_pending_link,
            inspect_ticket,
            my_fingerprint,
            pair,
            cancel_pair,
            connect,
            send,
            retry_now,
            app_resumed,
            connection_log,
            app_hidden,
            suspend_link,
            background_settings,
            set_background_settings,
            background_texts,
            notification_permission,
            request_notification_permission,
            take_pending_tab,
            unpair
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flowcode Mobile");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_up_to_eight_seconds() {
        let secs: Vec<u64> = (0..7).map(|f| backoff_delay(f, false).as_secs()).collect();
        assert_eq!(secs, [1, 1, 2, 4, 8, 8, 8]);
        let idle: Vec<u64> = (0..8).map(|f| backoff_delay(f, true).as_secs()).collect();
        assert_eq!(idle, [1, 1, 2, 4, 8, 16, 30, 30]);
    }

    #[test]
    fn a_link_that_dies_at_once_keeps_the_backoff_growing() {
        assert_eq!(failures_after_link(3, Duration::from_secs(2)), 4);
        assert_eq!(failures_after_link(3, Duration::from_secs(600)), 1);
    }

    #[test]
    fn an_undecodable_frame_is_skipped_but_io_errors_are_fatal() {
        let bad = serde_json::from_str::<ServerMsg>(r#"{"t":"from-the-future"}"#).unwrap_err();
        assert!(matches!(classify_frame(Err(FrameError::Json(bad))), Inbound::Skipped(_)));
        assert!(matches!(classify_frame(Err(FrameError::Closed)), Inbound::Failed(_)));
        assert!(matches!(classify_frame(Err(FrameError::TooLarge(1 << 30))), Inbound::Failed(_)));
        assert!(matches!(classify_frame(Ok(ServerMsg::Pong)), Inbound::Msg(ServerMsg::Pong)));
    }

    #[test]
    fn state_serializes_lowercase() {
        let json = serde_json::to_value(StateEvent::new(Status::Offline).phase(Phase::Waiting, 2, Some(5))).unwrap();
        assert_eq!(json["status"], "offline");
        assert_eq!(json["phase"], "waiting");
        assert_eq!(json["retryAt"], 5);
    }
}
