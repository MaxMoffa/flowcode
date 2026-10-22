//! A short in-memory history of connection events (dial, handshake, backoff,
//! why a link closed), for the diagnostics list in Settings. Free of Tauri so
//! `link` can write to it too.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// How many events are kept; older ones fall off.
pub const CAPACITY: usize = 100;

/// Start of the one line kept up to date with the link's quality (path, round
/// trip, rates); the diagnostics screen shows it at the top.
pub const METRICS_PREFIX: &str = "link: ";

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

    /// Records the link's quality, replacing the previous such line instead of
    /// adding one, so a metric refreshed every few seconds doesn't push the
    /// connection events out of the list.
    pub fn push_metrics(&self, line: &str) {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = entries.iter().rposition(|e| e.text.starts_with(METRICS_PREFIX)) {
            entries.remove(old);
        }
        if entries.len() >= CAPACITY {
            entries.pop_front();
        }
        entries.push_back(Entry { at, text: format!("{METRICS_PREFIX}{line}") });
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

    #[test]
    fn metrics_replace_their_previous_line() {
        let log = ConnLog::default();
        log.push("dial ok");
        log.push_metrics("direct 20 ms");
        log.push("path changed");
        log.push_metrics("direct 18 ms");
        let all: Vec<_> = log.snapshot().into_iter().map(|e| e.text).collect();
        assert_eq!(all, ["dial ok", "path changed", "link: direct 18 ms"]);
    }
}
