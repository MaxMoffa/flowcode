//! The wire between a connection and the phone: write batching and the reader.

use super::*;

/// Replies that don't depend on the order of anything else and can be big:
/// they wait for interactive frames (terminal output, echoes, replies to a
/// tap) instead of delaying them. Their own order is kept.
pub(super) fn is_bulk(msg: &ServerMsg) -> bool {
    matches!(msg, ServerMsg::ViewFile { .. } | ServerMsg::LinkPreview { .. } | ServerMsg::McpIcon { .. } | ServerMsg::ChatImage { .. })
}

/// The next message to write: anything interactive in the queue first, then a
/// held bulk one, and only then a wait for more. `None` once the queue is
/// closed and nothing is held.
pub(super) async fn next_to_write(out_rx: &mut mpsc::Receiver<ServerMsg>, bulk: &mut VecDeque<ServerMsg>) -> Option<ServerMsg> {
    loop {
        if bulk.len() >= BULK_HELD {
            return bulk.pop_front();
        }
        match out_rx.try_recv() {
            Ok(msg) if is_bulk(&msg) => bulk.push_back(msg),
            Ok(msg) => return Some(msg),
            Err(mpsc::error::TryRecvError::Empty) => {
                if let Some(msg) = bulk.pop_front() {
                    return Some(msg);
                }
                match out_rx.recv().await {
                    Some(msg) if is_bulk(&msg) => bulk.push_back(msg),
                    other => return other,
                }
            }
            Err(mpsc::error::TryRecvError::Disconnected) => return bulk.pop_front(),
        }
    }
}

/// Encodes `msg` onto the end of `buf`. A message too large for a frame is
/// replaced by a note saying so, rather than leaving the phone waiting for it;
/// any other encoding error is dropped silently (serialising our own types
/// cannot fail).
pub(super) fn append_frame(buf: &mut Vec<u8>, msg: &ServerMsg, compress: bool) {
    match encode_frame(msg, compress) {
        Ok(bytes) => buf.extend_from_slice(&bytes),
        Err(FrameError::TooLarge(bytes)) => {
            let message = format!(
                "{} ({} KB)",
                tr("Messaggio troppo grande, scartato", "Message too large, dropped"),
                bytes / 1024
            );
            let note = match msg {
                ServerMsg::Fs { request_id, .. } => ServerMsg::Fs { request_id: request_id.clone(), response: None, error: Some(message) },
                ServerMsg::Git { request_id, .. } => ServerMsg::Git { request_id: request_id.clone(), result: None, error: Some(message) },
                ServerMsg::History { request_id, .. } => ServerMsg::History { request_id: request_id.clone(), result: None, error: Some(message) },
                ServerMsg::HistoryDelete { request_id, .. } => ServerMsg::HistoryDelete { request_id: request_id.clone(), result: None, error: Some(message) },
                ServerMsg::Stats { request_id, .. } => ServerMsg::Stats { request_id: request_id.clone(), result: None, error: Some(message) },
                _ => ServerMsg::Error { message, pty_id: msg_pty_id(msg), chat_id: None, fatal: false },
            };
            if let Ok(bytes) = encode_frame(&note, false) {
                buf.extend_from_slice(&bytes);
            }
        }
        Err(_) => {}
    }
}

pub(super) fn append_waiting_frames(out_rx: &mut mpsc::Receiver<ServerMsg>, bulk: &mut VecDeque<ServerMsg>, buf: &mut Vec<u8>, compress: bool) {
    // Bulk frames do not grow buf, so they need their own stop condition.
    while buf.len() < WRITE_BATCH && bulk.len() < BULK_HELD {
        match out_rx.try_recv() {
            Ok(msg) if is_bulk(&msg) => bulk.push_back(msg),
            Ok(msg) => append_frame(buf, &msg, compress),
            Err(_) => break,
        }
    }
}

