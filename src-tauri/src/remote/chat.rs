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

/// Most JSON bytes of one event: what is left of a frame once the `chatevents`
/// envelope (type, chat id, replay flag) is taken out. A chat log line can be
/// 16 MiB but a frame is at most `MAX_FRAME`, and a frame too big would be
/// dropped by the writer while the cursor moves past it: the event would be
/// lost for good. So a bigger event is shrunk (see `shrink_event`).
const MAX_EVENT_BYTES: usize = proto::MAX_FRAME - 64 * 1024;
/// Strings shorter than this are not worth cutting.
const MIN_CUT_STRING: usize = 256;

fn json_size(value: &Value) -> usize {
    let mut size = ByteCount(0);
    let _ = serde_json::to_writer(&mut size, value);
    size.0
}

enum Seg {
    Key(String),
    Idx(usize),
}

/// Finds the longest string (and, if `want_array`, the longest array instead)
/// in the tree, as a path.
fn find_longest(value: &Value, path: &mut Vec<Seg>, best: &mut (usize, Vec<Seg>), arrays: bool) {
    match value {
        Value::String(s) if !arrays && s.len() > best.0 => {
            *best = (s.len(), path.iter().map(|p| match p {
                Seg::Key(k) => Seg::Key(k.clone()),
                Seg::Idx(i) => Seg::Idx(*i),
            }).collect());
        }
        Value::Array(items) => {
            if arrays && items.len() > best.0 {
                *best = (items.len(), path.iter().map(|p| match p {
                    Seg::Key(k) => Seg::Key(k.clone()),
                    Seg::Idx(i) => Seg::Idx(*i),
                }).collect());
            }
            for (i, item) in items.iter().enumerate() {
                path.push(Seg::Idx(i));
                find_longest(item, path, best, arrays);
                path.pop();
            }
        }
        Value::Object(map) => {
            for (k, item) in map {
                path.push(Seg::Key(k.clone()));
                find_longest(item, path, best, arrays);
                path.pop();
            }
        }
        _ => {}
    }
}

fn at_mut<'a>(mut value: &'a mut Value, path: &[Seg]) -> Option<&'a mut Value> {
    for seg in path {
        value = match seg {
            Seg::Key(k) => value.get_mut(k.as_str())?,
            Seg::Idx(i) => value.get_mut(*i)?,
        };
    }
    Some(value)
}

/// Makes `value` serialize to at most `max` bytes, keeping its structure (seq,
/// timestamps, kinds, ids, statuses): it cuts the longest strings, each at a
/// char boundary, leaving a `… [truncated, N KB]` marker. A string under a
/// `data` key (base64 of an image or file) is emptied to the marker instead of
/// cut, so no broken base64 is left. If strings alone cannot make it fit (a
/// huge array of small items), the longest array loses its tail. The work is
/// bounded: cuts are sized from the excess, and the tree is re-serialized only
/// a few times, never once per cut.
fn shrink_event(value: &mut Value, max: usize) {
    for round in 0..16u32 {
        let mut excess = json_size(value).saturating_sub(max);
        if excess == 0 {
            return;
        }
        // Escapes make the serialized form bigger than the string: later
        // rounds cut with a growing margin.
        excess += excess * round as usize / 2 + 1024;
        while excess > 0 {
            let mut best = (MIN_CUT_STRING, Vec::new());
            find_longest(value, &mut Vec::new(), &mut best, false);
            let (len, path) = best;
            let Some(target) = (len > MIN_CUT_STRING).then(|| at_mut(value, &path)).flatten() else { break };
            let is_data = matches!(path.last(), Some(Seg::Key(k)) if k == "data") && len > 1024;
            let Value::String(s) = target else { break };
            // Serialized bytes per string byte (escapes make it more than 1).
            let mut ser = ByteCount(0);
            let _ = serde_json::to_writer(&mut ser, s.as_str());
            let ser = ser.0.saturating_sub(2).max(len);
            let need = (excess as u128 * len as u128 / ser as u128) as usize + 64;
            let keep = if is_data { 0 } else { len.saturating_sub(need) };
            let mut cut = keep;
            while !s.is_char_boundary(cut) {
                cut -= 1;
            }
            let dropped = len - cut;
            s.truncate(cut);
            let marker = format!("… [truncated, {} KB]", dropped / 1024);
            s.push_str(&marker);
            let freed = (dropped as u128 * ser as u128 / len as u128) as usize;
            excess = excess.saturating_sub(freed.saturating_sub(marker.len()));
        }
        if excess > 0 {
            // No string left worth cutting: drop the tail of the longest array.
            let mut best = (1, Vec::new());
            find_longest(value, &mut Vec::new(), &mut best, true);
            let (len, path) = best;
            match at_mut(value, &path) {
                Some(Value::Array(items)) if len > 1 => items.truncate(len / 2),
                _ => return,
            }
        }
    }
}

