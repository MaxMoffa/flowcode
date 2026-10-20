//! Streaming one terminal to a phone: the initial snapshot, live output, and
//! resyncs when the phone falls behind.

use std::sync::Arc;
use std::time::Duration;

use flowcode_remote_proto::{self as proto, ServerMsg};
use flowcode_shared::i18n::tr;
use tauri::{Emitter, Manager};
use tokio::sync::{mpsc, oneshot};

use super::hex::random_hex;
use super::{Shared, SnapshotReply, EVT_SNAPSHOT_REQUEST, OUT_QUEUE, OUT_RESERVE};
use crate::pty::{PtyState, RemoteOut};
use crate::util::lock;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);

/// A resync waits this long between looks at the phone's queue.
const RESYNC_POLL: Duration = Duration::from_millis(200);

/// Snapshots tried per resync before accepting one that may miss a few bytes
/// (the window flushes xterm's parse queue before serializing, so one or two
/// normally suffice).
const RESYNC_ATTEMPTS: u32 = 3;

/// How long after accepting such a snapshot one last resync is tried.
const RESYNC_DEFERRED: Duration = Duration::from_secs(3);

/// Least time between two snapshot requests of one stream: each one makes the
/// window serialize its whole terminal, which slows its parsing further.
const RESYNC_MIN_GAP: Duration = Duration::from_secs(1);

/// A snapshot's JSON-encoded size: half a frame, leaving room for the rest.
const SNAPSHOT_MAX_ENCODED: usize = proto::MAX_FRAME / 2;
/// Live output events waiting in the queue are folded into one frame up to about this size.
const COALESCE_BYTES: usize = 32 * 1024;

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
pub(super) async fn stream_pty(shared: Arc<Shared>, pty_id: String, out: mpsc::Sender<ServerMsg>) {
    let subscription = shared.app.state::<PtyState>().remote_subscribe(&pty_id);
    let Some((mut feed, mut cols, mut rows, owner)) = subscription else {
        let message = tr("Terminale non trovato", "Terminal not found").to_string();
        let _ = out.send(ServerMsg::Error { message, pty_id: Some(pty_id.clone()), fatal: false }).await;
        let _ = out.send(ServerMsg::Exit { pty_id }).await;
        return;
    };

    let mut last_request = tokio::time::Instant::now();
    let (data, mut snapshot_seq) = request_snapshot(&shared, &pty_id, owner).await;
    if !send_snapshot(&out, &pty_id, data, cols, rows).await {
        return;
    }

    // Set while output is being dropped; `lost_seq` is the newest dropped.
    let mut resync = false;
    let mut lost_seq = 0u64;
    let mut attempts = 0u32;
    // After accepting a snapshot that still misses some output, one more
    // resync is scheduled (`retry_at`; `deferred` = it was already used for
    // this incident), so the phone isn't left without that output for good.
    let mut retry_at: Option<tokio::time::Instant> = None;
    let mut deferred = false;
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
            // At most one snapshot request per RESYNC_MIN_GAP.
            if last_request.elapsed() < RESYNC_MIN_GAP {
                tokio::time::sleep(RESYNC_POLL).await;
                continue;
            }
            feed.clear_lag();
            last_request = tokio::time::Instant::now();
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
            let complete = seq >= lost_seq.max(feed.dropped_seq());
            if complete || attempts >= RESYNC_ATTEMPTS {
                resync = false;
                attempts = 0;
                if !complete && !deferred {
                    // Keep `lost_seq`: the deferred resync must still cover it.
                    deferred = true;
                    retry_at = Some(tokio::time::Instant::now() + RESYNC_DEFERRED);
                } else {
                    lost_seq = 0;
                    deferred = false;
                    retry_at = None;
                }
            } else {
                tokio::time::sleep(RESYNC_POLL).await;
            }
            continue;
        }
        let event = match retry_at {
            Some(at) => tokio::select! {
                event = feed.rx.recv() => event,
                () = tokio::time::sleep_until(at) => {
                    retry_at = None;
                    resync = true;
                    continue;
                }
            },
            None => feed.rx.recv().await,
        };
        let Some(event) = event else { break };
        match event {
            RemoteOut::Output { mut data, mut seq } if seq > snapshot_seq => {
                // Fold what is already waiting into this frame (up to
                // COALESCE_BYTES); an exit met on the way is handled after it.
                let mut exited = false;
                while data.len() < COALESCE_BYTES {
                    match feed.rx.try_recv() {
                        Ok(RemoteOut::Output { data: more, seq: next }) => {
                            if next > snapshot_seq {
                                data.push_str(&more);
                                seq = next;
                            }
                        }
                        Ok(RemoteOut::Exit) | Err(mpsc::error::TryRecvError::Disconnected) => {
                            exited = true;
                            break;
                        }
                        Err(mpsc::error::TryRecvError::Empty) => break,
                    }
                }
                // Keep room in the queue for replies and pushes.
                if out.capacity() <= OUT_RESERVE {
                    lost_seq = lost_seq.max(seq);
                    resync = true;
                } else {
                    match out.try_send(ServerMsg::Output { pty_id: pty_id.clone(), data }) {
                        Ok(()) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            lost_seq = lost_seq.max(seq);
                            resync = true;
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => return,
                    }
                }
                if exited {
                    break;
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
}
