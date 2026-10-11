//! Wire protocol between Flowcode desktop and its phone app. Pure types and
//! framing - no Tauri, no iroh - so both ends (and any future client) share
//! one definition. See docs/remote-protocol.md for the prose version.

mod frame;
mod msg;
mod ticket;

pub use frame::{read_frame, write_frame, FrameError, MAX_FRAME};
pub use msg::*;
pub use ticket::{PairingTicket, TicketError};

/// ALPN the desktop's iroh endpoint accepts. The trailing number is the
/// protocol major version: a breaking change gets a new ALPN so old phones
/// fail the handshake instead of misreading frames.
pub const ALPN: &[u8] = b"flowcode/remote/1";

/// Largest `input` payload (bytes of UTF-8) a client may send in one frame.
pub const MAX_INPUT_BYTES: usize = 64 * 1024;
