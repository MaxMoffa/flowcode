//! Wire protocol between Flowcode desktop and its phone app. Pure types and
//! framing - no Tauri, no iroh - so both ends (and any future client) share
//! one definition. See docs/remote-protocol.md for the prose version.

mod frame;
mod msg;
mod ticket;

pub use frame::{encode_frame, read_frame, write_frame, write_frame_with, FrameError, COMPRESS_MIN, MAX_FRAME};
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

/// ALPN the desktop's iroh endpoint accepts. The trailing number is the
/// protocol major version: a breaking change gets a new ALPN so old phones
/// fail the handshake instead of misreading frames.
pub const ALPN: &[u8] = b"flowcode/remote/1";

/// Revision of the message set, sent in `ready`. 1 is what every desktop
/// without a `proto` field speaks; a breaking change that an ALPN bump does not
/// cover raises it, and a phone refuses desktops below its own minimum.
pub const PROTOCOL_VERSION: u32 = 2;

/// Features this desktop supports, sent in `ready` as `caps`, so the phone
/// can hide what an older desktop lacks. Keep in step with `RemoteCap` in
/// shared/remote-types.ts and docs/remote-protocol.md.
pub const CAPABILITIES: &[&str] = &["rename", "profiles", "profileLogin", "profileAgents", "newTabProfile", "background", "gemini", "closeTab", "chat", "agentViews", "linkPreview", "compress", "terminalChat", "chatRename", "chatCloseTab", "chatModel", "chatThought", "chatClear", "chatImage", "chatWebImages", "desktopUpdate"];

/// Largest `input` payload (bytes of UTF-8) a client may send in one frame.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;

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
