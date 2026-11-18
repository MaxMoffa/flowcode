//! The `#[tauri::command]` surface the webview calls.

use crate::background;
use crate::connlog;
use crate::link;
use crate::state::{PairGuard, PairingState, Phase, Remote, Status, TicketInfo, PENDING_LINK_TTL};
use crate::store::{self, Pairing};
use flowcode_remote_proto::{preview_header, ClientMsg, PairingTicket, PreviewTarget, UploadMeta, UploadReply, UPLOAD_MAX_BYTES};
use link::LinkError;
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;

/// Upper bound for the background cap (a day).
const MAX_CAP_MINUTES: u32 = 24 * 60;

#[tauri::command]
pub fn platform() -> &'static str {
    if cfg!(mobile) {
        "mobile"
    } else {
        "desktop"
    }
}

// `(async)`: off the main thread, which the Android Keystore call needs free.
#[tauri::command(async)]
pub fn pairing_state(remote: State<'_, Arc<Remote>>) -> PairingState {
    match store::load_pairing(&remote.pairing_path(), &remote.codec) {
        store::PairingLoad::Found(p) => PairingState { paired: true, host_name: Some(p.host_name) },
        // Paired, only unreadable for now (the host name is unknown).
        store::PairingLoad::Unreadable(_) => PairingState { paired: true, host_name: None },
        store::PairingLoad::Missing | store::PairingLoad::Corrupt(_) => PairingState { paired: false, host_name: None },
    }
}

/// A `flowcode://pair` link the OS opened the app with, if any. Taken once and
/// dropped after `PENDING_LINK_TTL`. A link only ever fills in the pairing
/// screen (also to add another computer), it never pairs by itself.
#[tauri::command]
pub fn take_pending_link(remote: State<'_, Arc<Remote>>) -> Option<String> {
    let taken = remote.lock().pending_link.take();
    let (url, at) = taken?;
    if at.elapsed() > PENDING_LINK_TTL {
        return None;
    }
    Some(url)
}

/// What a pairing link points at, to ask "connect to <host>?" before pairing.
#[tauri::command]
pub fn inspect_ticket(ticket: String) -> Result<TicketInfo, String> {
    let (host_name, fingerprint) = link::inspect_ticket(&ticket)?;
    Ok(TicketInfo { host_name, fingerprint })
}

/// Fingerprint of this phone's own node id; the desktop shows the same one in
/// its confirm dialog, so the user can compare.
#[tauri::command]
pub async fn my_fingerprint(remote: State<'_, Arc<Remote>>) -> Result<String, String> {
    let endpoint = remote.endpoint().await?;
    Ok(flowcode_remote_proto::node_fingerprint(&endpoint.id().to_string()))
}

#[tauri::command]
pub async fn pair(app: AppHandle, remote: State<'_, Arc<Remote>>, ticket: String, device_name: String) -> Result<(), String> {
    let remote = Arc::clone(&remote);
    // A second pair while one waits for the desktop's confirmation is refused
    // before it can touch any state.
    if remote.pairing.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return Err("a pairing is already in progress".into());
    }
    let _guard = PairGuard(&remote.pairing);
    // Registered before anything else: an `unpair` that lands before the select
    // below first polls it must still cancel (like `wait` does).
    let cancelled = remote.pair_cancel.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();
    let parsed = PairingTicket::parse(&ticket).map_err(|e| e.to_string())?;
    let device_name = device_name.trim().to_string();
    if device_name.is_empty() {
        return Err("device name is empty".into());
    }
    // Checked before the desktop registers this phone: failing after the
    // handshake would leave an orphan device there.
    if let store::PairingLoad::Unreadable(e) = store::load_pairing(&remote.pairing_path(), &remote.codec) {
        return Err(format!("cannot read the current pairing: {e}"));
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
        _ = &mut cancelled => None,
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
    // Pairing another desktop keeps the one in use among the saved computers.
    let new_id = link::computer_id(&pairing.node);
    match store::load_pairing(&remote.pairing_path(), &remote.codec) {
        store::PairingLoad::Found(current) if link::computer_id(&current.node) != new_id => {
            if let Err(e) = remote.stash(current) {
                return failed(e);
            }
        }
        store::PairingLoad::Unreadable(e) => return failed(format!("cannot read the current pairing: {e}")),
        _ => {}
    }
    if let Err(e) = store::save_pairing(&remote.pairing_path(), &pairing, &remote.codec) {
        return failed(e);
    }
    // Paired again with a saved desktop: it is the active one now.
    if let Err(e) = remote.unstash(&new_id) {
        remote.log.push(e);
    }
    // Before the loop starts: the webview drops the old desktop's data first.
    let _ = app.emit("remote://computer", ());
    remote.start_task(&app, Some(session));
    remote.rearm_with(true);
    Ok(())
}

