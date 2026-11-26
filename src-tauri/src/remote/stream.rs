//! Streaming one terminal to a phone: the initial snapshot, live output, and
//! resyncs when the phone falls behind.

use std::sync::Arc;
use std::time::Duration;

use flowcode_remote_proto::{self as proto, ServerMsg};
use flowcode_shared::i18n::tr;
use tauri::{Emitter, Manager};
use tokio::sync::{broadcast, mpsc, oneshot};

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

/// A snapshot's JSON-encoded size: half a frame, as before compression (a
/// compressing phone gets it at about a tenth of that on the wire).
const SNAPSHOT_MAX_ENCODED: usize = proto::MAX_FRAME / 2;
/// Live output events waiting in the queue are folded into one frame up to about this size.
const COALESCE_BYTES: usize = 32 * 1024;

/// Output frames of one stream go out at least this far apart: a burst (a
/// build, a `cat`) is folded into a few large frames instead of one per pty
/// read, while a keystroke's echo after a quiet moment is not held at all.
const BATCH_WINDOW: Duration = Duration::from_millis(8);

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
/// Empty (seq 0) when there is no window to ask; `None` when the window did
/// not answer in time (asleep, minimized: it answers once it is back).
async fn request_snapshot(shared: &Shared, pty_id: &str, owner: Option<String>) -> Option<SnapshotReply> {
    // No owner: the window is in transit (the tab moves between windows), so a live pty is
    // unanswered and asked again; only a pty that is gone has nothing to show.
    let Some(owner) = owner else {
        return if shared.app.state::<PtyState>().exists(pty_id) { None } else { Some((String::new(), 0)) };
    };
    let Ok(req_id) = random_hex(8) else { return Some((String::new(), 0)) };
    let (tx, reply) = oneshot::channel();
    lock(&shared.waiters).insert(req_id.clone(), tx);
    let _guard = WaiterGuard(shared, req_id.clone());
    let payload = serde_json::json!({ "reqId": req_id, "ptyId": pty_id });
    if shared.app.emit_to(owner.as_str(), EVT_SNAPSHOT_REQUEST, payload).is_ok() {
        if let Ok(Ok(reply)) = tokio::time::timeout(SNAPSHOT_TIMEOUT, reply).await {
            return Some(reply);
        }
    }
    None
}

