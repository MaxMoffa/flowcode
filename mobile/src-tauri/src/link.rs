//! The phone's side of the protocol: dial the desktop over iroh and run the
//! handshake. Free of Tauri so the smoke example drives exactly the code the
//! app uses.

use flowcode_remote_proto::{read_frame, write_frame, ClientMsg, FrameError, ServerMsg, ALPN};
use iroh::endpoint::{presets, Connection, RecvStream, SendStream};
use iroh::{Endpoint, SecretKey};
use iroh_tickets::endpoint::EndpointTicket;
use std::str::FromStr;
use std::time::Duration;

const DIAL_TIMEOUT: Duration = Duration::from_secs(20);
/// The server drops a connection whose first frame takes longer than 10 s;
/// waiting a bit longer for its answer covers a slow relay path.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
/// A `pair` also waits for the user to confirm on the desktop (up to 60 s).
const PAIR_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(75);

/// An open, handshaken connection. `conn` is kept so dropping the struct
/// closes the QUIC connection (and the desktop notices at once).
pub struct Session {
    pub conn: Connection,
    pub send: SendStream,
    pub recv: RecvStream,
    pub host_name: String,
    pub device_name: String,
    /// Set only when this handshake was a `pair`.
    pub token: Option<String>,
}

#[derive(Debug)]
pub enum LinkError {
    /// The desktop refused us for good (bad code/token, revoked): retrying is
    /// pointless.
    Fatal(String),
    /// Anything transient: network down, desktop asleep, timeout.
    Transient(String),
}

impl LinkError {
    pub fn message(&self) -> &str {
        match self {
            LinkError::Fatal(m) | LinkError::Transient(m) => m,
        }
    }
}

pub async fn bind(key: SecretKey) -> Result<Endpoint, String> {
    Endpoint::builder(presets::N0)
        .secret_key(key)
        .bind()
        .await
        .map_err(|e| format!("cannot start the network endpoint: {e}"))
}

/// Opens the stream and runs the handshake with `first` (a `pair` or `auth`
/// message), returning once the desktop says `ready`.
pub async fn handshake(endpoint: &Endpoint, node: &str, first: ClientMsg) -> Result<Session, LinkError> {
    handshake_with(endpoint, node, first, || {}).await
}

/// Like [`handshake`], calling `on_connected` once the dial succeeded and the
/// auth exchange begins (lets the UI tell "searching" from "authenticating").
pub async fn handshake_with(endpoint: &Endpoint, node: &str, first: ClientMsg, on_connected: impl FnOnce()) -> Result<Session, LinkError> {
    let ticket = EndpointTicket::from_str(node).map_err(|e| LinkError::Fatal(format!("bad desktop address: {e}")))?;
    let conn = tokio::time::timeout(DIAL_TIMEOUT, endpoint.connect(ticket.endpoint_addr().clone(), ALPN))
        .await
        .map_err(|_| LinkError::Transient("the desktop did not answer".into()))?
        .map_err(|e| LinkError::Transient(format!("cannot reach the desktop: {e}")))?;
    on_connected();
    let (mut send, mut recv) = conn.open_bi().await.map_err(|e| LinkError::Transient(format!("cannot open the stream: {e}")))?;
    let timeout = if matches!(first, ClientMsg::Pair { .. }) { PAIR_HANDSHAKE_TIMEOUT } else { HANDSHAKE_TIMEOUT };
    // The server only learns about the stream when the first bytes arrive.
    write_frame(&mut send, &first).await.map_err(frame_err)?;

    let mut token = None;
    let mut device_name = String::new();
    let host_name = tokio::time::timeout(timeout, async {
        loop {
            match read_frame::<_, ServerMsg>(&mut recv).await.map_err(frame_err)? {
                ServerMsg::Paired { token: t, device_name: d } => {
                    token = Some(t);
                    device_name = d;
                }
                ServerMsg::Ready { device_name: d, host_name } => {
                    if device_name.is_empty() {
                        device_name = d;
                    }
                    return Ok(host_name);
                }
                ServerMsg::Error { message, fatal: true, .. } => return Err(LinkError::Fatal(message)),
                ServerMsg::Error { message, .. } => return Err(LinkError::Transient(message)),
                // Nothing else is legal before `ready`; skip rather than fail.
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| LinkError::Transient("the desktop did not finish the handshake".into()))??;
    Ok(Session { conn, send, recv, host_name, device_name, token })
}

fn frame_err(e: FrameError) -> LinkError {
    LinkError::Transient(match e {
        FrameError::Closed => "the desktop closed the connection".to_string(),
        other => other.to_string(),
    })
}
