//! One live link: the reader task, the select loop that pings, forwards
//! and writes, and the guard that tears the connection down.

use crate::backoff::{DEAD_AFTER, PING_EVERY, PROBE_TIMEOUT};
use crate::link::Session;
use crate::state::{Remote, OUT_QUEUE};
use flowcode_remote_proto::{ClientMsg, FrameError, ServerMsg};
use futures_lite::StreamExt;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// What the reader task hands to `serve`.
pub(crate) enum Inbound {
    Msg(ServerMsg),
    /// A frame that arrived whole but is not a message we know (a newer
    /// desktop): skipped, the link goes on.
    Skipped(String),
    /// I/O or framing error: the stream cannot be trusted any more.
    Failed(String),
}

pub(crate) fn classify_frame(frame: Result<ServerMsg, FrameError>) -> Inbound {
    match frame {
        Ok(msg) => Inbound::Msg(msg),
        Err(FrameError::Json(e)) => Inbound::Skipped(e.to_string()),
        Err(e) => Inbound::Failed(e.to_string()),
    }
}

/// Dropped when `serve` ends or its task is aborted (`stop_task`): without it
/// an aborted loop would leave the reader task and the QUIC connection alive.
pub(crate) struct ServeGuard {
    reader: tokio::task::AbortHandle,
    conn: iroh::endpoint::Connection,
}

impl Drop for ServeGuard {
    fn drop(&mut self) {
        self.reader.abort();
        self.conn.close(0u32.into(), b"bye");
    }
}


/// Reader-to-serve queue: when full the reader stops reading and QUIC flow
/// control pushes back on the desktop.
const IN_QUEUE: usize = 1024;
/// A write that has not completed in this long means the peer stopped reading:
/// without a cap it would block the select loop (and so the dead-link check)
/// until the QUIC idle timeout.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

/// Messages already waiting are handed to the webview in one event, up to this many.
const EMIT_BATCH: usize = 64;
/// Queued outgoing messages are written together, up to about this many encoded bytes.
const WRITE_BATCH_BYTES: usize = 64 * 1024;

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

pub(crate) enum Exit {
    /// The desktop refused us for good.
    Fatal(String),
    Lost(String),
}

/// One line about the selected path of a connection snapshot: direct (IP) or
/// through the relay, with its round trip. `None` when no path is selected.
fn selected_path(paths: &iroh::endpoint::PathList<'_>) -> Option<(String, String)> {
    let path = paths.iter().find(|p| p.is_selected())?;
    let kind = if path.is_relay() { "relay" } else { "direct" };
    let addr = path.remote_addr();
    Some((format!("{kind} {addr}"), format!("{kind} {addr} (rtt {} ms, {} paths open)", path.rtt().as_millis(), paths.len())))
}

/// How often the link's quality is refreshed in the diagnostics (the first
/// look comes sooner, once the path has settled).
const METRICS_EVERY: Duration = Duration::from_secs(10);
const METRICS_FIRST: Duration = Duration::from_secs(3);

/// UDP bytes sent and received so far, to rate between two looks.
struct LinkCounters {
    at: Instant,
    tx: u64,
    rx: u64,
}

impl LinkCounters {
    fn of(conn: &iroh::endpoint::Connection) -> LinkCounters {
        let stats = conn.stats();
        LinkCounters { at: Instant::now(), tx: stats.udp_tx.bytes, rx: stats.udp_rx.bytes }
    }
}

/// `1.5 KB/s` for `bytes` over `secs` seconds.
fn rate(bytes: u64, secs: f64) -> String {
    format!("{:.1} KB/s", bytes as f64 / 1024.0 / secs.max(0.001))
}

/// The link's quality as `direct 18 ms, tx .., rx .., N packets lost` (the
/// diagnostics screen reads the first two words and the number), from the
/// selected path and the traffic since `last`, which moves forward. `None`
/// when no path is selected.
fn link_metrics(conn: &iroh::endpoint::Connection, last: &mut LinkCounters) -> Option<String> {
    let paths = conn.paths();
    let path = paths.iter().find(|p| p.is_selected())?;
    let kind = if path.is_relay() { "relay" } else { "direct" };
    let now = LinkCounters::of(conn);
    let secs = now.at.duration_since(last.at).as_secs_f64();
    let line = format!(
        "{kind} {} ms, tx {}, rx {}, {} packets lost",
        path.rtt().as_millis(),
        rate(now.tx.saturating_sub(last.tx), secs),
        rate(now.rx.saturating_sub(last.rx), secs),
        conn.stats().lost_packets
    );
    *last = now;
    Some(line)
}

