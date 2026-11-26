//! Extra QUIC streams of a host's link, for what the phone does on its own
//! streams: the in-app browser's tunnel to the other PC's loopback ports, and
//! chat attachment uploads. The phone serves a webview scheme; here a native
//! webview needs a real address, so a port is exposed as a loopback listener
//! of this PC whose connections are tunnelled (`port N` stream) to that port.

use super::RemoteClients;
use flowcode_remote_proto::{preview_header, PreviewTarget, UploadMeta, UploadReply, UPLOAD_MAX_BYTES};
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tauri::State;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::sync::Notify;

/// A listener of this PC tunnelling to a port of a host; closed when dropped.
pub(super) struct Tunnel {
    local_port: u16,
    /// Restarts the idle clock (a repeated `remote_host_tunnel` is a keepalive).
    touch: Arc<Notify>,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Removes every entry of host `id` from a registry keyed `(host, target)`; dropping a `Tunnel` stops it.
pub(super) fn drop_host<V>(map: &mut std::collections::HashMap<(String, String), V>, id: &str) -> usize {
    let before = map.len();
    map.retain(|(host, _), _| host != id);
    before - map.len()
}

impl RemoteClients {
    /// Stops the host's loopback listeners and the streams in flight through them: its link is gone (or replaced, or the PC forgotten), and a new link starts with none (the frontend asks again, `remote_host_tunnel` is idempotent).
    pub(super) fn close_tunnels(&self, id: &str) {
        let dropped: Vec<Tunnel> = {
            let mut map = self.tunnels.lock().unwrap_or_else(|e| e.into_inner());
            let keys: Vec<_> = map.keys().filter(|(h, _)| h == id).cloned().collect();
            keys.iter().filter_map(|k| map.remove(k)).collect()
        };
        drop(dropped);
    }
}

/// Binds `preferred` when given and free, else any free loopback port.
async fn bind_preferring(preferred: Option<u16>) -> std::io::Result<TcpListener> {
    if let Some(port) = preferred {
        if let Ok(listener) = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await {
            return Ok(listener);
        }
    }
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await
}

impl RemoteClients {
    /// Forgets the remembered local ports of a host (the PC was forgotten).
    pub(super) fn forget_tunnel_ports(&self, id: &str) {
        let mut ports = self.tunnel_ports.lock().unwrap_or_else(|e| e.into_inner());
        ports.retain(|(host, _), _| host != id);
    }
}

/// How long a tunnel's listener may go without a connection (and with none open) before it is closed.
const TUNNEL_IDLE: Duration = Duration::from_secs(10 * 60);

/// Accepts connections and runs `on_conn` for each, until `idle` passes with no connection open and none arriving (or accepting fails). Streams in flight die with it.
async fn serve_until_idle<F, Fut>(listener: TcpListener, idle: Duration, touch: Arc<Notify>, mut on_conn: F)
where
    F: FnMut(tokio::net::TcpStream) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let mut streams = tokio::task::JoinSet::new();
    'serve: loop {
        let accepted = if streams.is_empty() {
            let sleep = tokio::time::sleep(idle);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    accepted = listener.accept() => break accepted,
                    _ = &mut sleep => break 'serve,
                    // Asked for again: the clock starts over.
                    _ = touch.notified() => sleep.as_mut().reset(tokio::time::Instant::now() + idle),
                }
            }
        } else {
            // Something is open: not idle. When it ends the clock starts over.
            tokio::select! {
                accepted = listener.accept() => accepted,
                _ = streams.join_next() => continue,
            }
        };
        let Ok((tcp, _)) = accepted else { break };
        streams.spawn(on_conn(tcp));
    }
}

/// The host's current QUIC connection, if its link is up.
fn connection_of(clients: &RemoteClients, id: &str) -> Option<iroh::endpoint::Connection> {
    clients.lock().get(id).and_then(|c| c.quic.clone())
}

