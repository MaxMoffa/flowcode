//! Admitting a connection: handshake limits, pairing confirmation, authentication.

use super::*;

/// Releases the handshake counters exactly once, whichever way `serve`
/// leaves its handshake.
pub(super) struct HandshakeGuard {
    pub(super) shared: Arc<Shared>,
    /// Counted in `Shared::handshaking` (every connection before its auth).
    pub(super) counted: bool,
    /// Also holds one of the few `Shared::handshaking_unknown` slots.
    pub(super) unknown: bool,
    /// Where the connection came from (see `UnknownLimiter`).
    pub(super) source: String,
}

impl HandshakeGuard {
    /// Takes one of the `MAX_UNKNOWN_HANDSHAKING` slots for a node that isn't
    /// a paired device; false when they are all in use.
    pub(super) fn claim_unknown(&mut self) -> bool {
        if self.unknown {
            return true;
        }
        if !lock(&self.shared.unknown_limiter).admit(&self.source, now_ms()) {
            return false;
        }
        if self.shared.handshaking_unknown.fetch_add(1, Ordering::AcqRel) >= MAX_UNKNOWN_HANDSHAKING {
            self.shared.handshaking_unknown.fetch_sub(1, Ordering::AcqRel);
            return false;
        }
        self.unknown = true;
        true
    }

    pub(super) fn done(&mut self) {
        if std::mem::take(&mut self.counted) {
            self.shared.handshaking.fetch_sub(1, Ordering::AcqRel);
        }
        if std::mem::take(&mut self.unknown) {
            self.shared.handshaking_unknown.fetch_sub(1, Ordering::AcqRel);
        }
    }
}

impl Drop for HandshakeGuard {
    fn drop(&mut self) {
        self.done();
    }
}

/// What the first frame of a connection amounts to.
pub(super) enum Admission {
    /// A known device came back.
    Known(Device),
    /// A valid pairing code was presented; the user still has to confirm on
    /// the desktop before the device is created.
    PairRequest { device_name: String },
}

pub(super) fn admit(shared: &Shared, first: ClientMsg, node_id: &str) -> Result<Admission, String> {
    match first {
        ClientMsg::Auth { token } => {
            let now = now_ms();
            let device = lock(&shared.config).authenticate(&token, node_id);
            match device {
                // A right token is never held back by the limiter: it only
                // exists to slow guessing, and a phone whose earlier attempts
                // failed must not be locked out of (and told to forget) a
                // pairing that is perfectly good.
                Some(device) => {
                    lock(&shared.auth_limiter).succeeded(node_id);
                    Ok(Admission::Known(device))
                }
                None if !lock(&shared.auth_limiter).allowed(node_id, now) => {
                    Err(tr("Troppi tentativi: riprova tra un minuto", "Too many attempts: try again in a minute").to_string())
                }
                None => {
                    lock(&shared.auth_limiter).failed(node_id, now);
                    Err(tr("Autenticazione non riuscita", "Authentication failed").to_string())
                }
            }
        }
        ClientMsg::Pair { code, device_name } => {
            let redeemed = lock(&shared.pairings).redeem(code.trim(), now_ms());
            match redeemed {
                Err(PairError::RateLimited) => {
                    Err(tr("Troppi tentativi: riprova tra un minuto", "Too many attempts: try again in a minute").to_string())
                }
                Err(PairError::Invalid) => Err(tr("Codice non valido o scaduto", "Invalid or expired code").to_string()),
                // Shown in a dialog and a notification: never raw.
                Ok(()) => Ok(Admission::PairRequest { device_name: clean_name(&device_name) }),
            }
        }
        _ => Err(tr("Autenticazione non riuscita", "Authentication failed").to_string()),
    }
}

/// Drops a pending pairing request however `confirm_pairing` is left, and
/// tells the desktop's dialog to go away if the user never answered.
pub(super) struct PairWaiterGuard<'a>(&'a Shared, String);

impl Drop for PairWaiterGuard<'_> {
    fn drop(&mut self) {
        // Answered requests were already taken out by `remote_pair_decide`.
        if lock(&self.0.pair_waiters).remove(&self.1).is_some() {
            let _ = self.0.app.emit(EVT_PAIR_CANCEL, serde_json::json!({ "reqId": self.1 }));
        }
    }
}

