//! Framing: `u32` big-endian length, then that many bytes of UTF-8 JSON.

use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Largest frame accepted or produced (1 MiB). The length prefix is checked
/// *before* allocating, so a hostile peer can't make us reserve gigabytes.
pub const MAX_FRAME: usize = 1024 * 1024;

#[derive(Debug)]
pub enum FrameError {
    /// The stream ended cleanly between frames.
    Closed,
    TooLarge(usize),
    Io(std::io::Error),
    Json(serde_json::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Closed => write!(f, "stream closed"),
            FrameError::TooLarge(n) => write!(f, "frame of {n} bytes exceeds the {MAX_FRAME} byte limit"),
            FrameError::Io(e) => write!(f, "io: {e}"),
            FrameError::Json(e) => write!(f, "json: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

/// Reads one frame and decodes it. `Err(Closed)` on a clean EOF at a frame
/// boundary; an EOF in the middle of a frame is an `Io` error.
pub async fn read_frame<R, T>(reader: &mut R) -> Result<T, FrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut len = [0u8; 4];
    match reader.read(&mut len[..1]).await {
        Ok(0) => return Err(FrameError::Closed),
        Ok(_) => {}
        Err(e) => return Err(FrameError::Io(e)),
    }
    reader.read_exact(&mut len[1..]).await.map_err(FrameError::Io)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await.map_err(FrameError::Io)?;
    serde_json::from_slice(&buf).map_err(FrameError::Json)
}

/// Encodes and writes one frame (length and body in a single write, then a
/// flush so it doesn't sit in a buffer).
pub async fn write_frame<W, T>(writer: &mut W, msg: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let body = serde_json::to_vec(msg).map_err(FrameError::Json)?;
    if body.len() > MAX_FRAME {
        return Err(FrameError::TooLarge(body.len()));
    }
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(&body);
    writer.write_all(&out).await.map_err(FrameError::Io)?;
    writer.flush().await.map_err(FrameError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ClientMsg, ServerMsg};

    #[tokio::test]
    async fn round_trip_and_clean_close() {
        let (mut a, mut b) = tokio::io::duplex(64 * 1024);
        write_frame(&mut a, &ClientMsg::Ping).await.unwrap();
        write_frame(&mut a, &ClientMsg::List).await.unwrap();
        drop(a);
        assert!(matches!(read_frame::<_, ClientMsg>(&mut b).await, Ok(ClientMsg::Ping)));
        assert!(matches!(read_frame::<_, ClientMsg>(&mut b).await, Ok(ClientMsg::List)));
        assert!(matches!(read_frame::<_, ClientMsg>(&mut b).await, Err(FrameError::Closed)));
    }

    #[tokio::test]
    async fn oversized_length_is_rejected_before_reading() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&((MAX_FRAME as u32) + 1).to_be_bytes()).await.unwrap();
        assert!(matches!(read_frame::<_, ClientMsg>(&mut b).await, Err(FrameError::TooLarge(_))));
    }

    #[tokio::test]
    async fn oversized_message_is_not_written() {
        let (mut a, _b) = tokio::io::duplex(64);
        let msg = ServerMsg::Output { pty_id: "x".into(), data: "a".repeat(MAX_FRAME) };
        assert!(matches!(write_frame(&mut a, &msg).await, Err(FrameError::TooLarge(_))));
    }

    #[tokio::test]
    async fn truncated_frame_is_an_io_error() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&10u32.to_be_bytes()).await.unwrap();
        a.write_all(b"{}").await.unwrap();
        drop(a);
        assert!(matches!(read_frame::<_, ClientMsg>(&mut b).await, Err(FrameError::Io(_))));
    }
}
