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
pub const CAPABILITIES: &[&str] = &["fileExplorer", "rename", "profiles", "profileLogin", "providerAuth", "profileAgents", "newTabProfile", "background", "gemini", "closeTab", "chat", "agentViews", "linkPreview", "compress", "terminalChat", "chatRename", "chatCloseTab", "chatModel", "chatThought", "chatClear", "chatImage", "chatWebImages", "desktopUpdate", "preview", "chatPreview", "agentInsight", "chatPromptAck", "chatImageRequestId"];

/// What a preview stream is pointed at. After `auth`, the phone opens one extra
/// bidirectional stream per HTTP connection of its in-app browser. The first
/// line on it (`preview_header`, UTF-8, ends with `\n`, at most
/// `PREVIEW_HEADER_MAX` bytes) names the target; what follows is plain
/// HTTP/1.1 in both directions. `Port` is a raw tunnel to that loopback port of
/// the desktop (so WebSocket upgrades work too); `Files` is served by the
/// desktop itself from the working directory of that terminal tab. `ChatFiles`
/// uses the same confined file server, rooted in a chat's working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreviewTarget {
    Port(u16),
    Files(String),
    /// Files under a chat's working folder; requires `chatPreview`.
    ChatFiles(String),
}

/// Longest first line a preview stream may start with, newline included.
pub const PREVIEW_HEADER_MAX: usize = 512;

/// The first line of a preview stream for `target`, newline included.
pub fn preview_header(target: &PreviewTarget) -> String {
    match target {
        PreviewTarget::Port(port) => format!("port {port}\n"),
        PreviewTarget::Files(pty_id) => format!("files {pty_id}\n"),
        PreviewTarget::ChatFiles(chat_id) => format!("chatfiles {chat_id}\n"),
    }
}

/// Parses a first line (with or without its newline). `None` for anything else.
pub fn parse_preview_header(line: &str) -> Option<PreviewTarget> {
    let line = line.trim_end_matches(['\n', '\r']);
    let (kind, rest) = line.split_once(' ')?;
    match kind {
        "port" => rest.parse::<u16>().ok().filter(|p| *p != 0).map(PreviewTarget::Port),
        "files" if !rest.is_empty() && !rest.contains(char::is_whitespace) => Some(PreviewTarget::Files(rest.to_string())),
        "chatfiles" if !rest.is_empty() && !rest.contains(char::is_whitespace) => Some(PreviewTarget::ChatFiles(rest.to_string())),
        _ => None,
    }
}

/// Largest `input` payload (bytes of UTF-8) a client may send in one frame.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;

#[cfg(test)]
mod tests {
    use super::{node_fingerprint, parse_preview_header, preview_header, PreviewTarget};

    #[test]
    fn preview_headers_round_trip_and_refuse_junk() {
        for target in [PreviewTarget::Port(5173), PreviewTarget::Files("pty-1".into()), PreviewTarget::ChatFiles("chat-1".into())] {
            assert_eq!(parse_preview_header(&preview_header(&target)), Some(target));
        }
        assert_eq!(parse_preview_header("port 80\r\n"), Some(PreviewTarget::Port(80)));
        for bad in ["", "port", "port 0", "port 70000", "port x", "files", "files a b", "chatfiles", "chatfiles ", "chatfiles a b", "ftp 1", "GET / HTTP/1.1"] {
            assert_eq!(parse_preview_header(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn fingerprint_is_short_stable_and_node_specific() {
        let a = node_fingerprint("node-a");
        assert_eq!(a.len(), 6);
        assert!(a.chars().all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)));
        assert_eq!(a, node_fingerprint(" node-a "));
        assert_ne!(a, node_fingerprint("node-b"));
    }
}