/// Asks the user, on the desktop, whether to let this phone in; only a yes
/// creates the device. Waiting counts as handshaking, which keeps strangers
/// with a stolen code from piling up pending requests.
pub(super) async fn confirm_pairing(
    shared: &Shared,
    node_id: &str,
    device_name: &str,
    connection: &Connection,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<(Device, String), String> {
    let declined = || tr("Collegamento rifiutato sul computer", "Pairing declined on the computer").to_string();
    let Some(window) = shared.default_window() else { return Err(declined()) };
    let req_id = random_hex(8)?;
    let (tx, answer) = oneshot::channel();
    lock(&shared.pair_waiters).insert(req_id.clone(), tx);
    let _guard = PairWaiterGuard(shared, req_id.clone());
    let name = clean_name(device_name);
    // The phone shows the same fingerprint, so the user can tell which request is theirs.
    let payload = serde_json::json!({ "reqId": req_id, "deviceName": name, "fingerprint": proto::node_fingerprint(node_id) });
    if shared.app.emit_to(window.as_str(), EVT_PAIR_REQUEST, payload).is_err() {
        return Err(declined());
    }
    shared.focus_window(&window);
    shared.notify(tr("Richiesta di collegamento", "Pairing request").to_string(), name.clone());

    let accepted = tokio::select! {
        answer = tokio::time::timeout(PAIR_CONFIRM_TIMEOUT, answer) => match answer {
            Ok(Ok(accepted)) => accepted,
            Ok(Err(_)) => false,
            Err(_) => {
                return Err(tr("Nessuna conferma sul computer: riprova", "Not confirmed on the computer: try again").to_string())
            }
        },
        _ = shutdown.changed() => false,
        // The phone left while the user was deciding: no ghost device, no held slot.
        _ = connection.closed() => {
            return Err(tr("Collegamento annullato dal dispositivo", "Pairing cancelled by the device").to_string())
        }
    };
    if !accepted {
        return Err(declined());
    }
    // A re-pairing replaces the node's earlier devices; their live
    // connections must not outlive the token they authenticated with.
    let (device, token, stale) = {
        let mut config = lock(&shared.config);
        let stale: Vec<String> = config.devices.iter().filter(|d| d.node_id == node_id).map(|d| d.id.clone()).collect();
        let (device, token) = config.add_device(device_name, node_id, now_ms())?;
        (device, token, stale)
    };
    shared.kick_removed(&stale);
    shared.save();
    shared.devices_changed();
    shared.notify(tr("Nuovo dispositivo collegato", "New device paired").to_string(), device.name.clone());
    Ok((device, token))
}

/// A connection that passed the handshake, with its (still unused) stream.
pub(super) struct Admitted {
    pub(super) device: Device,
    /// Set when the connection was a pairing: the new device token to hand over.
    pub(super) token: Option<String>,
    pub(super) send: SendStream,
    pub(super) recv: RecvStream,
}

/// Sends a fatal `error` and hangs up.
pub(super) async fn reject(connection: &Connection, send: &mut SendStream, message: String, code: u32, reason: &[u8]) {
    reject_with(connection, send, message, true, code, reason).await;
}

/// As `reject`; a non-`fatal` refusal tells the client to try again later (the host is shutting down).
pub(super) async fn reject_with(connection: &Connection, send: &mut SendStream, message: String, fatal: bool, code: u32, reason: &[u8]) {
    let _ = write_frame(send, &ServerMsg::Error { message, pty_id: None, chat_id: None, fatal }).await;
    let _ = send.finish();
    // Closing right away could discard the error still in flight.
    let _ = tokio::time::timeout(Duration::from_secs(2), send.stopped()).await;
    connection.close(code.into(), reason);
}

/// The handshake: the phone's first frame (`auth` or `pair`, plus the
/// desktop's confirmation for a new phone). `None` once the connection has
/// been refused and closed.
pub(super) async fn handshake(
    shared: &Arc<Shared>,
    guard: &mut HandshakeGuard,
    connection: &Connection,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<Admitted> {
    // Verified by iroh during the TLS handshake: this really is that key.
    let node_id = connection.remote_id().to_string();
    let peer = short_id(&node_id);
    // Strangers get only a few handshake slots, so they can't crowd out the
    // phones that are actually paired.
    let known = shared.is_known_node(&node_id);
    if !known && !guard.claim_unknown() {
        shared.log.line(&format!("peer {peer}: rejected, unknown node and all {MAX_UNKNOWN_HANDSHAKING} stranger slots busy"));
        connection.close(4u32.into(), b"busy");
        return None;
    }
    let started = Instant::now();
    let stream = tokio::time::timeout(AUTH_TIMEOUT, connection.accept_bi()).await;
    let (mut send, mut recv) = match stream {
        Ok(Ok(pair)) => pair,
        Ok(Err(e)) => {
            shared.log.line(&format!("peer {peer}: no stream opened ({e})"));
            connection.close(1u32.into(), b"no stream");
            return None;
        }
        Err(_) => {
            shared.log.line(&format!("peer {peer}: timeout, no stream opened within {} s", AUTH_TIMEOUT.as_secs()));
            connection.close(1u32.into(), b"no stream");
            return None;
        }
    };
    let first = tokio::time::timeout(AUTH_TIMEOUT, read_frame::<_, ClientMsg>(&mut recv)).await;
    let msg = match first {
        Ok(Ok(msg)) => msg,
        // Not a verdict on the phone: say nothing fatal (a fatal error makes
        // the phone forget its pairing), just hang up and let it retry.
        other => {
            let why = match other {
                Ok(Err(e)) => format!("first frame unreadable: {e}"),
                _ => format!("timeout, no first frame within {} s", AUTH_TIMEOUT.as_secs()),
            };
            shared.log.line(&format!("peer {peer}: {why}"));
            connection.close(1u32.into(), b"no auth");
            return None;
        }
    };
    let kind = match &msg {
        ClientMsg::Auth { .. } => "auth",
        ClientMsg::Pair { .. } => "pair",
        _ => "other",
    };
    shared.log.line(&format!(
        "peer {peer}: first frame `{kind}` after {} ms ({})",
        started.elapsed().as_millis(),
        if known { "paired node" } else { "unknown node" }
    ));
    let admission = admit(shared, msg, &node_id);
    let admitted = match admission {
        Ok(Admission::Known(device)) => Ok((device, None)),
        Ok(Admission::PairRequest { device_name }) => confirm_pairing(shared, &node_id, &device_name, connection, shutdown)
            .await
            .map(|(device, token)| (device, Some(token))),
        Err(message) => Err(message),
    };
    match admitted {
        Ok((device, token)) => {
            shared.log.line(&format!("peer {peer}: {} for device \"{}\"", if token.is_some() { "paired" } else { "auth ok" }, device.name));
            Some(Admitted { device, token, send, recv })
        }
        Err(message) => {
            shared.log.line(&format!("peer {peer}: rejected: {message}"));
            reject(connection, &mut send, message, 2, b"auth").await;
            None
        }
    }
}