/// "Annulla" on the waiting page: stops a `pair` that waits for the desktop.
#[tauri::command]
pub fn cancel_pair(remote: State<'_, Arc<Remote>>) {
    remote.pair_cancel.notify_waiters();
}

/// Starts the reconnect loop for a stored pairing; harmless when it is
/// already running (it just republishes the state, e.g. after a reload).
// `(async)`: off the main thread, which the Android Keystore call needs free.
#[tauri::command(async)]
pub fn connect(app: AppHandle, remote: State<'_, Arc<Remote>>) {
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
        // A page that loads while the link is online (reloaded, or recreated
        // by Android while the service kept the core alive) missed `ready` and
        // the first `tabs`: only a new connection replays them.
        if state.status == Status::Online {
            remote.log.push("page loaded on a live link: reconnecting to replay the state");
            remote.start_task(&app, None);
        } else {
            let _ = app.emit("remote://state", state);
        }
        return;
    }
    remote.ensure_task(&app);
}

#[tauri::command]
pub fn send(remote: State<'_, Arc<Remote>>, msg: serde_json::Value) -> Result<(), String> {
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

/// Uploads one chat attachment on a new stream of the live connection. The
/// body is the raw file (base64 in JSON on Android, see `invoke_bytes`); `x-chat-id`, `x-name` (percent-encoded) and `x-mime`
/// travel as headers. Returns the id the desktop stored it under.
#[tauri::command]
pub async fn upload_chat_file(request: tauri::ipc::Request<'_>, remote: State<'_, Arc<Remote>>) -> Result<String, String> {
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok()).map(str::to_string);
    let chat_id = header("x-chat-id").filter(|v| !v.is_empty()).ok_or("missing chat id")?;
    let name = percent_decode(&header("x-name").unwrap_or_default());
    let mime = header("x-mime").unwrap_or_default();
    let bytes = invoke_bytes(request.body())?;
    if bytes.len() as u64 > UPLOAD_MAX_BYTES {
        return Err("File exceeds 32 MiB".into());
    }
    let conn = remote.lock().conn.clone().ok_or_else(|| "not connected".to_string())?;
    let meta = serde_json::to_string(&UploadMeta { name, mime, size: bytes.len() as u64 }).map_err(|e| e.to_string())?;
    let exchange = async move {
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        // A desktop that refuses the upload answers and stops reading: the
        // write then fails, but its reply says why, so read it before giving up.
        let write: Result<(), String> = async {
            send.write_all(preview_header(&PreviewTarget::ChatUpload(chat_id)).as_bytes()).await.map_err(|e| e.to_string())?;
            send.write_all(meta.as_bytes()).await.map_err(|e| e.to_string())?;
            send.write_all(b"\n").await.map_err(|e| e.to_string())?;
            send.write_all(&bytes).await.map_err(|e| e.to_string())?;
            send.finish().map_err(|e| e.to_string())
        }
        .await;
        let mut line = Vec::with_capacity(128);
        loop {
            let mut byte = [0u8; 1];
            match tokio::io::AsyncReadExt::read(&mut recv, &mut byte).await {
                Ok(1) if byte[0] != b'\n' => line.push(byte[0]),
                _ => break,
            }
            if line.len() >= 4096 {
                break;
            }
        }
        let reply: UploadReply = match serde_json::from_slice(&line) {
            Ok(reply) => reply,
            // No usable reply: the write error (if any) is the best we have.
            Err(_) => return Err(write.err().unwrap_or_else(|| "no answer from the desktop".to_string())),
        };
        match (reply.id, reply.error) {
            (Some(id), _) => Ok(id),
            (None, error) => Err(error.unwrap_or_else(|| "upload failed".into())),
        }
    };
    tokio::time::timeout(Duration::from_secs(150), exchange).await.map_err(|_| "upload timed out".to_string())?
}