/// Makes `port` of the other PC's loopback reachable at `127.0.0.1:<returned>` of this one (idempotent).
#[tauri::command]
pub async fn remote_host_tunnel(clients: State<'_, Arc<RemoteClients>>, id: String, port: Option<u16>, chat_id: Option<String>, page_id: Option<String>) -> Result<u16, String> {
    let target = match (port, chat_id, page_id) {
        (Some(0), _, _) => return Err("invalid port".into()),
        (Some(port), _, _) => PreviewTarget::Port(port),
        // The files of a chat's working folder, served over HTTP by the other PC (needs its `chatPreview`).
        (None, Some(chat), _) if !chat.is_empty() && !chat.contains(char::is_whitespace) => PreviewTarget::ChatFiles(chat),
        // The folder of a file page of the other PC's browser (needs its `browserTabs`).
        (None, None, Some(page)) if !page.is_empty() && !page.contains(char::is_whitespace) => PreviewTarget::BrowserPage(page),
        _ => return Err("no target".into()),
    };
    let header = preview_header(&target);
    if let Some(t) = clients.tunnels.lock().unwrap_or_else(|e| e.into_inner()).get(&(id.clone(), header.clone())) {
        t.touch.notify_one();
        return Ok(t.local_port);
    }
    if connection_of(&clients, &id).is_none() {
        return Err("not connected".into());
    }
    // The port this tunnel had last time when it is still free (pages that kept
    // the old URL work again), any free one otherwise.
    let preferred = clients.tunnel_ports.lock().unwrap_or_else(|e| e.into_inner()).get(&(id.clone(), header.clone())).copied();
    let listener = bind_preferring(preferred).await.map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    clients.tunnel_ports.lock().unwrap_or_else(|e| e.into_inner()).insert((id.clone(), header.clone()), local_port);
    let touch = Arc::new(Notify::new());
    let touch_for_task = Arc::clone(&touch);
    let clients_for_task = Arc::clone(&clients);
    let clients_for_exit = Arc::clone(&clients);
    let host = id.clone();
    let header_key = header.clone();
    let key = (id.clone(), header_key.clone());
    let task = tauri::async_runtime::spawn(async move {
        serve_until_idle(listener, TUNNEL_IDLE, touch_for_task, move |tcp| {
            let clients = Arc::clone(&clients_for_task);
            let host = host.clone();
            let header = header.clone();
            async move {
                // Read at each connection: a redialed link has a new one.
                let Some(conn) = connection_of(&clients, &host) else { return };
                let Ok((mut send, recv)) = conn.open_bi().await else { return };
                if send.write_all(header.as_bytes()).await.is_err() {
                    return;
                }
                let mut tcp = tcp;
                let mut stream = tokio::io::join(recv, send);
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
                let (_, mut send) = stream.into_inner();
                let _ = send.finish();
            }
        })
        .await;
        // Unused for a while (or the listener failed): forget it, `remote_host_tunnel` makes a new one on demand.
        let mut map = clients_for_exit.tunnels.lock().unwrap_or_else(|e| e.into_inner());
        if map.get(&key).is_some_and(|t| t.local_port == local_port) {
            map.remove(&key);
        }
    });
    let mut tunnels = clients.tunnels.lock().unwrap_or_else(|e| e.into_inner());
    // Two first requests at once: the later listener (and its task) just drops.
    let entry = tunnels.entry((id, header_key)).or_insert(Tunnel { local_port, touch, task });
    Ok(entry.local_port)
}

