//! Framing: `u32` big-endian length, then that many bytes of UTF-8 JSON. A
//! peer that announced the `compress` capability may also send a frame whose
//! length has the top bit set: the body is then raw deflate of the JSON.

use std::io::{Read, Write};

use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use serde::{de::DeserializeOwned, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Largest frame accepted or produced (1 MiB). The length prefix is checked
/// *before* allocating, so a hostile peer can't make us reserve gigabytes.
pub const MAX_FRAME: usize = 1024 * 1024;

/// Top bit of the length: the body is deflated. `MAX_FRAME` leaves it free, so
/// a peer that doesn't know it reads an oversized frame and hangs up, which is
/// why it is only ever sent to a peer that asked for it.
const COMPRESSED: u32 = 1 << 31;

/// Frames smaller than this are never compressed: the saving is a few bytes
/// and the round trip through the codec costs more than the packet it spares.
pub const COMPRESS_MIN: usize = 1024;

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
    let len = u32::from_be_bytes(len);
    let compressed = len & COMPRESSED != 0;
    let len = (len & !COMPRESSED) as usize;
    if len > MAX_FRAME {
        return Err(FrameError::TooLarge(len));
    }
    let mut buf = vec![0u8; len];
    reader.read_exact(&mut buf).await.map_err(FrameError::Io)?;
    if compressed {
        buf = inflate(&buf)?;
    }
    serde_json::from_slice(&buf).map_err(FrameError::Json)
}

/// Inflates a body, refusing to produce more than `MAX_FRAME` (a few KiB of
/// deflate can stand for gigabytes).
fn inflate(body: &[u8]) -> Result<Vec<u8>, FrameError> {
    let mut out = Vec::new();
    DeflateDecoder::new(body).take(MAX_FRAME as u64 + 1).read_to_end(&mut out).map_err(FrameError::Io)?;
    if out.len() > MAX_FRAME {
        return Err(FrameError::TooLarge(out.len()));
    }
    Ok(out)
}

/// `body` deflated, if that is worth it: at least `COMPRESS_MIN` long and
/// shrinking by a tenth or more. Fast level: terminal output and chat events
/// repeat themselves a lot, so even the cheapest setting more than halves them.
fn deflate(body: &[u8]) -> Option<Vec<u8>> {
    if body.len() < COMPRESS_MIN {
        return None;
    }
    let mut encoder = DeflateEncoder::new(Vec::with_capacity(body.len() / 2), Compression::fast());
    encoder.write_all(body).ok()?;
    let packed = encoder.finish().ok()?;
    (packed.len() < body.len() - body.len() / 10).then_some(packed)
}

/// The bytes of one frame: length, then the body, deflated when `compress` is
/// set and it pays.
pub fn encode_frame<T: Serialize>(msg: &T, compress: bool) -> Result<Vec<u8>, FrameError> {
    let body = serde_json::to_vec(msg).map_err(FrameError::Json)?;
    if body.len() > MAX_FRAME {
        return Err(FrameError::TooLarge(body.len()));
    }
    let (body, flag) = match compress.then(|| deflate(&body)).flatten() {
        Some(packed) => (packed, COMPRESSED),
        None => (body, 0),
    };
    let mut out = Vec::with_capacity(4 + body.len());
    out.extend_from_slice(&(body.len() as u32 | flag).to_be_bytes());
    out.extend_from_slice(&body);
    Ok(out)
}

/// Encodes and writes one frame (length and body in a single write, then a
/// flush so it doesn't sit in a buffer).
pub async fn write_frame<W, T>(writer: &mut W, msg: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    write_frame_with(writer, msg, false).await
}

/// [`write_frame`], deflating large frames when `compress` is set. Only for a
/// peer that announced the `compress` capability.
pub async fn write_frame_with<W, T>(writer: &mut W, msg: &T, compress: bool) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let out = encode_frame(msg, compress)?;
    writer.write_all(&out).await.map_err(FrameError::Io)?;
    writer.flush().await.map_err(FrameError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ClientMsg, ServerMsg};
    use flate2::{write::DeflateEncoder, Compression};
    use std::io::Write;

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

    /// Colored build output, the kind of text a terminal or a chat replay carries.
    fn sample_output(bytes: usize) -> String {
        let mut text = String::new();
        let mut n = 0;
        while text.len() < bytes {
            text.push_str(&format!("\u{1b}[32m   Compiling\u{1b}[0m crate-{n} v0.{} (/home/user/project/crates/crate-{n})\r\n", n % 7));
            n += 1;
        }
        text
    }

    #[tokio::test]
    async fn compressed_frames_round_trip_and_small_ones_stay_plain() {
        let (mut a, mut b) = tokio::io::duplex(256 * 1024);
        let big = ServerMsg::Output { pty_id: "p".into(), data: sample_output(20_000) };
        let small = ServerMsg::Output { pty_id: "p".into(), data: "ls".into() };
        write_frame_with(&mut a, &big, true).await.unwrap();
        write_frame_with(&mut a, &small, true).await.unwrap();
        assert!(encode_frame(&big, true).unwrap().len() < encode_frame(&big, false).unwrap().len() / 3);
        // A small frame is byte for byte what the plain writer sends.
        assert_eq!(encode_frame(&small, true).unwrap(), encode_frame(&small, false).unwrap());
        assert_eq!(read_frame::<_, ServerMsg>(&mut b).await.unwrap(), big);
        assert_eq!(read_frame::<_, ServerMsg>(&mut b).await.unwrap(), small);
    }

    #[tokio::test]
    async fn a_deflate_bomb_is_refused() {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(&vec![b' '; MAX_FRAME * 4]).unwrap();
        let bomb = encoder.finish().unwrap();
        assert!(bomb.len() < MAX_FRAME);
        let (mut a, mut b) = tokio::io::duplex(MAX_FRAME);
        a.write_all(&(bomb.len() as u32 | COMPRESSED).to_be_bytes()).await.unwrap();
        a.write_all(&bomb).await.unwrap();
        assert!(matches!(read_frame::<_, ClientMsg>(&mut b).await, Err(FrameError::TooLarge(_))));
    }

    #[tokio::test]
    async fn corrupt_deflate_is_an_io_error() {
        let (mut a, mut b) = tokio::io::duplex(64);
        a.write_all(&(8u32 | COMPRESSED).to_be_bytes()).await.unwrap();
        a.write_all(&[0xff; 8]).await.unwrap();
        assert!(matches!(read_frame::<_, ClientMsg>(&mut b).await, Err(FrameError::Io(_))));
    }

    /// Run with `cargo test -p flowcode-remote-proto --release -- --ignored --nocapture`.
    #[test]
    #[ignore = "measurement: prints sizes and encode times"]
    fn measure_frames() {
        for (name, bytes) in [("output 8 KiB", 8 * 1024), ("output 32 KiB", 32 * 1024), ("snapshot 256 KiB", 256 * 1024)] {
            let msg = ServerMsg::Output { pty_id: "p".into(), data: sample_output(bytes) };
            let rounds = 200;
            let started = std::time::Instant::now();
            let mut plain = 0;
            for _ in 0..rounds {
                plain = encode_frame(&msg, false).unwrap().len();
            }
            let plain_time = started.elapsed() / rounds;
            let started = std::time::Instant::now();
            let mut packed = 0;
            for _ in 0..rounds {
                packed = encode_frame(&msg, true).unwrap().len();
            }
            let packed_time = started.elapsed() / rounds;
            println!("{name}: {plain} B plain ({plain_time:?}), {packed} B deflated ({packed_time:?}), {:.1}x", plain as f64 / packed as f64);
        }
    }
}
