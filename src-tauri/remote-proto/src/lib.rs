//! Wire protocol between Flowcode desktop and its phone app. Pure types and
//! framing - no Tauri, no iroh - so both ends (and any future client) share
//! one definition. See docs/remote-protocol.md for the prose version.

mod frame;
mod msg;
mod ticket;

pub use frame::{read_frame, write_frame, FrameError, MAX_FRAME};
pub use msg::*;
pub use ticket::{PairingTicket, TicketError};

/// Short code both screens show while pairing, derived from the phone's node
/// id: the user compares them to be sure the request on the desktop comes from
/// the phone in their hand. First 6 characters of the SHA-256 of the node id,
/// base32 (RFC 4648, upper case, no padding) - 30 bits, plenty to tell two
/// requests apart, and not meant to be a secret.
pub fn node_fingerprint(node_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(node_id.trim().as_bytes());
    data_encoding::BASE32_NOPAD.encode(&hash[..5]).chars().take(6).collect()
}

#[cfg(test)]
mod tests {
    use super::node_fingerprint;

    #[test]
    fn fingerprint_is_short_stable_and_node_specific() {
        let a = node_fingerprint("node-a");
        assert_eq!(a.len(), 6);
        assert!(a.chars().all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)));
        assert_eq!(a, node_fingerprint(" node-a "));
        assert_ne!(a, node_fingerprint("node-b"));
    }
}

/// ALPN the desktop's iroh endpoint accepts. The trailing number is the
/// protocol major version: a breaking change gets a new ALPN so old phones
/// fail the handshake instead of misreading frames.
pub const ALPN: &[u8] = b"flowcode/remote/1";

/// Largest `input` payload (bytes of UTF-8) a client may send in one frame.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