/// The single writer: it owns the send half, every producer queues into the
/// channel. Frames already queued are written together in one go. Ends when
/// the channel closes (after flushing what is queued) or the link breaks.
/// Large frames are deflated once the phone has said it reads them
/// (`compress`).
pub(super) async fn write_task(mut send: SendStream, mut out_rx: mpsc::Receiver<ServerMsg>, compress: Arc<AtomicBool>) {
    let mut bulk = VecDeque::new();
    let mut buf = Vec::with_capacity(WRITE_BATCH);
    while let Some(msg) = next_to_write(&mut out_rx, &mut bulk).await {
        let compress = compress.load(Ordering::Relaxed);
        buf.clear();
        append_frame(&mut buf, &msg, compress);
        // Interactive frames that queued up meanwhile ride along; bulk ones keep waiting their turn.
        append_waiting_frames(&mut out_rx, &mut bulk, &mut buf, compress);
        if buf.is_empty() {
            continue;
        }
        if send.write_all(&buf).await.is_err() {
            break;
        }
    }
    let _ = send.finish();
    let _ = tokio::time::timeout(Duration::from_secs(2), send.stopped()).await;
}

pub(super) fn msg_pty_id(msg: &ServerMsg) -> Option<String> {
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
pub(super) async fn read_task(mut recv: RecvStream, in_tx: mpsc::Sender<ClientMsg>, out: mpsc::Sender<ServerMsg>, compress: Arc<AtomicBool>) {
    loop {
        match read_frame::<_, ClientMsg>(&mut recv).await {
            // Meant for the transport, not the connection loop.
            Ok(ClientMsg::Hello { caps }) => {
                compress.store(caps.iter().any(|c| c == "compress"), Ordering::Relaxed);
                if in_tx.try_send(ClientMsg::Hello { caps }).is_err() { break; }
            }
            Ok(msg) => {
                if in_tx.try_send(msg).is_err() {
                    break;
                }
            }
            // The frame was consumed whole: say so and carry on.
            Err(FrameError::Json(_)) => {
                let message = tr("Messaggio non valido", "Invalid message").to_string();
                let _ = out.try_send(ServerMsg::Error { message, pty_id: None, chat_id: None, fatal: false });
            }
            Err(_) => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view_file(path: &str) -> ServerMsg {
        ServerMsg::ViewFile { view_id: "v".into(), hash: "h".into(), path: path.into(), offset: 0, total: 0, data: String::new() }
    }

    #[tokio::test]
    async fn interactive_write_batch_does_not_drain_unbounded_bulk_frames() {
        let (tx, mut rx) = mpsc::channel(BULK_HELD + 10);
        for i in 0..BULK_HELD + 10 {
            tx.send(view_file(&i.to_string())).await.unwrap();
        }
        let mut bulk = VecDeque::new();
        let mut buf = Vec::new();
        append_frame(&mut buf, &ServerMsg::Pong, false);
        let first_len = buf.len();
        append_waiting_frames(&mut rx, &mut bulk, &mut buf, false);
        assert_eq!(bulk.len(), BULK_HELD);
        assert_eq!(rx.len(), 10);
        assert_eq!(buf.len(), first_len);
    }

    #[tokio::test]
    async fn bulk_replies_wait_for_interactive_frames_but_keep_their_order() {
        let (tx, mut rx) = mpsc::channel(16);
        for msg in [view_file("a"), ServerMsg::Output { pty_id: "p".into(), data: "$".into() }, view_file("b"), ServerMsg::Pong] {
            tx.send(msg).await.unwrap();
        }
        drop(tx);
        let mut bulk = VecDeque::new();
        let mut order = Vec::new();
        while let Some(msg) = next_to_write(&mut rx, &mut bulk).await {
            order.push(match msg {
                ServerMsg::Output { .. } => "output".to_string(),
                ServerMsg::Pong => "pong".to_string(),
                ServerMsg::ViewFile { path, .. } => path,
                _ => unreachable!(),
            });
        }
        assert_eq!(order, ["output", "pong", "a", "b"]);
    }

    #[tokio::test]
    async fn held_bulk_replies_are_capped_and_stay_in_order() {
        let (tx, mut rx) = mpsc::channel(256);
        let mut bulk = VecDeque::new();
        for i in 0..BULK_HELD + 3 {
            tx.send(view_file(&i.to_string())).await.unwrap();
        }
        drop(tx);
        let mut paths = Vec::new();
        while let Some(ServerMsg::ViewFile { path, .. }) = next_to_write(&mut rx, &mut bulk).await {
            assert!(bulk.len() <= BULK_HELD);
            paths.push(path);
        }
        assert_eq!(paths, (0..BULK_HELD + 3).map(|i| i.to_string()).collect::<Vec<_>>());
    }
}
