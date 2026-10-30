//! Following one chat on a phone: the events it missed, then the live ones.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use flowcode_remote_proto::{self as proto, ServerMsg};
use serde_json::Value;
use tauri::Manager;
use tokio::sync::broadcast::error::{RecvError, TryRecvError};
use tokio::sync::{broadcast, mpsc};

use super::Shared;
use crate::chat::{ChatEvent, ChatState};

/// Most events in one `chatevents` message.
const MAX_EVENTS: usize = 500;
/// Most JSON bytes of events in one `chatevents` message (a quarter of a
/// frame; one event bigger than that goes alone).
const MAX_EVENTS_BYTES: usize = proto::MAX_FRAME / 4;

/// The JSON size of whatever is serialized into it, without keeping it.
struct ByteCount(usize);

impl std::io::Write for ByteCount {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Splits events into the groups that each go in one message, in order.
fn chunk_events(events: &[ChatEvent]) -> Vec<Vec<Value>> {
    let mut chunks = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    let mut bytes = 0;
    for event in events {
        let Ok(value) = serde_json::to_value(event) else { continue };
        let mut size = ByteCount(0);
        let _ = serde_json::to_writer(&mut size, &value);
        if !current.is_empty() && (current.len() >= MAX_EVENTS || bytes + size.0 > MAX_EVENTS_BYTES) {
            chunks.push(std::mem::take(&mut current));
            bytes = 0;
        }
        current.push(value);
        bytes += size.0;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Queues `events` as `chatevents` messages. A replay always sends one, even
/// empty, so the phone knows it is up to date. False when the connection is
/// gone.
async fn send_events(out: &mpsc::Sender<ServerMsg>, chat_id: &str, events: Vec<ChatEvent>, replay: bool) -> bool {
    if events.is_empty() && !replay {
        return true;
    }
    // A replay can be the whole log: serializing it is not for the async threads.
    let chunks = if replay && events.len() > MAX_EVENTS {
        match crate::blocking(move || Ok(chunk_events(&events))).await {
            Ok(chunks) => chunks,
            Err(_) => return true,
        }
    } else {
        chunk_events(&events)
    };
    if chunks.is_empty() {
        let msg = ServerMsg::ChatEvents { chat_id: chat_id.to_string(), events: Vec::new(), replay };
        return out.send(msg).await.is_ok();
    }
    for events in chunks {
        let msg = ServerMsg::ChatEvents { chat_id: chat_id.to_string(), events, replay };
        if out.send(msg).await.is_err() {
            return false;
        }
    }
    true
}

/// One client's view of one chat: `replay` (what it missed, from `Chat::
/// subscribe`), then every event `feed` brings. A phone too slow for the feed
/// is brought up to date from the chat's log again, starting after the last
/// event it was sent. `sent` follows that last event, so a stream stopped
/// for the background can pick up where it was.
pub(super) async fn stream_chat(
    shared: Arc<Shared>,
    chat_id: String,
    after_seq: u64,
    mut replay: Vec<ChatEvent>,
    mut feed: broadcast::Receiver<ChatEvent>,
    out: mpsc::Sender<ServerMsg>,
    sent: Arc<AtomicU64>,
) {
    let mut last_seq = after_seq;
    let mut first = true;
    loop {
        if first || !replay.is_empty() {
            last_seq = replay.last().map_or(last_seq, |e| e.seq);
            if !send_events(&out, &chat_id, std::mem::take(&mut replay), true).await {
                return;
            }
            sent.store(last_seq, Ordering::Relaxed);
            first = false;
        }
        let mut lagged = false;
        let mut batch = match feed.recv().await {
            Ok(event) => vec![event],
            Err(RecvError::Lagged(_)) => {
                lagged = true;
                Vec::new()
            }
            Err(RecvError::Closed) => return,
        };
        // What is already waiting goes in the same message.
        while !lagged && batch.len() < MAX_EVENTS {
            match feed.try_recv() {
                Ok(event) => batch.push(event),
                Err(TryRecvError::Lagged(_)) => lagged = true,
                Err(_) => break,
            }
        }
        if lagged {
            let resynced = shared.app.state::<ChatState>().subscribe(&chat_id, last_seq);
            let Ok((past, rx)) = resynced else { return };
            (replay, feed) = (past, rx);
            continue;
        }
        batch.retain(|e| e.seq > last_seq);
        last_seq = batch.last().map_or(last_seq, |e| e.seq);
        if !send_events(&out, &chat_id, batch, false).await {
            return;
        }
        sent.store(last_seq, Ordering::Relaxed);
    }
}

/// How the agent is called in a notification.
pub(super) fn agent_name(agent: &str) -> String {
    match agent {
        "claude" => "Claude",
        "codex" => "Codex",
        "vibe" => "Vibe",
        "gemini" => "Gemini",
        other => other,
    }
    .to_string()
}

/// Raw bytes of an image in one `chatimage` message: about 256 KiB once base64
/// encoded, a quarter of a frame.
const IMAGE_CHUNK_BYTES: usize = 192 * 1024;

/// Queues an image as `chatimage` chunks, in order (an empty one is a single
/// empty chunk). False when the connection is gone.
pub(super) async fn send_image(out: &mpsc::Sender<ServerMsg>, key: &str, mime: Option<&str>, bytes: &[u8]) -> bool {
    use base64::Engine;
    let total = bytes.len() as u64;
    let mut offset = 0;
    loop {
        let end = (offset + IMAGE_CHUNK_BYTES).min(bytes.len());
        let msg = ServerMsg::ChatImage {
            key: key.to_string(),
            offset: offset as u64,
            total,
            data: base64::engine::general_purpose::STANDARD.encode(&bytes[offset..end]),
            mime: mime.map(str::to_string),
            missing: false,
        };
        if out.send(msg).await.is_err() {
            return false;
        }
        offset = end;
        if offset >= bytes.len() {
            return true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::ChatBody;

    fn event(seq: u64, text: &str) -> ChatEvent {
        ChatEvent { seq, at: 0, body: ChatBody::User { text: text.to_string(), attachments: Vec::new(), images: Vec::new() } }
    }

    #[test]
    fn events_are_split_by_count() {
        let events: Vec<ChatEvent> = (1..=1200).map(|n| event(n, "hi")).collect();
        let sizes: Vec<usize> = chunk_events(&events).iter().map(Vec::len).collect();
        assert_eq!(sizes, vec![500, 500, 200]);
        assert!(chunk_events(&[]).is_empty());
    }

    #[test]
    fn events_are_split_by_size_and_a_big_one_goes_alone() {
        let big = "x".repeat(MAX_EVENTS_BYTES / 2 + 1);
        let events = vec![event(1, &big), event(2, &big), event(3, "small"), event(4, &"y".repeat(MAX_EVENTS_BYTES * 2))];
        let chunks = chunk_events(&events);
        let seqs: Vec<Vec<u64>> =
            chunks.iter().map(|c| c.iter().map(|e| e["seq"].as_u64().unwrap()).collect()).collect();
        assert_eq!(seqs, vec![vec![1], vec![2, 3], vec![4]]);
    }

    #[test]
    fn agents_have_display_names() {
        assert_eq!(agent_name("claude"), "Claude");
        assert_eq!(agent_name("unknown"), "unknown");
    }

    #[tokio::test]
    async fn images_go_out_in_ordered_chunks() {
        use base64::Engine;
        let (tx, mut rx) = mpsc::channel(8);
        let bytes = vec![7u8; IMAGE_CHUNK_BYTES + 10];
        assert!(send_image(&tx, "k", Some("image/png"), &bytes).await);
        assert!(send_image(&tx, "e", None, &[]).await);
        drop(tx);
        let mut got = Vec::new();
        while let Some(ServerMsg::ChatImage { key, offset, total, data, mime, .. }) = rx.recv().await {
            let raw = base64::engine::general_purpose::STANDARD.decode(data).unwrap();
            got.push((key, offset, total, raw.len(), mime));
        }
        let png = Some("image/png".to_string());
        assert_eq!(
            got,
            [
                ("k".to_string(), 0, bytes.len() as u64, IMAGE_CHUNK_BYTES, png.clone()),
                ("k".to_string(), IMAGE_CHUNK_BYTES as u64, bytes.len() as u64, 10, png),
                ("e".to_string(), 0, 0, 0, None),
            ]
        );
    }
}