/// One client's view of one pty: snapshot of the current screen, then the
/// live output. Subscribes *before* asking for the snapshot so no output can
/// fall in the gap; whatever the snapshot already includes (seq <= its seq)
/// is skipped.
///
/// When the phone can't keep up (the pty's queue for it, or its share of the
/// connection's out queue, is full) the output is dropped instead of
/// buffered, and once things drain a new snapshot replaces what was lost.
pub(super) async fn stream_pty(shared: Arc<Shared>, pty_id: String, out: mpsc::Sender<ServerMsg>, resized: bool) {
    // Before subscribing to the pty, so no size change falls in the gap.
    let mut size_rx = crate::pty::size_events();
    let mut resized = resized;
    let subscription = shared.app.state::<PtyState>().remote_subscribe(&pty_id);
    let Some((mut feed, mut cols, mut rows, owner)) = subscription else {
        let message = tr("Terminale non trovato", "Terminal not found").to_string();
        let _ = out.send(ServerMsg::Error { message, pty_id: Some(pty_id.clone()), chat_id: None, fatal: false }).await;
        let _ = out.send(ServerMsg::Exit { pty_id }).await;
        return;
    };

    let mut last_request = tokio::time::Instant::now();
    // When the last output frame went out: bursts are paced from it.
    let mut last_sent = tokio::time::Instant::now();
    let reply = request_snapshot(&shared, &pty_id, owner).await;
    // An unanswered request still sends an (empty) snapshot, so the phone
    // starts clean, and then asks again until the window answers.
    let mut resync = reply.is_none();
    let (data, mut snapshot_seq) = reply.unwrap_or_default();
    if !send_snapshot(&out, &pty_id, data, cols, rows).await {
        return;
    }
    // What the tab's agent already delegated: the live events (queued since the subscription) come after it.
    for params in crate::chat::delegate::terminal_delegate_params(&shared.app, &pty_id) {
        if !send_ext(&out, &pty_id, "_flowcode/delegate".to_string(), params) {
            return;
        }
    }
    // Likewise the cards of the messages it received or sent.
    for (method, params) in crate::agent_messages::of_terminal(&shared.app, &pty_id) {
        if !send_ext(&out, &pty_id, method, params) {
            return;
        }
    }

    // Set while output is being dropped; `lost_seq` is the newest dropped.
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
                // Not terminal output: the snapshot does not replace it.
                Ok(RemoteOut::Ext { method, params }) => {
                    if !send_ext(&out, &pty_id, method, params) {
                        return;
                    }
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
            // Unanswered: the phone keeps what it has; ask again after the gap.
            let Some((data, seq)) = request_snapshot(&shared, &pty_id, owner).await else { continue };
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
        let event = tokio::select! {
            event = feed.rx.recv() => event,
            () = async {
                match retry_at {
                    Some(at) => tokio::time::sleep_until(at).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                retry_at = None;
                resync = true;
                continue;
            }
            size = size_rx.recv(), if resized => {
                let size = match size {
                    Ok((id, c, r)) => (id == pty_id).then_some((c, r)),
                    Err(broadcast::error::RecvError::Lagged(_)) => shared.app.state::<PtyState>().sizes().get(&pty_id).copied(),
                    Err(broadcast::error::RecvError::Closed) => {
                        resized = false;
                        None
                    }
                };
                if let Some((c, r)) = size {
                    (cols, rows) = (c, r);
                    // Best effort like the output: the reserve stays for replies.
                    if out.capacity() > OUT_RESERVE {
                        if let Err(mpsc::error::TrySendError::Closed(_)) = out.try_send(ServerMsg::Resized { pty_id: pty_id.clone(), cols: c, rows: r }) {
                            return;
                        }
                    }
                }
                continue;
            }
        };
        let Some(event) = event else { break };
        match event {
            RemoteOut::Output { data, seq } if seq > snapshot_seq => {
                // Fold what is waiting, and what arrives before the batch
                // window closes, into this frame; an exit met on the way is
                // handled after it.
                let mut exts = Vec::new();
                let (data, seq, exited) = fold_output(&mut feed.rx, data, seq, snapshot_seq, last_sent + BATCH_WINDOW, &mut exts).await;
                // Keep room in the queue for replies and pushes.
                if out.capacity() <= OUT_RESERVE {
                    lost_seq = lost_seq.max(seq);
                    resync = true;
                } else {
                    match out.try_send(ServerMsg::Output { pty_id: pty_id.clone(), data }) {
                        Ok(()) => last_sent = tokio::time::Instant::now(),
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            lost_seq = lost_seq.max(seq);
                            resync = true;
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => return,
                    }
                }
                // App events that came in with the batch go out right after its output.
                for (method, params) in exts {
                    if !send_ext(&out, &pty_id, method, params) {
                        return;
                    }
                }
                if exited {
                    break;
                }
            }
            RemoteOut::Output { .. } => {}
            RemoteOut::Ext { method, params } => {
                if !send_ext(&out, &pty_id, method, params) {
                    return;
                }
            }
            RemoteOut::Exit => break,
        }
    }
    // Either the program exited or the session vanished: both end the stream.
    let _ = out.send(ServerMsg::Exit { pty_id }).await;
}

/// Queues an app event (`ServerMsg::Ext`) unless the phone's queue is nearly
/// full: it is best effort, like the output it travels with, and keeps the
/// reserve for replies. False when the connection is gone.
fn send_ext(out: &mpsc::Sender<ServerMsg>, pty_id: &str, method: String, params: serde_json::Value) -> bool {
    if out.capacity() <= OUT_RESERVE {
        return !out.is_closed();
    }
    !matches!(out.try_send(ServerMsg::Ext { pty_id: pty_id.to_string(), method, params }), Err(mpsc::error::TrySendError::Closed(_)))
}

/// Folds the output events that follow `data` (up to `COALESCE_BYTES`) into
/// it: those already queued, then any that arrive before `until`. Events the
/// snapshot already covers are dropped; app events met on the way are set
/// aside in `exts`, in order. Returns the text, the newest `seq` and whether
/// the program exited (or the feed closed) on the way.
async fn fold_output(
    rx: &mut mpsc::Receiver<RemoteOut>,
    mut data: String,
    mut seq: u64,
    snapshot_seq: u64,
    until: tokio::time::Instant,
    exts: &mut Vec<(String, serde_json::Value)>,
) -> (String, u64, bool) {
    while data.len() < COALESCE_BYTES {
        let event = match rx.try_recv() {
            Ok(event) => event,
            Err(mpsc::error::TryRecvError::Disconnected) => return (data, seq, true),
            Err(mpsc::error::TryRecvError::Empty) => match tokio::time::timeout_at(until, rx.recv()).await {
                Ok(Some(event)) => event,
                Ok(None) => return (data, seq, true),
                Err(_) => break,
            },
        };
        match event {
            RemoteOut::Output { data: more, seq: next } => {
                if next > snapshot_seq {
                    data.push_str(&more);
                    seq = next;
                }
            }
            RemoteOut::Ext { method, params } => exts.push((method, params)),
            RemoteOut::Exit => return (data, seq, true),
        }
    }
    (data, seq, false)
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
        let _ = out.send(ServerMsg::Error { message, pty_id: Some(pty_id.to_string()), chat_id: None, fatal: false }).await;
    }
    out.send(ServerMsg::Snapshot { pty_id: pty_id.to_string(), data, cols, rows }).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(data: &str, seq: u64) -> RemoteOut {
        RemoteOut::Output { data: data.to_string(), seq }
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_inside_the_window_is_one_frame() {
        let (tx, mut rx) = mpsc::channel(16);
        let start = tokio::time::Instant::now();
        // Chunks 1 ms apart, then one after the window closed.
        tokio::spawn(async move {
            for i in 1..=5u64 {
                tokio::time::sleep(Duration::from_millis(1)).await;
                tx.send(output("x", i + 1)).await.unwrap();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            let _ = tx.send(output("late", 7)).await;
        });
        let (data, seq, exited) = fold_output(&mut rx, "a".into(), 1, 0, start + BATCH_WINDOW, &mut Vec::new()).await;
        assert_eq!((data.as_str(), seq, exited), ("axxxxx", 6, false));
        // The window, not the arrival of the last chunk, ended the wait.
        assert_eq!(start.elapsed(), BATCH_WINDOW);
        let (data, ..) = fold_output(&mut rx, "b".into(), 7, 0, tokio::time::Instant::now(), &mut Vec::new()).await;
        assert_eq!(data, "b");
    }

    #[tokio::test(start_paused = true)]
    async fn a_quiet_stream_is_not_delayed_and_covered_output_is_skipped() {
        let (tx, mut rx) = mpsc::channel(16);
        tx.send(output("old", 2)).await.unwrap();
        tx.send(output("new", 4)).await.unwrap();
        let before = tokio::time::Instant::now();
        // The window already closed: only what is queued is folded, no waiting.
        let (data, seq, exited) = fold_output(&mut rx, "k".into(), 3, 3, before, &mut Vec::new()).await;
        assert_eq!((data.as_str(), seq, exited), ("knew", 4, false));
        assert_eq!(before.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn an_exit_ends_the_fold_and_a_full_frame_stops_it() {
        let (tx, mut rx) = mpsc::channel(16);
        tx.send(output("x", 2)).await.unwrap();
        tx.send(RemoteOut::Exit).await.unwrap();
        let until = tokio::time::Instant::now() + BATCH_WINDOW;
        assert_eq!(fold_output(&mut rx, String::new(), 1, 0, until, &mut Vec::new()).await, ("x".to_string(), 2, true));
        let big = "y".repeat(COALESCE_BYTES);
        tx.send(output("z", 3)).await.unwrap();
        assert_eq!(fold_output(&mut rx, big.clone(), 2, 0, until, &mut Vec::new()).await, (big, 2, false));
    }

    #[tokio::test(start_paused = true)]
    async fn app_events_do_not_end_or_split_a_fold() {
        let (tx, mut rx) = mpsc::channel(16);
        tx.send(output("x", 2)).await.unwrap();
        tx.send(RemoteOut::Ext { method: "_flowcode/call".into(), params: serde_json::json!({ "message": "hi" }) }).await.unwrap();
        tx.send(output("y", 3)).await.unwrap();
        let mut exts = Vec::new();
        let until = tokio::time::Instant::now();
        assert_eq!(fold_output(&mut rx, "a".into(), 1, 0, until, &mut exts).await, ("axy".to_string(), 3, false));
        assert_eq!(exts, vec![("_flowcode/call".to_string(), serde_json::json!({ "message": "hi" }))]);
    }

    #[test]
    fn app_events_go_out_as_ext_frames_while_there_is_room() {
        let (tx, mut rx) = mpsc::channel(OUT_RESERVE + 2);
        assert!(send_ext(&tx, "p1", "_flowcode/open".into(), serde_json::json!({ "target": "x" })));
        let Ok(ServerMsg::Ext { pty_id, method, params }) = rx.try_recv() else { panic!("no ext frame") };
        assert_eq!((pty_id.as_str(), method.as_str(), params["target"].as_str()), ("p1", "_flowcode/open", Some("x")));
        // Nearly full: dropped, but the connection is still there.
        let (tx, rx) = mpsc::channel(OUT_RESERVE);
        assert!(send_ext(&tx, "p1", "_flowcode/call".into(), serde_json::json!({})));
        assert_eq!(tx.capacity(), OUT_RESERVE);
        drop(rx);
        assert!(!send_ext(&tx, "p1", "_flowcode/call".into(), serde_json::json!({})));
    }

    #[test]
    fn the_ext_frame_round_trips_and_an_old_phone_skips_it() {
        let msg = ServerMsg::Ext { pty_id: "p".into(), method: "_flowcode/delegate".into(), params: serde_json::json!({ "taskId": "t" }) };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(json, r#"{"t":"ext","ptyId":"p","method":"_flowcode/delegate","params":{"taskId":"t"}}"#);
        assert_eq!(serde_json::from_str::<ServerMsg>(&json).unwrap(), msg);
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
        let raw = line.repeat(24_000);
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