pub(crate) async fn serve(app: &AppHandle, remote: &Remote, mut session: Session) -> Exit {
    let (out_tx, mut out_rx) = mpsc::channel::<ClientMsg>(OUT_QUEUE);
    remote.lock().out = Some(out_tx.clone());

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
        // Large frames from a desktop that can deflate them come smaller; it
        // switches when it reads this, ahead of anything else we ask for.
        if session.caps.iter().any(|c| c == "compress") {
            if let Err(e) = send_frame(&mut session.send, &ClientMsg::Hello { caps: vec!["compress".into()] }).await {
                return Exit::Lost(e);
            }
        }
        // Set when the app resumes: the link must prove itself by then.
        let mut probe_until: Option<tokio::time::Instant> = None;
        if let Err(e) = send_frame(&mut session.send, &ClientMsg::List).await {
            return Exit::Lost(e);
        }
        // Back on a link while hidden: the desktop starts out sending everything.
        if !remote.visible.load(Ordering::SeqCst) && remote.bg_settings().enabled {
            if let Err(e) = send_frame(&mut session.send, &ClientMsg::Background { on: true }).await {
                return Exit::Lost(e);
            }
        }
        let mut warned_unknown = false;
        // Which path the link uses (direct or relay), logged when it changes;
        // the stream ends with the connection.
        let mut paths = session.conn.paths_stream();
        let mut last_path = String::new();
        let mut counters = LinkCounters::of(&session.conn);
        let mut metrics = tokio::time::interval_at(tokio::time::Instant::now() + METRICS_FIRST, METRICS_EVERY);
        loop {
            let probe = async {
                match probe_until {
                    Some(t) => tokio::time::sleep_until(t).await,
                    None => std::future::pending().await,
                }
            };
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
                                probe_until = None;
                                if let ServerMsg::Notify { title, body, tab_id } = &msg {
                                    remote.on_notify(title, body, tab_id.as_deref());
                                }
                                if let ServerMsg::Error { message, fatal: true, .. } = &msg {
                                    end = Some(Exit::Fatal(message.clone()));
                                }
                                batch.push(msg);
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
                        let _ = app.emit("remote://msgs", &batch);
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
                            Err(e) => remote.log.push(format!("dropped an outgoing message: {e}")),
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
                        return Exit::Lost("the desktop stopped answering".into());
                    }
                    if let Err(e) = send_frame(&mut session.send, &ClientMsg::Ping).await {
                        return Exit::Lost(e);
                    }
                }
                _ = remote.resume.notified() => {
                    remote.log.push("app resumed: probing the link");
                    if let Err(e) = send_frame(&mut session.send, &ClientMsg::Ping).await {
                        return Exit::Lost(e);
                    }
                    probe_until.get_or_insert_with(|| tokio::time::Instant::now() + PROBE_TIMEOUT);
                }
                Some(list) = paths.next() => {
                    if let Some((key, line)) = selected_path(&list) {
                        if key != last_path {
                            remote.log.push(format!("path: {line}"));
                            last_path = key;
                        }
                    }
                }
                _ = metrics.tick() => {
                    if let Some(line) = link_metrics(&session.conn, &mut counters) {
                        remote.log.push_metrics(&line);
                    }
                }
                _ = probe => return Exit::Lost("the desktop did not answer after resuming".into()),
            }
        }
    }
    .await;

    // An aborted-and-replaced serve may finish late: only clear our own sender.
    {
        let mut inner = remote.lock();
        if inner.out.as_ref().is_some_and(|o| o.same_channel(&out_tx)) {
            inner.out = None;
        }
    }
    // Before the guard closes the connection ourselves: what QUIC saw end it.
    match session.conn.close_reason() {
        Some(reason) => remote.log.push(format!("QUIC connection closed: {reason}")),
        None => remote.log.push("QUIC connection still open when the link was given up"),
    }
    exit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_undecodable_frame_is_skipped_but_io_errors_are_fatal() {
        let bad = serde_json::from_str::<ServerMsg>(r#"{"t":"from-the-future"}"#).unwrap_err();
        assert!(matches!(classify_frame(Err(FrameError::Json(bad))), Inbound::Skipped(_)));
        assert!(matches!(classify_frame(Err(FrameError::Closed)), Inbound::Failed(_)));
        assert!(matches!(classify_frame(Err(FrameError::TooLarge(1 << 30))), Inbound::Failed(_)));
        assert!(matches!(classify_frame(Ok(ServerMsg::Pong)), Inbound::Msg(ServerMsg::Pong)));
    }
}
