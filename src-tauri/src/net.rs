//! Internet reachability probe, so a dead network isn't mistaken for a sign-in problem.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::mpsc;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_millis(1500);
const OVERALL_TIMEOUT: Duration = Duration::from_secs(3);

/// `host:port` of the proxy named by the usual env vars, if any.
fn proxy_target() -> Option<String> {
    let raw = ["HTTPS_PROXY", "https_proxy", "ALL_PROXY"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))?;
    let rest = raw.trim().split("://").last()?;
    let rest = rest.rsplit('@').next()?;
    let hostport = rest.split('/').next()?;
    if hostport.is_empty() {
        return None;
    }
    Some(if hostport.contains(':') && !hostport.ends_with(']') { hostport.to_string() } else { format!("{hostport}:8080") })
}

/// Per target: the last answer, and whether a probe is still running. DNS
/// resolution has no timeout, so while one is stuck (offline) new probes for
/// the same target return the last answer instead of piling up threads.
static PROBES: std::sync::Mutex<Option<std::collections::HashMap<String, (bool, bool)>>> = std::sync::Mutex::new(None);

fn reachable(target: &str) -> bool {
    {
        let mut guard = crate::util::lock(&PROBES);
        let map = guard.get_or_insert_with(Default::default);
        let entry = map.entry(target.to_string()).or_insert((false, false));
        if entry.0 {
            return entry.1;
        }
        entry.0 = true;
    }
    let result = probe(target);
    if let Some(entry) = crate::util::lock(&PROBES).get_or_insert_with(Default::default).get_mut(target) {
        *entry = (false, result);
    }
    result
}

fn probe(target: &str) -> bool {
    let addr: Option<SocketAddr> = target.to_socket_addrs().ok().and_then(|mut a| a.next());
    addr.map(|a| TcpStream::connect_timeout(&a, CONNECT_TIMEOUT).is_ok()).unwrap_or(false)
}

/// True when any target answers. Proxies/corporate nets block some of these
/// hosts, so any one reachable counts as online and a false "offline" stays unlikely.
pub fn online() -> bool {
    let mut targets: Vec<String> = ["1.1.1.1:443", "8.8.8.8:443", "9.9.9.9:443", "api.anthropic.com:443", "chatgpt.com:443"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(p) = proxy_target() {
        targets.push(p);
    }
    let total = targets.len();
    let (tx, rx) = mpsc::channel();
    for t in targets {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let _ = tx.send(reachable(&t));
        });
    }
    drop(tx);
    let deadline = std::time::Instant::now() + OVERALL_TIMEOUT;
    for _ in 0..total {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match rx.recv_timeout(left) {
            Ok(true) => return true,
            Ok(false) => {}
            Err(_) => return false,
        }
    }
    false
}

#[tauri::command]
pub async fn network_online() -> Result<bool, String> {
    crate::blocking(move || Ok(online())).await
}
