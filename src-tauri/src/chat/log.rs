//! A chat's numbered event log.

use super::*;

/// The text of a streamed agent message or thought chunk, with what another
/// chunk must share to be merged with it: its `sessionUpdate` kind and its
/// `messageId` (if the agent sends one). `None` for any other update.
pub(super) fn text_chunk(update: &Value) -> Option<(&str, Option<&Value>, &str)> {
    let kind = update.get("sessionUpdate")?.as_str()?;
    if kind != "agent_message_chunk" && kind != "agent_thought_chunk" {
        return None;
    }
    let content = update.get("content")?;
    if content.get("type")?.as_str()? != "text" {
        return None;
    }
    let text = content.get("text")?.as_str()?;
    Some((kind, update.get("messageId").filter(|id| !id.is_null()), text))
}

/// Roughly how many bytes a JSON value takes: its strings and keys, plus a
/// little for the rest. Cheaper than serializing it, and enough for a cap.
pub(super) fn approx_size(value: &Value) -> usize {
    match value {
        Value::String(s) => s.len() + 2,
        Value::Array(items) => 2 + items.iter().map(approx_size).sum::<usize>(),
        Value::Object(map) => 2 + map.iter().map(|(k, v)| k.len() + 4 + approx_size(v)).sum::<usize>(),
        _ => 8,
    }
}

/// `approx_size` of an event, with its envelope.
pub(super) fn body_size(body: &ChatBody) -> usize {
    64 + match body {
        ChatBody::Update { update } => approx_size(update),
        ChatBody::User { text, images, .. } => text.len() + images.iter().map(|i| i.name.len() + i.mime_type.len() + i.id.len()).sum::<usize>(),
        ChatBody::Permission { request_id, tool_call, options } => {
            approx_size(request_id) + approx_size(tool_call) + approx_size(options)
        }
        ChatBody::PermissionResolved { request_id, option_id } => {
            approx_size(request_id) + option_id.as_ref().map_or(0, String::len)
        }
        ChatBody::Ask { request_id, message, schema, tool_call_id } => {
            approx_size(request_id) + message.len() + approx_size(schema) + tool_call_id.as_ref().map_or(0, String::len)
        }
        ChatBody::AskResolved { request_id, action, content } => {
            approx_size(request_id) + action.len() + content.as_ref().map_or(0, approx_size)
        }
        ChatBody::TurnEnd { stop_reason } => stop_reason.len(),
        ChatBody::Error { message, .. } => message.len(),
        ChatBody::Exit { .. } => 0,
        ChatBody::Ext { method, params } => method.len() + approx_size(params),
    }
}

/// One entry of a chat's log. Agents stream a message a few tokens per
/// `session/update`, so the text chunks of one message (or thought) are merged
/// into a single entry - otherwise a long chat would spend `MAX_LOG_EVENTS` on
/// tokens and lose its start. Only the log merges: the live feed and the
/// window still get every chunk as its own event.
///
/// A merged entry carries the `seq` (and `at`) of its last chunk, so anyone
/// replaying from before it gets the whole text. Someone who already saw part
/// of the run live (its `after_seq` falls inside the run) must get only the
/// rest, or it would show that text twice: `offsets` remember where each
/// chunk's text starts, and `since` slices from the first chunk not yet seen.
pub(super) struct LogEntry {
    pub(super) event: ChatEvent,
    /// `seq` of the first chunk in this entry; `event.seq` is the last one's,
    /// and the chunks in between have every `seq` in between (only the last
    /// entry takes merges, and only from the very next event).
    pub(super) first_seq: u64,
    /// Byte offset in the merged text at which each chunk starts, in `seq`
    /// order. Empty for an entry that isn't a text chunk: it never merges.
    pub(super) offsets: Vec<usize>,
    /// `body_size`, grown with each merge - what `Log::bytes` counts.
    pub(super) size: usize,
    /// Its large tool payloads were already shrunk (`Log::compact`).
    pub(super) compacted: bool,
}

