//! One line per connection event, to stderr and a small rotating file.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::util::{lock, now_ms};

/// `remote.log` is rotated (to `remote.log.old`) once it grows past this.
pub(super) const LOG_CAP_BYTES: u64 = 256 * 1024;

/// `YYYY-MM-DD HH:MM:SS.mmm` (UTC) for a Unix time in milliseconds.
fn format_utc(ms: u64) -> String {
    let (secs, millis) = (ms / 1000, ms % 1000);
    let (days, rem) = ((secs / 86_400) as i64, secs % 86_400);
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}.{millis:03}", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// Appends `line` to `path`; a file already past `cap` bytes first becomes
/// `<path>.old` (replacing the previous one), so the log never exceeds ~2x cap.
fn append_capped(path: &Path, line: &str, cap: u64) {
    use std::io::Write;
    if std::fs::metadata(path).is_ok_and(|m| m.len() >= cap) {
        let mut old = path.as_os_str().to_owned();
        old.push(".old");
        let _ = std::fs::rename(path, old);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// One line per connection event, to stderr (the `tauri dev` console) and a
/// small rotating file. Best effort: logging never fails a connection.
pub(super) struct ConnLog {
    path: PathBuf,
    /// Keeps lines from two threads from interleaving or racing a rotation.
    write: Mutex<()>,
}

impl ConnLog {
    pub(super) fn new(path: PathBuf) -> Self {
        ConnLog { path, write: Mutex::new(()) }
    }

    pub(super) fn line(&self, text: &str) {
        let line = format!("{} {text}", format_utc(now_ms()));
        eprintln!("remote: {line}");
        let _held = lock(&self.write);
        append_capped(&self.path, &line, LOG_CAP_BYTES);
    }
}

/// The first characters of a node id: enough to tell phones apart in a log.
pub(super) fn short_id(node_id: &str) -> &str {
    node_id.get(..10).unwrap_or(node_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_timestamps_are_formatted() {
        assert_eq!(format_utc(0), "1970-01-01 00:00:00.000");
        assert_eq!(format_utc(1_709_210_096_789), "2024-02-29 12:34:56.789");
    }

    #[test]
    fn log_file_rotates_past_its_cap() {
        let dir = std::env::temp_dir().join(format!("flowcode-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("remote.log");
        let _ = std::fs::remove_file(&path);
        for i in 0..20 {
            append_capped(&path, &format!("line {i:02} xxxxxxxxxx"), 100);
        }
        let current = std::fs::read_to_string(&path).unwrap();
        let old = std::fs::read_to_string(dir.join("remote.log.old")).unwrap();
        assert!(current.len() < 200 && old.len() < 200);
        assert!(current.contains("line 19"));
        assert!(!old.contains("line 19"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn short_id_never_panics() {
        assert_eq!(short_id("abc"), "abc");
        assert_eq!(short_id("0123456789abcdef"), "0123456789");
    }
}
