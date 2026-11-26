//! The accept loop, the periodic tasks, and per-connection link diagnostics.

use super::*;

pub(super) async fn accept_loop(shared: Arc<Shared>, endpoint: Endpoint, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break };
                // Counted before the task is spawned, so a burst can't slip
                // past the cap while its tasks are still starting.
                if shared.handshaking.fetch_add(1, Ordering::AcqRel) >= MAX_HANDSHAKING {
                    shared.handshaking.fetch_sub(1, Ordering::AcqRel);
                    shared.log.line(&format!("refused {:?}: {MAX_HANDSHAKING} handshakes already in progress", incoming.remote_addr()));
                    incoming.refuse();
                    continue;
                }
                let source = match incoming.remote_addr() {
                    iroh::endpoint::IncomingAddr::Ip(addr) => format!("ip:{}", addr.ip()),
                    iroh::endpoint::IncomingAddr::Relay { endpoint_id, .. } => format!("relay:{endpoint_id}"),
                    other => format!("{other:?}"),
                };
                let guard = HandshakeGuard { shared: Arc::clone(&shared), counted: true, unknown: false, source };
                let shutdown = shutdown.clone();
                tauri::async_runtime::spawn(async move {
                    let shared = Arc::clone(&guard.shared);
                    let from = format!("{:?}", incoming.remote_addr());
                    let started = Instant::now();
                    let connection = match incoming.accept() {
                        Ok(accepting) => match tokio::time::timeout(HANDSHAKE_TIMEOUT, accepting).await {
                            Ok(Ok(connection)) => Some(connection),
                            Ok(Err(e)) => {
                                shared.log.line(&format!("incoming {from}: QUIC handshake failed after {} ms: {e}", started.elapsed().as_millis()));
                                None
                            }
                            Err(_) => {
                                shared.log.line(&format!("incoming {from}: QUIC handshake timed out after {} s", HANDSHAKE_TIMEOUT.as_secs()));
                                None
                            }
                        },
                        Err(e) => {
                            shared.log.line(&format!("incoming {from}: not accepted: {e}"));
                            None
                        }
                    };
                    // Without a connection the guard just drops.
                    if let Some(connection) = connection {
                        shared.log.line(&format!(
                            "peer {}: QUIC connected from {from} in {} ms",
                            short_id(&connection.remote_id().to_string()),
                            started.elapsed().as_millis()
                        ));
                        serve(guard, connection, shutdown).await;
                    }
                });
            }
            _ = shutdown.changed() => break,
        }
    }
}

/// Keeps `Shared::tabs` current while a phone is connected, on the
/// `TABS_INTERVAL` cadence or as soon as a window reports its tabs.
pub(super) async fn tabs_task(shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = tokio::time::sleep(TABS_INTERVAL) => {}
            _ = shared.tabs_wake.notified() => {}
            _ = shutdown.changed() => break,
        }
        if shared.has_conns() {
            // A burst of reports can't scan more than a few times a second.
            shared.refresh_tabs(Duration::from_millis(250)).await;
        }
    }
}

/// Turns the chats' permission requests and finished turns into notifications
/// for the phones, while one is connected.
pub(super) async fn chat_alerts_task(shared: Arc<Shared>, mut shutdown: watch::Receiver<bool>) {
    let mut alerts = shared.app.state::<ChatState>().watch_alerts();
    loop {
        tokio::select! {
            alert = alerts.recv() => match alert {
                Ok(alert) => {
                    if shared.has_conns() {
                        shared.notify_chat(alert);
                    }
                }
                // Lagging just drops the alerts missed.
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            },
            _ = shutdown.changed() => break,
        }
    }
}

/// The addresses of `addr` for a log line: IP addresses, then relay URLs.
pub(super) fn describe_addrs(addr: &iroh::EndpointAddr) -> String {
    let ips: Vec<String> = addr.ip_addrs().map(|a| a.to_string()).collect();
    let relays: Vec<String> = addr.relay_urls().map(|u| u.to_string()).collect();
    format!("{} direct [{}], {} relay [{}]", ips.len(), ips.join(", "), relays.len(), relays.join(", "))
}

/// The selected path of a connection snapshot: direct (IP) or
/// through the relay, with its round trip. `None` when no path is selected.
pub(super) fn selected_path(paths: &iroh::endpoint::PathList<'_>) -> Option<(String, String)> {
    let path = paths.iter().find(|p| p.is_selected())?;
    let kind = if path.is_relay() { "relay" } else { "direct" };
    let addr = path.remote_addr();
    Some((format!("{kind} {addr}"), format!("{kind} {addr} (rtt {} ms, {} paths open)", path.rtt().as_millis(), paths.len())))
}

