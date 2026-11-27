//! The in-app browser's dev-server pages: a loopback listener of the phone per
//! desktop port, each connection tunnelled over its own stream of the live link
//! (`port N` first line, as `preview.rs` does), so the page sees a real
//! `http://127.0.0.1:<port>` origin: root-absolute paths, WebSocket (HMR),
//! workers and SPA routes just work. Same as the desktop client's tunnel
//! (`flowcode_remote_proto::tunnel`).

use crate::state::Remote;
use flowcode_remote_proto::tunnel::{bind_preferring, pipe, serve_until_idle};
use flowcode_remote_proto::{preview_header, PreviewTarget};
use iroh::EndpointId;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use tokio::sync::Notify;

/// How long a listener may go without a connection (and with none open) before it is closed.
const TUNNEL_IDLE: Duration = Duration::from_secs(10 * 60);
/// How long the probe waits for the desktop to refuse the port.
const PROBE_WAIT: Duration = Duration::from_millis(1500);

/// A listener of the phone tunnelling to a port of one desktop; closed when dropped.
struct Tunnel {
    local_port: u16,
    /// The desktop it forwards to: a listener must never forward to another one.
    host: EndpointId,
    /// Restarts the idle clock (a repeated `preview_tunnel` is a keepalive).
    touch: Arc<Notify>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Default)]
pub(crate) struct Tunnels {
    /// Desktop port -> its listener.
    live: Mutex<HashMap<u16, Tunnel>>,
    /// The local port each desktop port had last time, reused when still free so pages that kept the URL work again.
    ports: Mutex<HashMap<u16, u16>>,
}

fn host_of(remote: &Remote) -> Option<iroh::endpoint::Connection> {
    remote.lock().conn.clone()
}

/// Asks the desktop for a stream to `port` and waits briefly: a refusal (nothing listening, blocked port) resets it at once.
async fn reachable(conn: &iroh::endpoint::Connection, port: u16) -> bool {
    let Ok((mut send, mut recv)) = conn.open_bi().await else { return false };
    if send.write_all(preview_header(&PreviewTarget::Port(port)).as_bytes()).await.is_err() {
        return false;
    }
    let refused = matches!(tokio::time::timeout(PROBE_WAIT, recv.read(&mut [0u8; 1])).await, Ok(Err(_)));
    let _ = send.finish();
    !refused
}

/// Makes `port` of the desktop's loopback reachable at `127.0.0.1:<returned>` of the phone (idempotent); fails when the desktop is not reachable or nothing listens there.
#[tauri::command]
pub async fn preview_tunnel(remote: State<'_, Arc<Remote>>, tunnels: State<'_, Arc<Tunnels>>, port: u16) -> Result<u16, String> {
    if port == 0 {
        return Err("invalid port".into());
    }
    let conn = host_of(&remote).ok_or_else(|| "not connected".to_string())?;
    let host = conn.remote_id();
    let existing = {
        let mut live = tunnels.live.lock().unwrap_or_else(|e| e.into_inner());
        // Another desktop took the link over: nothing of the old one stays open.
        let stale: Vec<u16> = live.iter().filter(|(_, t)| t.host != host).map(|(p, _)| *p).collect();
        let dropped: Vec<Tunnel> = stale.iter().filter_map(|p| live.remove(p)).collect();
        drop(dropped);
        live.get(&port).map(|t| {
            t.touch.notify_one();
            t.local_port
        })
    };
    if let Some(local) = existing {
        return Ok(local);
    }
    // Only a new tunnel is probed: a live server answers nothing until asked, so the probe always waits its full time.
    if !reachable(&conn, port).await {
        return Err("unreachable".into());
    }
    let preferred = tunnels.ports.lock().unwrap_or_else(|e| e.into_inner()).get(&port).copied();
    let listener = bind_preferring(preferred).await.map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tunnels.ports.lock().unwrap_or_else(|e| e.into_inner()).insert(port, local_port);
    let touch = Arc::new(Notify::new());
    let header = preview_header(&PreviewTarget::Port(port));
    let remote_for_task = Arc::clone(&remote);
    let tunnels_for_exit = Arc::clone(&tunnels);
    let touch_for_task = Arc::clone(&touch);
    let task = tauri::async_runtime::spawn(async move {
        serve_until_idle(listener, TUNNEL_IDLE, touch_for_task, move |tcp| {
            let remote = Arc::clone(&remote_for_task);
            let header = header.clone();
            async move {
                // Read at each connection: a redialed link has a new one, but only the same desktop may be served.
                let Some(conn) = host_of(&remote).filter(|c| c.remote_id() == host) else { return };
                let Ok((send, recv)) = conn.open_bi().await else { return };
                let mut send = pipe(tcp, &header, recv, send).await;
                let _ = send.finish();
            }
        })
        .await;
        // Unused for a while (or the listener failed): forget it, `preview_tunnel` makes a new one on demand.
        let mut live = tunnels_for_exit.live.lock().unwrap_or_else(|e| e.into_inner());
        if live.get(&port).is_some_and(|t| t.local_port == local_port) {
            live.remove(&port);
        }
    });
    let mut live = tunnels.live.lock().unwrap_or_else(|e| e.into_inner());
    // Two first requests at once: the later listener (and its task) just drops.
    let entry = live.entry(port).or_insert(Tunnel { local_port, host, touch, task });
    Ok(entry.local_port)
}
