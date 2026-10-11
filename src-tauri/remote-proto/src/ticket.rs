//! What the pairing QR encodes: `flowcode://pair?t=<base64url(JSON)>`.

use data_encoding::BASE64URL_NOPAD;
use serde::{Deserialize, Serialize};

const PREFIX: &str = "flowcode://pair?t=";

/// Everything a phone needs to reach and pair with a desktop.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PairingTicket {
    /// The desktop's iroh endpoint address as an `iroh-tickets`
    /// `EndpointTicket` string (node id + relay + direct addresses). Opaque
    /// here; the phone hands it to iroh's ticket parser.
    pub node: String,
    /// The one-time pairing code to send in `pair`.
    pub code: String,
    /// The desktop's name, to show before connecting.
    pub host: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TicketError {
    NotATicket,
    BadEncoding,
    BadJson,
}

impl std::fmt::Display for TicketError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            TicketError::NotATicket => "not a flowcode pairing link",
            TicketError::BadEncoding => "pairing link is not valid base64url",
            TicketError::BadJson => "pairing link has an unreadable payload",
        })
    }
}

impl std::error::Error for TicketError {}

impl PairingTicket {
    pub fn encode(&self) -> String {
        // Serializing three strings cannot fail.
        let json = serde_json::to_vec(self).unwrap_or_default();
        format!("{PREFIX}{}", BASE64URL_NOPAD.encode(&json))
    }

    pub fn parse(url: &str) -> Result<PairingTicket, TicketError> {
        let payload = url.trim().strip_prefix(PREFIX).ok_or(TicketError::NotATicket)?;
        let json = BASE64URL_NOPAD.decode(payload.as_bytes()).map_err(|_| TicketError::BadEncoding)?;
        serde_json::from_slice(&json).map_err(|_| TicketError::BadJson)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> PairingTicket {
        PairingTicket { node: "endpointabc".into(), code: "0123abcd".into(), host: "Max PC".into() }
    }

    #[test]
    fn round_trip() {
        let url = sample().encode();
        assert!(url.starts_with("flowcode://pair?t="));
        assert_eq!(PairingTicket::parse(&url), Ok(sample()));
        assert_eq!(PairingTicket::parse(&format!("  {url}\n")), Ok(sample()));
    }

    #[test]
    fn rejects_garbage() {
        assert_eq!(PairingTicket::parse("https://example.com"), Err(TicketError::NotATicket));
        assert_eq!(PairingTicket::parse("flowcode://pair?t=***"), Err(TicketError::BadEncoding));
        let not_json = BASE64URL_NOPAD.encode(b"hello");
        assert_eq!(PairingTicket::parse(&format!("flowcode://pair?t={not_json}")), Err(TicketError::BadJson));
    }
}