/// Sends a file the composer staged (`chat_stage_attachment`) to the other PC's chat on a new stream of its link; returns the id it stored it under.
#[tauri::command]
pub async fn remote_host_upload(clients: State<'_, Arc<RemoteClients>>, id: String, chat_id: String, upload: String, name: String, mime: String) -> Result<String, String> {
    let staged = crate::chat::uploaded_attachment(&upload, &name, &mime)?;
    let path = staged.path.ok_or("attachment not found")?;
    // Before reading: a huge file is refused without loading it.
    let size = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?.len();
    if size > UPLOAD_MAX_BYTES {
        return Err(format!("File exceeds {} MiB", UPLOAD_MAX_BYTES / (1024 * 1024)));
    }
    let bytes = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > UPLOAD_MAX_BYTES {
        return Err(format!("File exceeds {} MiB", UPLOAD_MAX_BYTES / (1024 * 1024)));
    }
    let conn = connection_of(&clients, &id).ok_or_else(|| "not connected".to_string())?;
    let meta = serde_json::to_string(&UploadMeta { name, mime, size: bytes.len() as u64 }).map_err(|e| e.to_string())?;
    let exchange = async move {
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
        // A host that refuses the upload answers and stops reading: the write
        // then fails, but its reply says why, so read it before giving up.
        let write: Result<(), String> = async {
            send.write_all(preview_header(&PreviewTarget::ChatUpload(chat_id)).as_bytes()).await.map_err(|e| e.to_string())?;
            send.write_all(meta.as_bytes()).await.map_err(|e| e.to_string())?;
            send.write_all(b"\n").await.map_err(|e| e.to_string())?;
            send.write_all(&bytes).await.map_err(|e| e.to_string())?;
            send.finish().map_err(|e| e.to_string())
        }
        .await;
        let mut line = Vec::with_capacity(128);
        loop {
            match recv.read_u8().await {
                Ok(byte) if byte != b'\n' => line.push(byte),
                _ => break,
            }
            if line.len() >= 4096 {
                break;
            }
        }
        let reply: UploadReply = match serde_json::from_slice(&line) {
            Ok(reply) => reply,
            Err(_) => return Err(write.err().unwrap_or_else(|| "no answer from the other PC".to_string())),
        };
        match (reply.id, reply.error) {
            (Some(id), _) => Ok(id),
            (None, error) => Err(error.unwrap_or_else(|| "upload failed".into())),
        }
    };
    tokio::time::timeout(Duration::from_secs(150), exchange).await.map_err(|_| "upload timed out".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{bind_preferring, drop_host, serve_until_idle};
    use std::sync::Arc;
    use tokio::sync::Notify;
    use std::time::Duration;
    use tokio::net::{TcpListener, TcpStream};
    use std::collections::HashMap;

    #[test]
    fn dropping_a_host_removes_only_its_tunnels() {
        let mut map: HashMap<(String, String), u8> = HashMap::new();
        for (h, t) in [("a", "port 1
"), ("a", "port 2
"), ("b", "port 1
")] {
            map.insert((h.into(), t.into()), 0);
        }
        assert_eq!(drop_host(&mut map, "a"), 2);
        assert_eq!(map.len(), 1);
        assert!(map.contains_key(&("b".to_string(), "port 1
".to_string())));
        assert_eq!(drop_host(&mut map, "a"), 0);
    }

    #[tokio::test]
    async fn a_closed_tunnel_port_is_reused_when_free_and_replaced_when_taken() {
        let first = bind_preferring(None).await.unwrap();
        let port = first.local_addr().unwrap().port();
        drop(first);
        let again = bind_preferring(Some(port)).await.unwrap();
        assert_eq!(again.local_addr().unwrap().port(), port);
        // Still held: a different one is chosen instead of failing.
        let other = bind_preferring(Some(port)).await.unwrap();
        assert_ne!(other.local_addr().unwrap().port(), port);
    }

    #[tokio::test]
    async fn touching_a_listener_restarts_its_idle_clock() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let touch = Arc::new(Notify::new());
        let serve = tokio::spawn(serve_until_idle(listener, Duration::from_millis(200), Arc::clone(&touch), |_tcp| async {}));
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(120)).await;
            touch.notify_one();
        }
        assert!(!serve.is_finished());
        assert!(tokio::time::timeout(Duration::from_secs(5), serve).await.is_ok());
    }

    #[tokio::test]
    async fn an_unused_listener_ends_after_the_idle_time() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), serve_until_idle(listener, Duration::from_millis(80), Arc::new(Notify::new()), |_tcp| async {})).await;
        assert!(ended.is_ok());
    }

    #[tokio::test]
    async fn an_open_connection_keeps_the_listener_and_the_clock_restarts_after_it() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let serve = tokio::spawn(serve_until_idle(listener, Duration::from_millis(100), Arc::new(Notify::new()), |_tcp| async {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }));
        let _client = TcpStream::connect(addr).await.unwrap();
        // Longer than the idle time, still serving: the connection is open.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(!serve.is_finished());
        // Handler done at ~400 ms, then 100 ms idle.
        assert!(tokio::time::timeout(Duration::from_secs(5), serve).await.is_ok());
    }
}