/// Splits events into the groups that each go in one message, in order.
fn chunk_events(events: &[ChatEvent]) -> Vec<Vec<Value>> {
    let mut chunks = Vec::new();
    let mut current: Vec<Value> = Vec::new();
    let mut bytes = 0;
    for event in events {
        let Ok(mut value) = serde_json::to_value(event) else { continue };
        let mut size = ByteCount(json_size(&value));
        if size.0 > MAX_EVENT_BYTES {
            shrink_event(&mut value, MAX_EVENT_BYTES);
            size = ByteCount(json_size(&value));
        }
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

/// Where an answer's events go: a `chatevents` message (live or replay), or a
/// `chatolder` page.
#[derive(Clone, Copy)]
enum Dest {
    Live,
    /// A replay; with the page info of a `paged` open (`has_more`, `first_seq`).
    Replay(Option<(bool, u64)>),
    Older(bool, u64),
}

/// Serializes `events` off the async threads when there are many.
async fn chunked(events: Vec<ChatEvent>) -> Option<Vec<Vec<Value>>> {
    if events.len() > MAX_EVENTS {
        crate::blocking(move || Ok(chunk_events(&events))).await.ok()
    } else {
        Some(chunk_events(&events))
    }
}

/// Queues `events` as `chatevents` messages (or a `chatolder` page). A replay
/// or a page always sends one, even empty, so the phone knows it is up to
/// date. False when the connection is gone.
async fn send_events(out: &mpsc::Sender<ServerMsg>, chat_id: &str, events: Vec<ChatEvent>, dest: Dest) -> bool {
    if events.is_empty() && matches!(dest, Dest::Live) {
        return true;
    }
    // A replay can be the whole log: serializing it is not for the async threads.
    let Some(mut chunks) = chunked(events).await else { return true };
    if chunks.is_empty() {
        chunks.push(Vec::new());
    }
    let count = chunks.len();
    for (i, events) in chunks.into_iter().enumerate() {
        let partial = i + 1 < count;
        let chat_id = chat_id.to_string();
        let msg = match dest {
            Dest::Live => ServerMsg::ChatEvents { chat_id, events, replay: false, partial: false, has_more: None, first_seq: None },
            Dest::Replay(page) => ServerMsg::ChatEvents { chat_id, events, replay: true, partial, has_more: page.map(|p| p.0), first_seq: page.map(|p| p.1) },
            Dest::Older(has_more, first_seq) => ServerMsg::ChatOlder { chat_id, events, partial, has_more, first_seq },
        };
        if out.send(msg).await.is_err() {
            return false;
        }
    }
    true
}

/// Answers `chatolder`: the page of the log before `before_seq`.
pub(super) async fn send_older(shared: Arc<Shared>, chat_id: String, before_seq: u64, out: mpsc::Sender<ServerMsg>) {
    let found = {
        let app = shared.app.clone();
        let id = chat_id.clone();
        crate::blocking(move || crate::chat::older_page(&app.state::<ChatState>(), &id, before_seq)).await
    };
    // A chat closed meanwhile has nothing to page.
    let Ok((events, has_more, first_seq)) = found else { return };
    send_events(&out, &chat_id, events, Dest::Older(has_more, first_seq)).await;
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
    page: Option<(bool, u64)>,
    mut feed: broadcast::Receiver<ChatEvent>,
    out: mpsc::Sender<ServerMsg>,
    sent: Arc<AtomicU64>,
) {
    let mut last_seq = after_seq;
    let mut first = true;
    // Only the first replay is a page; a resync after lagging is a plain delta.
    let mut page = page;
    loop {
        if first || !replay.is_empty() {
            last_seq = replay.last().map_or(last_seq, |e| e.seq);
            if !send_events(&out, &chat_id, std::mem::take(&mut replay), Dest::Replay(page.take())).await {
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
        if !send_events(&out, &chat_id, batch, Dest::Live).await {
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
        "opencode" => "OpenCode",
        "cline" => "Cline",
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
        ChatEvent { seq, at: 0, body: ChatBody::User { text: text.to_string(), attachments: Vec::new(), images: Vec::new(), peer: None } }
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

    fn assert_fits(chunk: Vec<Value>) {
        let msg = ServerMsg::ChatEvents { chat_id: "c".repeat(64), events: chunk, replay: true, partial: false, has_more: None, first_seq: None };
        proto::encode_frame(&msg, false).expect("frame fits");
    }

    #[test]
    fn a_huge_event_is_truncated_to_fit_a_frame() {
        let events = vec![event(1, "a"), event(7, &"é\n".repeat(1_500_000)), event(8, "b")];
        let chunks = chunk_events(&events);
        let seqs: Vec<Vec<u64>> = chunks.iter().map(|c| c.iter().map(|e| e["seq"].as_u64().unwrap()).collect()).collect();
        let big: Vec<&Vec<Value>> = chunks.iter().filter(|c| c[0]["seq"].as_u64() == Some(7)).collect();
        assert_eq!(seqs, vec![vec![1], vec![7], vec![8]]);
        assert_eq!(big.len(), 1);
        assert_eq!(big[0].len(), 1);
        assert!(json_size(&big[0][0]) <= MAX_EVENT_BYTES);
        assert!(big[0][0].to_string().contains("[truncated,"));
        for chunk in chunks {
            assert_fits(chunk);
        }
    }

    #[test]
    fn many_medium_strings_fit_too() {
        let mut value = serde_json::json!({ "seq": 3, "kind": "tool" });
        for n in 0..40 {
            value[format!("f{n}")] = Value::String("z".repeat(64 * 1024));
        }
        value["image"] = serde_json::json!({ "data": "A".repeat(100_000), "mime": "image/png" });
        shrink_event(&mut value, MAX_EVENT_BYTES);
        assert!(json_size(&value) <= MAX_EVENT_BYTES);
        assert_eq!(value["seq"], 3);
        assert_eq!(value["kind"], "tool");
    }

    #[test]
    fn a_huge_array_loses_its_tail() {
        let mut value = serde_json::json!({ "seq": 1, "items": vec!["ab"; 600_000] });
        shrink_event(&mut value, MAX_EVENT_BYTES);
        assert!(json_size(&value) <= MAX_EVENT_BYTES);
        assert!(!value["items"].as_array().unwrap().is_empty());
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
