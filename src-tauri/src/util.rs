//! Small helpers the agent-discovery code (agents.rs, vibe.rs, spend.rs,
//! context.rs) used to each carry a copy of.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Locks a cache mutex, ignoring poisoning: a panic in another thread while
/// it held the lock leaves a cache that is at worst stale, never one worth
/// taking every later poll down for.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn now_ms() -> u64 {
    crate::fs::system_time_to_millis(Ok(std::time::SystemTime::now())).unwrap_or(0)
}

/// A JSON value as an unsigned integer, 0 when missing or not one.
pub(crate) fn json_u64(value: Option<&serde_json::Value>) -> u64 {
    value.and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Whether `needle` occurs in `hay` - a raw-bytes pre-check, so a huge
/// transcript line isn't decoded or parsed just to find out it's irrelevant.
pub(crate) fn has_bytes(hay: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle)
}

/// Paths compared the way the OS would: separators and trailing slashes
/// aside, and case only on Windows' own (drive-letter) paths - a Linux path
/// (WSL, or on a Linux host) is case-sensitive.
pub(crate) fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.trim_end_matches(['\\', '/']).replace('\\', "/");
        if cfg!(windows) && !p.starts_with('/') { p.to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

// ---- WSL discovery ----------------------------------------------------

/// How long a failed WSL lookup is remembered before it is tried again: a
/// `wsl.exe` that was slow or not ready at launch must not disable discovery
/// until the app restarts, nor be retried on every 2-second poll.
const WSL_RETRY: Duration = Duration::from_secs(60);

type Lookups = LazyLock<Mutex<HashMap<String, (Option<String>, Instant)>>>;

/// `key`'s answer from `cache`: a found value is kept for good, a miss only
/// for `WSL_RETRY`. Held across `lookup` so concurrent callers share one
/// `wsl.exe` call instead of each starting their own.
fn cached_lookup(cache: &Lookups, key: &str, lookup: impl FnOnce() -> Option<String>) -> Option<String> {
    let mut map = lock(cache);
    if let Some((value, at)) = map.get(key) {
        if value.is_some() || at.elapsed() < WSL_RETRY {
            return value.clone();
        }
    }
    let value = lookup();
    map.insert(key.to_string(), (value.clone(), Instant::now()));
    value
}

/// The default WSL distro's name (`None` off Windows, or when WSL can't be
/// asked right now).
pub(crate) fn wsl_default_distro() -> Option<String> {
    static CACHE: Lookups = LazyLock::new(Default::default);
    if !cfg!(windows) {
        return None;
    }
    cached_lookup(&CACHE, "", crate::system::wsl_default_distro)
}

/// The home directory (a Linux path) of the default user of `distro`.
pub(crate) fn wsl_home(distro: &str) -> Option<String> {
    static CACHE: Lookups = LazyLock::new(Default::default);
    cached_lookup(&CACHE, distro, || crate::system::wsl_home_dir(distro.to_string(), None))
}

/// The default distro and its home - `None` when either is unknown.
pub(crate) fn wsl_default_home() -> Option<(String, String)> {
    let distro = wsl_default_distro()?;
    let home = wsl_home(&distro)?;
    Some((distro, home))
}

/// `\\wsl.localhost\<distro>\...` for a Linux path.
pub(crate) fn wsl_unc(distro: &str, path: &str) -> PathBuf {
    PathBuf::from(format!(r"\\wsl.localhost\{distro}{}", path.replace('/', r"\")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_dir_ignores_separators_and_trailing_slash() {
        assert!(same_dir("C:\\a\\b\\", "C:/a/b"));
        assert!(!same_dir("/a/b", "/a/c"));
        // A Linux path stays case-sensitive wherever the app runs.
        assert!(!same_dir("/home/U/p", "/home/u/p"));
    }

    #[test]
    fn misses_are_retried_but_hits_are_kept() {
        static CACHE: Lookups = LazyLock::new(Default::default);
        assert_eq!(cached_lookup(&CACHE, "a", || Some("x".into())).as_deref(), Some("x"));
        assert_eq!(cached_lookup(&CACHE, "a", || panic!("a hit is kept")).as_deref(), Some("x"));
        assert_eq!(cached_lookup(&CACHE, "b", || None), None);
        assert_eq!(cached_lookup(&CACHE, "b", || panic!("a fresh miss is kept")), None);
        // Expire the miss.
        lock(&CACHE).get_mut("b").unwrap().1 = Instant::now() - WSL_RETRY - Duration::from_secs(1);
        assert_eq!(cached_lookup(&CACHE, "b", || Some("y".into())).as_deref(), Some("y"));
    }
}