/// Entries at the end of the log that compaction never touches.
pub(super) const COMPACT_KEEP_RECENT: usize = 200;
/// A string longer than this inside an old tool call is truncated...
pub(super) const COMPACT_STRING_LIMIT: usize = 16 * 1024;
/// ...down to this many bytes (plus the marker).
pub(super) const COMPACT_STRING_KEEP: usize = 2 * 1024;

/// Truncates every string over `COMPACT_STRING_LIMIT` in `value` (image data
/// excepted: cut base64 would not decode). Returns the approximate bytes freed.
pub(super) fn shrink_strings(value: &mut Value) -> usize {
    match value {
        Value::String(s) if s.len() > COMPACT_STRING_LIMIT => {
            let total = s.len();
            let mut cut = COMPACT_STRING_KEEP;
            while !s.is_char_boundary(cut) {
                cut -= 1;
            }
            s.truncate(cut);
            s.push_str(&format!("
… [truncated by Flowcode, {total} bytes]"));
            total - s.len()
        }
        Value::Array(items) => items.iter_mut().map(shrink_strings).sum(),
        Value::Object(map) => {
            let is_image = map.get("type").and_then(Value::as_str) == Some("image");
            map.iter_mut().filter(|(k, _)| !(is_image && k.as_str() == "data")).map(|(_, v)| shrink_strings(v)).sum()
        }
        _ => 0,
    }
}

impl LogEntry {
    pub(super) fn new(event: ChatEvent) -> Self {
        let offsets = match &event.body {
            ChatBody::Update { update } if text_chunk(update).is_some() => vec![0],
            _ => Vec::new(),
        };
        LogEntry { first_seq: event.seq, size: body_size(&event.body), offsets, compacted: false, event }
    }

    /// Merges `next` into this entry if both are text chunks of the same
    /// message and `next` directly follows; returns the bytes added.
    pub(super) fn absorb(&mut self, next: &ChatEvent) -> Option<usize> {
        if self.offsets.is_empty() || next.seq != self.event.seq + 1 {
            return None;
        }
        let ChatBody::Update { update: next_update } = &next.body else { return None };
        let (kind, message_id, text) = text_chunk(next_update)?;
        let ChatBody::Update { update } = &mut self.event.body else { return None };
        if !matches!(text_chunk(update), Some((k, id, _)) if k == kind && id == message_id) {
            return None;
        }
        // A subagent's text (stamped with its launch call) never merges into another's or the main agent's.
        let parent = |u: &Value| u.pointer("/_meta/claudeCode/parentToolUseId").and_then(Value::as_str).map(str::to_owned);
        if parent(update) != parent(next_update) {
            return None;
        }
        let Some(Value::String(merged)) = update.pointer_mut("/content/text") else { return None };
        self.offsets.push(merged.len());
        merged.push_str(text);
        self.event.seq = next.seq;
        self.event.at = next.at;
        self.size += text.len();
        Some(text.len())
    }

    /// This entry for someone who has seen every event up to `after_seq`
    /// (which is below `event.seq`): whole, or only the text of the chunks
    /// after `after_seq` if that falls inside the merged run.
    pub(super) fn since(&self, after_seq: u64) -> ChatEvent {
        let mut event = self.event.clone();
        if after_seq < self.first_seq || after_seq >= self.event.seq {
            return event;
        }
        let Some(&offset) = usize::try_from(after_seq - self.first_seq + 1).ok().and_then(|i| self.offsets.get(i)) else {
            return event;
        };
        if let ChatBody::Update { update } = &mut event.body {
            if let Some(Value::String(text)) = update.pointer_mut("/content/text") {
                // Always a boundary: each offset is where a whole chunk began.
                if text.is_char_boundary(offset) {
                    text.drain(..offset);
                }
            }
        }
        event
    }
}

/// A chat's numbered events, as `chat_events` and the phones replay them.
pub(super) struct Log {
    /// The last `seq` given out: never reused, even after `reset`.
    pub(super) seq: u64,
    pub(super) events: VecDeque<LogEntry>,
    /// Sum of the entries' `size`.
    pub(super) bytes: usize,
    pub(super) max_events: usize,
    pub(super) max_bytes: usize,
    /// `bytes` at which the next automatic `compact` runs.
    compact_at: usize,
}

impl Log {
    pub(super) fn new(max_events: usize, max_bytes: usize) -> Self {
        Log { seq: 0, events: VecDeque::new(), bytes: 0, max_events, max_bytes, compact_at: max_bytes / 2 }
    }

    /// Shrinks the large strings of tool calls (and their updates) older than
    /// the last `COMPACT_KEEP_RECENT` entries. `seq`s, order and event kinds
    /// stay; the payloads stay valid JSON, just shorter, ending in a marker.
    /// Returns the bytes freed.
    pub(super) fn compact(&mut self) -> usize {
        let end = self.events.len().saturating_sub(COMPACT_KEEP_RECENT);
        let mut freed = 0;
        for entry in self.events.iter_mut().take(end).filter(|e| !e.compacted) {
            entry.compacted = true;
            let ChatBody::Update { update } = &mut entry.event.body else { continue };
            if !matches!(update.get("sessionUpdate").and_then(Value::as_str), Some("tool_call" | "tool_call_update")) {
                continue;
            }
            let saved = shrink_strings(update).min(entry.size);
            entry.size -= saved;
            freed += saved;
        }
        self.bytes = self.bytes.saturating_sub(freed);
        freed
    }

    /// Numbers `body` and records it, dropping the oldest entries past the
    /// caps (always keeping the newest). Returns the event as it happened -
    /// what the live feed carries - even when the log merged it.
    pub(super) fn push(&mut self, body: ChatBody, at: u64) -> ChatEvent {
        self.seq += 1;
        let event = ChatEvent { seq: self.seq, at, body };
        match self.events.back_mut().and_then(|last| last.absorb(&event)) {
            Some(added) => self.bytes += added,
            None => {
                let entry = LogEntry::new(event.clone());
                self.bytes += entry.size;
                self.events.push_back(entry);
            }
        }
        // Old tool output shrinks before whole events are dropped, and once
        // the chat is over nobody streams into it again.
        if matches!(event.body, ChatBody::Exit { .. }) || self.bytes >= self.compact_at {
            self.compact();
            self.compact_at = (self.max_bytes / 2).max(self.bytes + self.max_bytes / 8);
        }
        while self.events.len() > self.max_events || (self.bytes > self.max_bytes && self.events.len() > 1) {
            let Some(dropped) = self.events.pop_front() else { break };
            self.bytes = self.bytes.saturating_sub(dropped.size);
        }
        event
    }

    /// What someone who has seen every event up to `after_seq` is missing
    /// (`LogEntry::since`: nothing it saw comes back).
    pub(super) fn after(&self, after_seq: u64) -> Vec<ChatEvent> {
        // Entries are in `seq` order: a merge only ever raises the last one's.
        let start = self.events.partition_point(|e| e.event.seq <= after_seq);
        self.events.range(start..).map(|e| e.since(after_seq)).collect()
    }

    /// Forgets every event but keeps counting from the last `seq`, so the
    /// numbering stays strictly increasing for anyone who saw some.
    pub(super) fn reset(&mut self) {
        self.events.clear();
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(kind: &str, text: &str) -> ChatBody {
        ChatBody::Update { update: json!({ "sessionUpdate": kind, "content": { "type": "text", "text": text } }) }
    }

    fn chunk_with_id(text: &str, id: &str) -> ChatBody {
        ChatBody::Update {
            update: json!({ "sessionUpdate": "agent_message_chunk", "messageId": id, "content": { "type": "text", "text": text } }),
        }
    }

    /// (seq, text) of each event: a chunk's text or a user message.
    fn summary(events: &[ChatEvent]) -> Vec<(u64, String)> {
        events
            .iter()
            .map(|e| {
                let text = match &e.body {
                    ChatBody::Update { update } => update["content"]["text"].as_str().unwrap_or("").to_string(),
                    ChatBody::User { text, .. } => text.clone(),
                    _ => String::new(),
                };
                (e.seq, text)
            })
            .collect()
    }

    fn big_log() -> Log {
        Log::new(MAX_LOG_EVENTS, MAX_LOG_BYTES)
    }

    #[test]
    fn recognizes_text_chunks() {
        let thought = json!({
            "sessionUpdate": "agent_thought_chunk", "messageId": "m", "content": { "type": "text", "text": "hm" }
        });
        let (kind, id, text) = text_chunk(&thought).unwrap();
        assert_eq!((kind, id, text), ("agent_thought_chunk", Some(&json!("m")), "hm"));
        let no_id =
            json!({ "sessionUpdate": "agent_message_chunk", "messageId": null, "content": { "type": "text", "text": "a" } });
        assert_eq!(text_chunk(&no_id).unwrap().1, None);
        let user = json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "a" } });
        assert!(text_chunk(&user).is_none());
        let image = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image", "data": "" } });
        assert!(text_chunk(&image).is_none());
        assert!(text_chunk(&json!({ "sessionUpdate": "tool_call" })).is_none());
    }

    #[test]
    fn the_log_merges_a_streamed_message_but_the_feed_gets_every_chunk() {
        let mut log = big_log();
        let user = log.push(ChatBody::User { text: "q".into(), attachments: Vec::new(), images: Vec::new() }, 1);
        let live: Vec<ChatEvent> = ["Hel", "lo ", "wörld"]
            .iter()
            .enumerate()
            .map(|(i, t)| log.push(chunk("agent_message_chunk", t), 10 + i as u64))
            .collect();
        assert_eq!(user.seq, 1);
        assert_eq!(summary(&live), vec![(2, "Hel".into()), (3, "lo ".into()), (4, "wörld".into())]);
        assert_eq!(log.events.len(), 2);
        let replay = log.after(0);
        assert_eq!(summary(&replay), vec![(1, "q".into()), (4, "Hello wörld".into())]);
        // The merged entry carries its last chunk's time.
        assert_eq!(replay[1].at, 12);
    }

    #[test]
    fn subagent_chunks_do_not_merge_with_other_streams() {
        let mut log = big_log();
        let sub = |text: &str, parent: &str| ChatBody::Update {
            update: json!({
                "sessionUpdate": "agent_message_chunk",
                "_meta": { "claudeCode": { "parentToolUseId": parent } },
                "content": { "type": "text", "text": text }
            }),
        };
        log.push(chunk("agent_message_chunk", "main "), 0); // 1
        log.push(sub("a1 ", "A"), 0); // 2: another stream
        log.push(sub("a2", "A"), 0); // 3: merges into 2
        log.push(sub("b", "B"), 0); // 4: another subagent
        log.push(chunk("agent_message_chunk", "main2"), 0); // 5
        assert_eq!(
            summary(&log.after(0)),
            vec![(1, "main ".into()), (3, "a1 a2".into()), (4, "b".into()), (5, "main2".into())]
        );
    }

    #[test]
    fn a_replay_from_inside_a_merged_run_gets_only_the_rest() {
        let mut log = big_log();
        log.push(ChatBody::User { text: "q".into(), attachments: Vec::new(), images: Vec::new() }, 0);
        for t in ["a", "bé", "c", "d"] {
            log.push(chunk("agent_message_chunk", t), 0); // seqs 2..=5
        }
        // Saw only the user's message: the whole run.
        assert_eq!(summary(&log.after(1)), vec![(5, "abécd".into())]);
        // Saw the first chunk live.
        assert_eq!(summary(&log.after(2)), vec![(5, "bécd".into())]);
        // Saw up to the third.
        assert_eq!(summary(&log.after(4)), vec![(5, "d".into())]);
        // Saw everything.
        assert!(log.after(5).is_empty());
        // The run grows after someone saw all of it: they get just the new text.
        log.push(chunk("agent_message_chunk", "e"), 0);
        assert_eq!(summary(&log.after(5)), vec![(6, "e".into())]);
        // The entry itself is untouched by the slicing.
        assert_eq!(summary(&log.after(0)), vec![(1, "q".into()), (6, "abécde".into())]);
    }

    #[test]
    fn only_chunks_of_the_same_message_merge() {
        let mut log = big_log();
        log.push(chunk("agent_thought_chunk", "think"), 0); // 1
        log.push(chunk("agent_message_chunk", "say"), 0); // 2: another kind
        log.push(chunk("agent_message_chunk", " more"), 0); // 3: merges into 2
        log.push(ChatBody::Update { update: json!({ "sessionUpdate": "tool_call", "toolCallId": "t" }) }, 0); // 4
        log.push(chunk("agent_message_chunk", "after"), 0); // 5: the tool call broke the run
        log.push(chunk_with_id("x", "m1"), 0); // 6: an id the last one lacks
        log.push(chunk_with_id("y", "m1"), 0); // 7: same id, merges
        log.push(chunk_with_id("z", "m2"), 0); // 8: another message
        let image = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "image", "data": "" } });
        log.push(ChatBody::Update { update: image }, 0); // 9: not text
        log.push(chunk("agent_message_chunk", "end"), 0); // 10
        assert_eq!(
            summary(&log.after(0)),
            vec![
                (1, "think".into()),
                (3, "say more".into()),
                (4, String::new()),
                (5, "after".into()),
                (7, "xy".into()),
                (8, "z".into()),
                (9, String::new()),
                (10, "end".into()),
            ]
        );
        // From inside the id'd run, and from just before a single entry.
        assert_eq!(
            summary(&log.after(6)),
            vec![(7, "y".into()), (8, "z".into()), (9, String::new()), (10, "end".into())]
        );
        assert_eq!(summary(&log.after(9)), vec![(10, "end".into())]);
    }

    #[test]
    fn the_log_drops_its_oldest_past_the_caps() {
        let mut log = Log::new(3, MAX_LOG_BYTES);
        for n in 1..=5 {
            log.push(ChatBody::User { text: n.to_string(), attachments: Vec::new(), images: Vec::new() }, 0);
        }
        assert_eq!(summary(&log.after(0)), vec![(3, "3".into()), (4, "4".into()), (5, "5".into())]);

        // By bytes: each of these is 64 + 100 bytes, room for two.
        let mut log = Log::new(100, 400);
        for n in 1..=4u8 {
            log.push(ChatBody::User { text: n.to_string().repeat(100), attachments: Vec::new(), images: Vec::new() }, 0);
        }
        assert_eq!(log.after(0).iter().map(|e| e.seq).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(log.bytes, log.events.iter().map(|e| e.size).sum::<usize>());

        // A merged run counts its whole text against the cap.
        let mut log = Log::new(100, 400);
        log.push(ChatBody::User { text: "q".into(), attachments: Vec::new(), images: Vec::new() }, 0);
        for _ in 0..10 {
            log.push(chunk("agent_message_chunk", &"x".repeat(50)), 0);
        }
        assert_eq!(log.events.len(), 1, "the user message goes, the newest entry stays");
        assert_eq!(log.after(0)[0].seq, 11);
        assert_eq!(log.bytes, log.events.iter().map(|e| e.size).sum::<usize>());

        // The newest entry is kept even when alone over the cap.
        let mut log = Log::new(100, 10);
        log.push(ChatBody::User { text: "y".repeat(1000), attachments: Vec::new(), images: Vec::new() }, 0);
        assert_eq!(log.events.len(), 1);
    }

    #[test]
    fn a_reset_log_keeps_counting() {
        let mut log = big_log();
        log.push(chunk("agent_message_chunk", "old history"), 0);
        log.push(ChatBody::User { text: "old".into(), attachments: Vec::new(), images: Vec::new() }, 0);
        log.reset();
        assert!(log.after(0).is_empty());
        assert_eq!(log.bytes, 0);
        let next = log.push(chunk("agent_message_chunk", "new"), 0);
        assert_eq!(next.seq, 3);
        assert_eq!(summary(&log.after(0)), vec![(3, "new".into())]);
    }

    fn tool_output(id: &str, len: usize) -> ChatBody {
        ChatBody::Update {
            update: json!({
                "sessionUpdate": "tool_call_update", "toolCallId": id,
                "rawOutput": "é".repeat(len / 2),
                "content": [{ "type": "content", "content": { "type": "text", "text": "x".repeat(len) } }]
            }),
        }
    }

    #[test]
    fn compaction_shrinks_old_tool_output_and_keeps_seqs() {
        let mut log = big_log();
        for n in 0..300 {
            log.push(tool_output(&format!("t{n}"), 40_000), 0);
        }
        let before = log.bytes;
        let seqs: Vec<u64> = log.after(0).iter().map(|e| e.seq).collect();
        let freed = log.compact();
        assert!(freed > 0 && log.bytes == before - freed);
        assert_eq!(log.bytes, log.events.iter().map(|e| e.size).sum::<usize>());
        let after = log.after(0);
        assert_eq!(after.iter().map(|e| e.seq).collect::<Vec<_>>(), seqs);
        let text = |e: &ChatEvent| match &e.body {
            ChatBody::Update { update } => update["content"][0]["content"]["text"].as_str().unwrap().to_string(),
            _ => unreachable!(),
        };
        assert!(text(&after[0]).len() < 3000 && text(&after[0]).ends_with("[truncated by Flowcode, 40000 bytes]"));
        assert!(serde_json::to_string(&after[0]).is_ok());
        // The last COMPACT_KEEP_RECENT entries are intact.
        assert_eq!(text(&after[299]).len(), 40_000);
        assert_eq!(text(&after[300 - COMPACT_KEEP_RECENT]).len(), 40_000);
        assert!(text(&after[300 - COMPACT_KEEP_RECENT - 1]).len() < 3000);
        // Idempotent.
        assert_eq!(log.compact(), 0);
    }

    #[test]
    fn compaction_runs_on_exit_and_spares_messages_and_images() {
        let mut log = big_log();
        log.push(chunk("agent_message_chunk", &"m".repeat(40_000)), 0);
        let img = json!({ "sessionUpdate": "tool_call_update", "content": [{ "type": "image", "data": "A".repeat(40_000) }] });
        log.push(ChatBody::Update { update: img }, 0);
        for n in 0..COMPACT_KEEP_RECENT {
            log.push(tool_output(&format!("t{n}"), 20_000), 0);
        }
        let before = log.bytes;
        log.push(ChatBody::Exit { code: Some(0) }, 0);
        assert!(log.bytes <= before + 64, "nothing old to shrink but the entries just past the window");
        for n in 0..10 {
            log.push(ChatBody::User { text: n.to_string(), attachments: Vec::new(), images: Vec::new() }, 0);
        }
        let all = log.after(0);
        let ChatBody::Update { update } = &all[0].body else { panic!() };
        assert_eq!(update["content"]["text"].as_str().unwrap().len(), 40_000);
        let ChatBody::Update { update } = &all[1].body else { panic!() };
        assert_eq!(update["content"][0]["data"].as_str().unwrap().len(), 40_000);
    }

    #[test]
    fn compaction_triggers_at_half_the_byte_cap() {
        // 600 x ~40 KB would be 24 MB: over the 16 MiB cap without compaction.
        let mut log = Log::new(10_000, 16 * 1024 * 1024);
        for n in 0..600 {
            log.push(tool_output(&format!("t{n}"), 20_000), 0);
        }
        assert_eq!(log.events.len(), 600, "shrunk before anything was dropped");
        assert!(log.bytes < 16 * 1024 * 1024, "bytes {}", log.bytes);
    }

    #[test]
    fn json_sizes_are_approximated() {
        assert_eq!(approx_size(&json!("abc")), 5);
        assert_eq!(approx_size(&json!({ "k": "v" })), 2 + 1 + 4 + 3);
        assert_eq!(approx_size(&json!([1, null])), 2 + 8 + 8);
        assert!(body_size(&ChatBody::User { text: "x".repeat(1000), attachments: Vec::new(), images: Vec::new() }) >= 1000);
    }
}
