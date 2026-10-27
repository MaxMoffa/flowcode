//! One PC's connection: the loop that dials, serves and redials, and the
//! select loop that pings, forwards and writes. Modeled on the phone's
//! `reconnect.rs` + `serve.rs`, minus everything about Android's background
//! life: a desktop link is wanted for as long as the app runs.

use super::backoff::{backoff_delay, failures_after_link, DEAD_AFTER, PING_EVERY, REBUILD_ENDPOINT_EVERY};
use super::connlog::ConnLog;
use super::link::{self, LinkError, Session};
use super::store::Pairing;
use super::{cache_put, HostStatus, MsgsEvent, RemoteClients, EVT_MSGS, OUT_QUEUE};
use flowcode_remote_proto::{ClientMsg, FrameError, ServerMsg};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Notify};

/// Reader-to-serve queue: when full the reader stops reading and QUIC flow
/// control pushes back on the other PC.
const IN_QUEUE: usize = 1024;
/// A write that has not completed in this long means the peer stopped reading:
/// without a cap it would block the select loop (and so the dead-link check)
/// until the QUIC idle timeout.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Messages already waiting are handed to the webview in one event, up to this many.
const EMIT_BATCH: usize = 64;
/// Queued outgoing messages are written together, up to about this many encoded bytes.
const WRITE_BATCH_BYTES: usize = 64 * 1024;