/// UDP bytes sent and received so far, to rate between two looks.
pub(super) struct LinkCounters {
    pub(super) at: Instant,
    pub(super) tx: u64,
    pub(super) rx: u64,
}

impl LinkCounters {
    pub(super) fn of(connection: &Connection) -> LinkCounters {
        let stats = connection.stats();
        LinkCounters { at: Instant::now(), tx: stats.udp_tx.bytes, rx: stats.udp_rx.bytes }
    }
}

/// `1.5 KB/s` for `bytes` over `secs` seconds.
pub(super) fn rate(bytes: u64, secs: f64) -> String {
    format!("{:.1} KB/s", bytes as f64 / 1024.0 / secs.max(0.001))
}

/// One line of link quality: the selected path, its round trip, the traffic
/// since `last` and the packets lost in all. Moves `last` forward.
pub(super) fn link_metrics(connection: &Connection, last: &mut LinkCounters) -> Option<String> {
    let paths = connection.paths();
    let path = paths.iter().find(|p| p.is_selected())?;
    let kind = if path.is_relay() { "relay" } else { "direct" };
    let now = LinkCounters::of(connection);
    let secs = now.at.duration_since(last.at).as_secs_f64();
    let line = format!(
        "link {kind} {} ms, tx {}, rx {}, {} packets lost",
        path.rtt().as_millis(),
        rate(now.tx.saturating_sub(last.tx), secs),
        rate(now.rx.saturating_sub(last.rx), secs),
        connection.stats().lost_packets
    );
    *last = now;
    Some(line)
}

/// Logs which path `connection` uses (direct or relay, and its round trip)
/// each time the selection changes, and its quality every `METRICS_EVERY`;
/// ends when the connection closes.
pub(super) async fn watch_paths(shared: Arc<Shared>, connection: Connection, peer: String) {
    use futures_lite::StreamExt;
    let mut last = String::new();
    let mut counters = LinkCounters::of(&connection);
    let mut metrics = tokio::time::interval_at(tokio::time::Instant::now() + METRICS_EVERY, METRICS_EVERY);
    let mut paths = connection.paths_stream();
    loop {
        tokio::select! {
            list = paths.next() => {
                let Some(list) = list else { break };
                let Some((key, line)) = selected_path(&list) else { continue };
                if key != last {
                    shared.log.line(&format!("peer {peer}: path {line}"));
                    last = key;
                }
            }
            _ = metrics.tick() => {
                if let Some(line) = link_metrics(&connection, &mut counters) {
                    shared.log.line(&format!("peer {peer}: {line}"));
                }
            }
        }
    }
}

pub(super) async fn serve(mut guard: HandshakeGuard, connection: Connection, mut shutdown: watch::Receiver<bool>) {
    let shared = Arc::clone(&guard.shared);
    let Some(mut admitted) = handshake(&shared, &mut guard, &connection, &mut shutdown).await else { return };
    guard.done();
    // The device may have been revoked, or the endpoint stopped, while the
    // handshake ran.
    let missing = !lock(&shared.config).devices.iter().any(|d| d.id == admitted.device.id);
    if missing || *shutdown.borrow() {
        let peer = short_id(&connection.remote_id().to_string()).to_string();
        if missing {
            let message = tr("Dispositivo revocato", "Device revoked").to_string();
            shared.log.line(&format!("peer {peer}: rejected: revoked during the handshake"));
            reject(&connection, &mut admitted.send, message, 3, b"gone").await;
        } else {
            // Not fatal: the client keeps its pairing and retries.
            let message = tr("Host in arresto", "Host shutting down").to_string();
            shared.log.line(&format!("peer {peer}: rejected: shutting down during the handshake"));
            reject_with(&connection, &mut admitted.send, message, false, 3, b"gone").await;
        }
        return;
    }
    let (peer, device_name) = (short_id(&connection.remote_id().to_string()).to_string(), admitted.device.name.clone());
    let started = Instant::now();
    let watcher = tokio::spawn(watch_paths(Arc::clone(&shared), connection.clone(), peer.clone()));
    let why = run_connection(Arc::clone(&shared), &connection, shutdown, admitted).await;
    watcher.abort();
    shared.log.line(&format!(
        "peer {peer}: closed \"{device_name}\" after {} s: {why}",
        started.elapsed().as_secs()
    ));
}