/// The bytes of an upload invoke: the raw body, or `{"data": "<base64>"}` where
/// the webview can't send a raw body (Android's IPC goes through postMessage,
/// which turns everything into JSON).
fn invoke_bytes(body: &tauri::ipc::InvokeBody) -> Result<Vec<u8>, String> {
    use base64::Engine;
    match body {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        tauri::ipc::InvokeBody::Json(value) => {
            let data = value.get("data").and_then(serde_json::Value::as_str).ok_or("expected the file's bytes")?;
            base64::engine::general_purpose::STANDARD.decode(data).map_err(|e| format!("bad file data: {e}"))
        }
    }
}

/// Decodes `%XX` escapes as UTF-8; anything malformed stays as it is.
fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        let pair = if bytes[i] == b'%' && i + 2 < bytes.len() { hex(bytes[i + 1]).zip(hex(bytes[i + 2])) } else { None };
        if let Some((h, l)) = pair {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// "Retry now": ends the backoff sleep. Ignored unless the loop is waiting.
#[tauri::command]
pub fn retry_now(remote: State<'_, Arc<Remote>>) {
    if remote.lock().state.phase == Some(Phase::Waiting) {
        remote.log.push("retry requested by the user");
        remote.restart.send_replace(());
    }
}

/// A link hidden for longer than this is restarted on resume even if it still
/// answers: events sent to a frozen webview may have been lost.
const RESUME_KEEP_MAX_HIDDEN: Duration = Duration::from_secs(30);

/// Resume replaces background work immediately. Repeated visible events leave
/// a fresh cold-start dial alone.
#[tauri::command]
pub async fn app_resumed(app: AppHandle, remote: State<'_, Arc<Remote>>) -> Result<(), String> {
    let remote = Arc::clone(&remote);
    remote.log.push("app resumed");
    let was_hidden = !remote.visible.swap(true, Ordering::SeqCst);
    remote.hide_gen.fetch_add(1, Ordering::SeqCst);
    if let Some(task) = remote.cap_task.lock().unwrap_or_else(|e| e.into_inner()).take() {
        task.abort();
    }
    let hidden_for = remote.hidden_at.lock().unwrap_or_else(|e| e.into_inner()).take().map(|t| t.elapsed());
    remote.bg_capped.store(false, Ordering::SeqCst);
    if remote.bg_settings().enabled {
        remote.queue(ClientMsg::Background { on: false });
    }
    let state = remote.lock().state.clone();
    let mut restart = state.restart_on_resume(was_hidden);
    // A link that answers a ping right away is healthy: keep it instead of
    // tearing it down (a long hide may have lost events, so it restarts then).
    if restart && state.status == Status::Online && hidden_for.map_or(true, |d| d < RESUME_KEEP_MAX_HIDDEN) {
        if remote.link_answers(Duration::from_secs(2)).await {
            remote.log.push("resume: link answered a ping, kept");
            restart = false;
        } else {
            remote.log.push("resume: no answer to a ping, restarting the link");
        }
    }
    recover_link(&app, &remote, restart).await;
    Ok(())
}

/// Network recovery does not mark a hidden app visible or bypass pairing.
#[tauri::command]
pub async fn network_changed(app: AppHandle, remote: State<'_, Arc<Remote>>) -> Result<(), String> {
    let remote = Arc::clone(&remote);
    remote.log.push("network changed");
    if !remote.idle() {
        recover_link(&app, &remote, true).await;
    }
    Ok(())
}

async fn recover_link(app: &AppHandle, remote: &Arc<Remote>, restart_running: bool) {
    remote.network_change().await;
    if remote.pairing.load(Ordering::SeqCst) {
        return;
    }
    let running = remote.lock().task.is_some();
    if running {
        if restart_running {
            remote.restart.send_replace(());
        }
    } else if store::load_pairing(&remote.pairing_path(), &remote.codec).is_paired() {
        remote.ensure_task(app);
    }
}

/// The app went out of sight (call on `visibilitychange` -> hidden). With the
/// background mode on, the desktop is asked to send notifications only, and
/// the cap (if any) starts counting: the service stops itself when it runs out
/// and the link must follow.
#[tauri::command]
pub fn app_hidden(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    let remote = Arc::clone(&remote);
    remote.log.push("app hidden");
    remote.visible.store(false, Ordering::SeqCst);
    *remote.hidden_at.lock().unwrap_or_else(|e| e.into_inner()) = Some(std::time::Instant::now());
    if let Some(task) = remote.cap_task.lock().unwrap_or_else(|e| e.into_inner()).take() {
        task.abort();
    }
    let generation = remote.hide_gen.fetch_add(1, Ordering::SeqCst) + 1;
    remote.bg_capped.store(false, Ordering::SeqCst);
    let settings = remote.bg_settings();
    if settings.enabled {
        remote.queue(ClientMsg::Background { on: true });
        if settings.cap_minutes > 0 {
            let cap = Duration::from_secs(u64::from(settings.cap_minutes) * 60);
            let holder = Arc::clone(&remote);
            let task = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(cap).await;
                if remote.hide_gen.load(Ordering::SeqCst) != generation || remote.visible.load(Ordering::SeqCst) {
                    return;
                }
                remote.bg_capped.store(true, Ordering::SeqCst);
                remote.log.push("background cap reached");
                remote.suspend(&app);
            });
            *holder.cap_task.lock().unwrap_or_else(|e| e.into_inner()) = Some(task);
        }
    }
}