/// What the reader task hands to `serve`.
enum Inbound {
    Msg(ServerMsg),
    /// A frame that arrived whole but is not a message we know (a newer
    /// peer): skipped, the link goes on.
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

/// Dropped when `serve` ends or its task is aborted: without it an aborted
/// loop would leave the reader task and the QUIC connection alive.
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

/// Write `bytes` (whole frames) with a deadline. A cancelled write may leave
/// half a frame on the stream, so an error here (timeout included) must end
/// the link.
async fn send_bytes(send: &mut iroh::endpoint::SendStream, bytes: &[u8]) -> Result<(), String> {
    match tokio::time::timeout(WRITE_TIMEOUT, send.write_all(bytes)).await {
        Ok(r) => r.map_err(|e| e.to_string()),
        Err(_) => Err("write stalled".into()),
    }
}

/// One message as a frame, with a deadline (see `send_bytes`).
async fn send_frame(send: &mut iroh::endpoint::SendStream, msg: &ClientMsg) -> Result<(), String> {
    let bytes = flowcode_remote_proto::encode_frame(msg, false).map_err(|e| e.to_string())?;
    send_bytes(send, &bytes).await
}

enum Exit {
    /// The other PC refused us for good (revoked, bad token).
    Fatal(String),
    Lost(String),
}

/// Backoff sleep that a `remote_host_connect` on a running host can end early.
async fn wait(clients: &RemoteClients, app: &AppHandle, id: &str, retry: &Notify, log: &ConnLog, error: String, attempt: u32, delay: Duration) {
    // Registered before the state is published: a retry the UI sends on
    // seeing the error can then never slip in between.
    let notified = retry.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();
    log.push(format!("attempt failed ({error}); retry in {} s (failure {attempt})", delay.as_secs()));
    clients.set_status(app, id, HostStatus::Connecting, Some(error));
    tokio::select! {
        _ = tokio::time::sleep(delay) => {}
        _ = &mut notified => {}
    }
}

/// One dial + handshake with a stored PC.
async fn connect_once(app: &AppHandle, clients: &RemoteClients, id: &str, log: &ConnLog, pairing: &Pairing, failures: u32) -> Result<Session, LinkError> {
    // Repeated failures may mean the endpoint is stuck on a dead network:
    // start over with a fresh one. Not while a `pair` holds the current one,
    // nor while another host's live link would be cut with it.
    if failures > 0 && failures.is_multiple_of(REBUILD_ENDPOINT_EVERY) && !clients.pairing.load(Ordering::SeqCst) && !clients.other_online(id) {
        log.push(format!("endpoint rebuilt after {failures} failed attempts"));
        clients.reset_endpoint().await;
    }
    clients.set_status(app, id, HostStatus::Connecting, None);
    let endpoint = clients.endpoint().await.map_err(LinkError::Transient)?;
    // Cheap and harmless when nothing changed; cures stale paths when it did.
    if failures > 0 {
        endpoint.network_change().await;
    }
    link::handshake_with(&endpoint, &pairing.node, ClientMsg::Auth { token: pairing.token.clone() }, || {}, |line| log.push(line)).await
}

/// Connects, serves, and reconnects until the pairing is gone, the PC refuses
/// us for good, or the task is aborted. `initial` is a session `pair` already
/// established.
pub(super) async fn host_loop(app: &AppHandle, clients: &Arc<RemoteClients>, id: &str, mut initial: Option<Session>) {
    let (retry, log) = match clients.lock().get(id) {
        Some(conn) => (Arc::clone(&conn.retry), Arc::clone(&conn.log)),
        None => return,
    };
    let mut failures: u32 = 0;
    log.push("connection loop started");
    loop {
        let pairing = match clients.pairing_of(id) {
            Ok(Some(p)) => p,
            Ok(None) => {
                log.push("pairing is gone");
                clients.set_status(app, id, HostStatus::Offline, None);
                return;
            }
            // hosts.json unreadable for now: try again later.
            Err(message) => {
                failures += 1;
                wait(clients, app, id, &retry, &log, message, failures, backoff_delay(failures, true)).await;
                continue;
            }
        };
        let session = match initial.take() {
            Some(s) => s,
            None => match connect_once(app, clients, id, &log, &pairing, failures).await {
                Ok(s) => s,
                Err(LinkError::Fatal(message)) => {
                    // The pairing stays saved: the user can forget it or pair again.
                    log.push(format!("refused for good: {message}"));
                    clients.set_status(app, id, HostStatus::Offline, Some(message));
                    return;
                }
                Err(LinkError::Transient(message)) => {
                    failures += 1;
                    wait(clients, app, id, &retry, &log, message, failures, backoff_delay(failures, true)).await;
                    continue;
                }
            },
        };
        let host_name = clean_peer_name(&session.host_name, &pairing.host_name);
        let device_name = clean_peer_name(&session.device_name, &pairing.device_name);
        if host_name != pairing.host_name {
            let (node, name) = (pairing.node.clone(), host_name.clone());
            let renamed = clients.modify_hosts(|list| {
                if let Some(p) = list.iter_mut().find(|p| p.node == node) {
                    p.host_name = name;
                }
            });
            if let Err(e) = renamed {
                log.push(format!("cannot save the new host name: {e}"));
            }
            let _ = app.emit(super::EVT_LIST, ());
        }
        clients.update_info(app, id, |info| {
            info.status = HostStatus::Online;
            info.error = None;
            info.host_name = host_name.clone();
            info.device_name = device_name;
            info.caps = session.caps.clone();
            info.app_version = session.app_version.clone();
        });
        log.push(format!("online with {host_name}"));
        let online_since = Instant::now();
        match serve(app, clients, id, &log, session).await {
            Exit::Fatal(message) => {
                log.push(format!("peer sent a fatal error: {message}"));
                clients.set_status(app, id, HostStatus::Offline, Some(message));
                return;
            }
            Exit::Lost(message) => {
                let lived = online_since.elapsed();
                log.push(format!("link closed after {} s: {message}", lived.as_secs()));
                // A link that held is a fresh start; one that died at once keeps
                // counting, so the backoff grows and the endpoint gets rebuilt.
                failures = failures_after_link(failures, lived);
                wait(clients, app, id, &retry, &log, message, failures, backoff_delay(failures, true)).await;
            }
        }
    }
}

async fn serve(app: &AppHandle, clients: &RemoteClients, id: &str, log: &ConnLog, mut session: Session) -> Exit {
    let (out_tx, mut out_rx) = mpsc::channel::<ClientMsg>(OUT_QUEUE);
    if let Some(conn) = clients.lock().get_mut(id) {
        conn.out = Some(out_tx.clone());
        // The server forgot every stream of the previous link.
        conn.clear_streams();
    }

    // read_frame is not cancel-safe, so it lives in its own task and the
    // select below only touches the channel.
    let (in_tx, mut in_rx) = mpsc::channel::<Inbound>(IN_QUEUE);
    let mut recv = session.recv;
    let reader = tokio::spawn(async move {
        loop {
            let item = classify_frame(flowcode_remote_proto::read_frame::<_, ServerMsg>(&mut recv).await);
            let stop = matches!(item, Inbound::Failed(_));
            if in_tx.send(item).await.is_err() || stop {
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
        // Large frames from a peer that can deflate them come smaller; it
        // switches when it reads this, ahead of anything else we ask for.
        if session.caps.iter().any(|c| c == "compress") {
            if let Err(e) = send_frame(&mut session.send, &ClientMsg::Hello { caps: vec!["compress".into()] }).await {
                return Exit::Lost(e);
            }
        }
        if let Err(e) = send_frame(&mut session.send, &ClientMsg::List).await {
            return Exit::Lost(e);
        }
        let mut warned_unknown = false;
        loop {
            tokio::select! {
                incoming = in_rx.recv() => {
                    // One webview event for the whole burst already waiting.
                    let mut batch: Vec<ServerMsg> = Vec::new();
                    let mut end: Option<Exit> = None;
                    let mut item = incoming;
                    loop {
                        match item {
                            Some(Inbound::Msg(msg)) => {
                                last_rx = Instant::now();
                                if let ServerMsg::Error { message, fatal: true, .. } = &msg {
                                    end = Some(Exit::Fatal(message.clone()));
                                }
                                // Pongs only prove the link is alive.
                                if !matches!(msg, ServerMsg::Pong) {
                                    batch.push(msg);
                                }
                            }
                            Some(Inbound::Skipped(e)) => {
                                // Still proof that the link is alive.
                                last_rx = Instant::now();
                                if !warned_unknown {
                                    warned_unknown = true;
                                    log.push(format!("skipped a message this version does not understand: {e}"));
                                }
                            }
                            Some(Inbound::Failed(e)) => end = Some(Exit::Lost(e)),
                            None => end = Some(Exit::Lost("connection closed".into())),
                        }
                        if end.is_some() || batch.len() >= EMIT_BATCH {
                            break;
                        }
                        match in_rx.try_recv() {
                            Ok(next) => item = Some(next),
                            Err(mpsc::error::TryRecvError::Empty) => break,
                            Err(mpsc::error::TryRecvError::Disconnected) => item = None,
                        }
                    }
                    if !batch.is_empty() {
                        // Cached before the event goes out: a window that
                        // mounts on seeing it must find the message.
                        if let Some(conn) = clients.lock().get_mut(id) {
                            for msg in &batch {
                                cache_put(&mut conn.cache, msg);
                            }
                        }
                        let _ = app.emit(EVT_MSGS, MsgsEvent { host_id: id, msgs: &batch });
                    }
                    if let Some(exit) = end {
                        return exit;
                    }
                }
                outgoing = out_rx.recv() => {
                    let Some(first) = outgoing else { return Exit::Lost("stopped".into()) };
                    // Everything already queued goes out in one write.
                    let mut buf: Vec<u8> = Vec::new();
                    let mut next = Some(first);
                    while let Some(msg) = next.take() {
                        match flowcode_remote_proto::encode_frame(&msg, false) {
                            Ok(bytes) => buf.extend_from_slice(&bytes),
                            Err(e) => log.push(format!("dropped an outgoing message: {e}")),
                        }
                        if buf.len() < WRITE_BATCH_BYTES {
                            next = out_rx.try_recv().ok();
                        }
                    }
                    if !buf.is_empty() {
                        if let Err(e) = send_bytes(&mut session.send, &buf).await {
                            return Exit::Lost(e);
                        }
                    }
                }
                _ = ping.tick() => {
                    if last_rx.elapsed() > DEAD_AFTER {
                        return Exit::Lost("the computer stopped answering".into());
                    }
                    if let Err(e) = send_frame(&mut session.send, &ClientMsg::Ping).await {
                        return Exit::Lost(e);
                    }
                }
            }
        }
    }
    .await;

    // An aborted-and-replaced serve may finish late: only clear our own sender.
    if let Some(conn) = clients.lock().get_mut(id) {
        if conn.out.as_ref().is_some_and(|o| o.same_channel(&out_tx)) {
            conn.out = None;
            conn.clear_streams();
        }
    }
    // Before the guard closes the connection ourselves: what QUIC saw end it.
    match session.conn.close_reason() {
        Some(reason) => log.push(format!("QUIC connection closed: {reason}")),
        None => log.push("QUIC connection still open when the link was given up"),
    }
    exit
}

/// Longest host/device name kept from a peer, in characters.
const PEER_NAME_MAX: usize = 128;

/// A name the other PC reports about itself (or about us), made fit to show:
/// control characters dropped, and the invisible/bidi ones too (a U+202E
/// would let `Max PC<RLO>cod.exe` read backwards in the list); trimmed and
/// cut to `PEER_NAME_MAX`. Nothing left means `fallback` - the name we had.
pub(super) fn clean_peer_name(raw: &str, fallback: &str) -> String {
    let invisible = |c: char| {
        c.is_control()
            || matches!(
                c,
                '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' | '\u{2028}' | '\u{2029}' | '\u{feff}'
            )
    };
    let kept: String = raw.chars().filter(|&c| !invisible(c)).collect();
    let name: String = kept.trim().chars().take(PEER_NAME_MAX).collect();
    let name = name.trim_end();
    if name.is_empty() { fallback.to_string() } else { name.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peer_names_are_cleaned() {
        assert_eq!(clean_peer_name("  Max PC  ", "old"), "Max PC");
        assert_eq!(clean_peer_name("Max\u{0}\u{1b}[31m PC\u{7f}\u{9b}", "old"), "Max[31m PC");
        assert_eq!(clean_peer_name("Max PC\u{202e}exe.doc\u{2066}\u{200b}\u{feff}", "old"), "Max PCexe.doc");
        assert_eq!(clean_peer_name("\u{202e}\u{200f} \n\t", "old"), "old");
        assert_eq!(clean_peer_name("", "old"), "old");
        assert_eq!(clean_peer_name(&"\u{e8}".repeat(300), "old").chars().count(), PEER_NAME_MAX);
        assert_eq!(clean_peer_name(&format!("{} x", "a".repeat(127)), "old"), "a".repeat(127));
    }

    #[test]
    fn an_undecodable_frame_is_skipped_but_io_errors_are_fatal() {
        let bad = serde_json::from_str::<ServerMsg>(r#"{"t":"from-the-future"}"#).unwrap_err();
        assert!(matches!(classify_frame(Err(FrameError::Json(bad))), Inbound::Skipped(_)));
        assert!(matches!(classify_frame(Err(FrameError::Closed)), Inbound::Failed(_)));
        assert!(matches!(classify_frame(Ok(ServerMsg::Pong)), Inbound::Msg(ServerMsg::Pong)));
    }
}
