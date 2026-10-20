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

/// Decodes a hex string (either case); `None` for an odd length or any other character.
pub(crate) fn decode_hex(s: &str) -> Option<Vec<u8>> {
    let s = s.as_bytes();
    if !s.len().is_multiple_of(2) {
        return None;
    }
    s.chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            Some((hi * 16 + lo) as u8)
        })
        .collect()
}

/// A JSON value as an unsigned integer, 0 when missing or not one.
pub(crate) fn json_u64(value: Option<&serde_json::Value>) -> u64 {
    value.and_then(|v| v.as_u64()).unwrap_or(0)
}

/// Past this many entries a per-path cache is dropped and refilled - a bound,
/// not a policy: only the newest few entries are ever asked for.
const MAX_CACHED: usize = 512;

/// `map.insert`, emptying `map` first when it has grown past `MAX_CACHED`.
pub(crate) fn insert_bounded<K: std::hash::Hash + Eq, V>(map: &mut HashMap<K, V>, key: K, value: V) {
    if map.len() >= MAX_CACHED {
        map.clear();
    }
    map.insert(key, value);
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

#[derive(Default)]
struct Lookup {
    value: Option<String>,
    /// When the last run finished.
    at: Option<Instant>,
    running: bool,
}

type Lookups = LazyLock<Mutex<HashMap<String, Lookup>>>;

/// `key`'s answer from `cache`: a found value is kept for good, a miss only
/// for `WSL_RETRY`. The lock is not held across `lookup` (a `wsl.exe` call):
/// while one run is in flight other callers get the last value (none yet)
/// instead of waiting on it or starting their own.
/// Runs `F` on drop unless defused - resets an "in flight" flag when the
/// blocking call it guards panics, so the flag can't stay set forever.
pub(crate) struct OnDrop<F: FnOnce()>(Option<F>);

impl<F: FnOnce()> OnDrop<F> {
    pub(crate) fn new(f: F) -> Self {
        Self(Some(f))
    }

    /// The call returned normally: the caller resets the flag itself.
    pub(crate) fn defuse(mut self) {
        self.0 = None;
    }
}

impl<F: FnOnce()> Drop for OnDrop<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

fn cached_lookup(cache: &Lookups, key: &str, lookup: impl FnOnce() -> Option<String>) -> Option<String> {
    {
        let mut map = lock(cache);
        let entry = map.entry(key.to_string()).or_default();
        if entry.value.is_some() || entry.running || entry.at.is_some_and(|at| at.elapsed() < WSL_RETRY) {
            return entry.value.clone();
        }
        entry.running = true;
    }
    let guard = OnDrop::new(|| {
        if let Some(entry) = lock(cache).get_mut(key) {
            entry.running = false;
        }
    });
    let value = lookup();
    guard.defuse();
    let mut map = lock(cache);
    let entry = map.entry(key.to_string()).or_default();
    entry.running = false;
    entry.value = value.clone();
    entry.at = Some(Instant::now());
    value
}

/// How long "is a distro running" is trusted.
const WSL_RUNNING_TTL: Duration = Duration::from_secs(5);

/// Whether any WSL distro is running right now. Anything that would touch a
/// distro (`wsl.exe -e`, its `\\wsl.localhost` share) checks this first, so
/// the background polls never boot WSL's VM by themselves. `false` off
/// Windows, and when `wsl.exe` timed out.
pub(crate) fn wsl_running() -> bool {
    struct State {
        last: Option<(Instant, bool)>,
        running: bool,
    }
    static STATE: Mutex<State> = Mutex::new(State { last: None, running: false });
    if !cfg!(windows) {
        return false;
    }
    {
        let mut state = lock(&STATE);
        match state.last {
            Some((at, answer)) if at.elapsed() < WSL_RUNNING_TTL => return answer,
            _ if state.running => return state.last.is_some_and(|(_, a)| a),
            _ => state.running = true,
        }
    }
    let guard = OnDrop::new(|| lock(&STATE).running = false);
    let mut cmd = std::process::Command::new("wsl.exe");
    cmd.args(["-l", "--running", "-q"]);
    // One distro name per line (names have no spaces); with none running
    // wsl.exe prints a localized sentence instead.
    let answer = crate::system::run_wsl(cmd).is_some_and(|output| {
        crate::system::decode_wsl_output(&output.stdout)
            .lines()
            .any(|l| !l.trim().is_empty() && !l.trim().contains(char::is_whitespace))
    });
    guard.defuse();
    let mut state = lock(&STATE);
    state.running = false;
    state.last = Some((Instant::now(), answer));
    answer
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

/// The home directory (a Linux path) of the default user of `distro`; `None`
/// while no distro is running (asking would boot it).
pub(crate) fn wsl_home(distro: &str) -> Option<String> {
    static CACHE: Lookups = LazyLock::new(Default::default);
    if !wsl_running() {
        return None;
    }
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
        lock(&CACHE).get_mut("b").unwrap().at = Some(Instant::now() - WSL_RETRY - Duration::from_secs(1));
        assert_eq!(cached_lookup(&CACHE, "b", || Some("y".into())).as_deref(), Some("y"));
    }
}
