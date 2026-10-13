//! A short in-memory history of connection events (dial, handshake, backoff,
//! why a link closed), for the diagnostics list in Settings. Free of Tauri so
//! `link` can write to it too.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// How many events are kept; older ones fall off.
pub const CAPACITY: usize = 100;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// Unix ms.
    pub at: u64,
    pub text: String,
}

#[derive(Default)]
pub struct ConnLog {
    entries: Mutex<VecDeque<Entry>>,
}

impl ConnLog {
    pub fn push(&self, text: impl Into<String>) {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if entries.len() >= CAPACITY {
            entries.pop_front();
        }
        entries.push_back(Entry { at, text: text.into() });
    }

    /// Oldest first.
    pub fn snapshot(&self) -> Vec<Entry> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner()).iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_the_latest_events() {
        let log = ConnLog::default();
        for i in 0..CAPACITY + 5 {
            log.push(format!("event {i}"));
        }
        let all = log.snapshot();
        assert_eq!(all.len(), CAPACITY);
        assert_eq!(all[0].text, "event 5");
        assert_eq!(all[CAPACITY - 1].text, format!("event {}", CAPACITY + 4));
    }
}
