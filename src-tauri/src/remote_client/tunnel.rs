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

/// A listener of this PC tunnelling to a port of a host; closed when dropped.
pub(super) struct Tunnel {
    local_port: u16,
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

/// The host's current QUIC connection, if its link is up.
fn connection_of(clients: &RemoteClients, id: &str) -> Option<iroh::endpoint::Connection> {
    clients.lock().get(id).and_then(|c| c.quic.clone())
}

/// Makes `port` of the other PC's loopback reachable at `127.0.0.1:<returned>` of this one (idempotent).
#[tauri::command]
pub async fn remote_host_tunnel(clients: State<'_, Arc<RemoteClients>>, id: String, port: Option<u16>, chat_id: Option<String>) -> Result<u16, String> {
    let target = match (port, chat_id) {
        (Some(0), _) => return Err("invalid port".into()),
        (Some(port), _) => PreviewTarget::Port(port),
        // The files of a chat's working folder, served over HTTP by the other PC (needs its `chatPreview`).
        (None, Some(chat)) if !chat.is_empty() && !chat.contains(char::is_whitespace) => PreviewTarget::ChatFiles(chat),
        _ => return Err("no target".into()),
    };
    let header = preview_header(&target);
    if let Some(t) = clients.tunnels.lock().unwrap_or_else(|e| e.into_inner()).get(&(id.clone(), header.clone())) {
        return Ok(t.local_port);
    }
    if connection_of(&clients, &id).is_none() {
        return Err("not connected".into());
    }
    // Any free port, never the same number: a dev server started here later must not find it taken.
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await.map_err(|e| e.to_string())?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let clients_for_task = Arc::clone(&clients);
    let host = id.clone();
    let header_key = header.clone();
    let task = tauri::async_runtime::spawn(async move {
        // Streams in flight live in the set: aborting this task aborts them too.
        let mut streams = tokio::task::JoinSet::new();
        loop {
            let Ok((tcp, _)) = listener.accept().await else { break };
            while streams.try_join_next().is_some() {}
            let clients = Arc::clone(&clients_for_task);
            let host = host.clone();
            let header = header.clone();
            streams.spawn(async move {
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
            });
        }
    });
    let mut tunnels = clients.tunnels.lock().unwrap_or_else(|e| e.into_inner());
    // Two first requests at once: the later listener (and its task) just drops.
    let entry = tunnels.entry((id, header_key)).or_insert(Tunnel { local_port, task });
    Ok(entry.local_port)
}

/// Sends a file the composer staged (`chat_stage_attachment`) to the other PC's chat on a new stream of its link; returns the id it stored it under.
#[tauri::command]
pub async fn remote_host_upload(clients: State<'_, Arc<RemoteClients>>, id: String, chat_id: String, upload: String, name: String, mime: String) -> Result<String, String> {
    let staged = crate::chat::uploaded_attachment(&upload, &name, &mime)?;
    let path = staged.path.ok_or("attachment not found")?;
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
    use super::drop_host;
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
}