/// The webview has been hidden for a while (it calls this ~30 s after
/// `app_hidden`). With the background mode off nobody is listening, so the
/// loop stops pinging and redialing; `app_resumed` restarts it. With the mode
/// on the service keeps the link, so nothing happens (until its cap runs out).
#[tauri::command]
pub fn suspend_link(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    Arc::clone(&remote).suspend(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundState {
    enabled: bool,
    cap_minutes: u32,
}

#[tauri::command]
pub fn background_settings(remote: State<'_, Arc<Remote>>) -> BackgroundState {
    let s = remote.bg_settings();
    BackgroundState { enabled: s.enabled, cap_minutes: s.cap_minutes }
}

// `(async)`: arming reads the pairing, a Keystore call.
#[tauri::command(async)]
pub fn set_background_settings(remote: State<'_, Arc<Remote>>, enabled: bool, cap_minutes: u32) -> Result<(), String> {
    let cap_minutes = cap_minutes.min(MAX_CAP_MINUTES);
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
pub fn background_texts(remote: State<'_, Arc<Remote>>, title: String, text: String) {
    *remote.bg_texts.lock().unwrap_or_else(|e| e.into_inner()) = (title, text);
    remote.rearm();
}

// `(async)`: the plugin calls block, the permission one until the user answers.
#[tauri::command(async)]
pub fn notification_permission(remote: State<'_, Arc<Remote>>) -> Result<bool, String> {
    remote.background.notification_permission()
}

#[tauri::command(async)]
pub fn request_notification_permission(remote: State<'_, Arc<Remote>>) -> Result<bool, String> {
    remote.background.request_notification_permission()
}

/// The tab of the notification the app was opened from, once.
#[tauri::command(async)]
pub fn take_pending_tab(remote: State<'_, Arc<Remote>>) -> Option<String> {
    remote.background.take_pending_tab().ok().flatten()
}

/// The recent connection events, oldest first (Settings > diagnostics).
#[tauri::command]
pub fn connection_log(remote: State<'_, Arc<Remote>>) -> Vec<connlog::Entry> {
    remote.log.snapshot()
}

// `(async)`: promoting the next computer reads the Keystore.
#[tauri::command(async)]
pub fn unpair(app: AppHandle, remote: State<'_, Arc<Remote>>) {
    // A `pair` in flight must not save a pairing after this. The file goes
    // first so a loop that is still running cannot find it again.
    remote.pair_cancel.notify_waiters();
    store::forget_pairing(&remote.pairing_path());
    remote.stop_task();
    // Another saved desktop takes over; with none left the phone is unpaired.
    let remote = Arc::clone(&remote);
    if remote.promote_next(&app) {
        return;
    }
    remote.rearm_with(false);
    remote.set_state(&app, Status::Unpaired, None, None);
}
