//! Remote dictation on the link: the phone's `dictstart` / `dictstop` /
//! `dictcancel` messages and its `dictaudio` stream (see
//! docs/design/remote-dictation-protocol.md), wired to the desktop's dictation
//! pipeline (`crate::dictation::remote`). Every session belongs to the
//! connection that started it: another connection can't feed or steer it, and a
//! dropped link cancels it.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use flowcode_remote_proto::{DictEndReason, ServerMsg};
use flowcode_shared::i18n::tr;
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};

use super::MAX_ID_BYTES;
use crate::dictation::remote::{self as engine, Budget, EndReason, Event, PcmDecoder};

/// How long a `dictaudio` stream waits for its `dictstart` to be handled: the
/// two travel on different streams, so the stream can win the race.
const SESSION_WAIT: Duration = Duration::from_secs(2);

enum Ctl {
    Stop,
    Cancel,
}

/// What the audio stream tells the session task.
enum Audio {
    Bytes(Vec<u8>),
    /// The phone finished the stream.
    Eof,
    /// The stream broke off.
    Broken,
    /// More audio than a session may have.
    TooLong,
}

struct Entry {
    /// Taken by the one audio stream of the session.
    audio: Option<UnboundedSender<Audio>>,
    ctl: UnboundedSender<Ctl>,
}

/// (connection id, session id) -> the session.
static SESSIONS: LazyLock<Mutex<HashMap<(u64, String), Entry>>> = LazyLock::new(Mutex::default);

fn sessions() -> std::sync::MutexGuard<'static, HashMap<(u64, String), Entry>> {
    SESSIONS.lock().unwrap_or_else(|e| e.into_inner())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_BYTES && !id.contains(char::is_whitespace)
}

fn end_msg(session: &str, reason: DictEndReason, code: Option<&str>, message: Option<String>) -> ServerMsg {
    ServerMsg::DictEnd { session: session.to_string(), reason, code: code.map(str::to_string), message }
}

/// `dictstart`: registers the session and runs it on its own task. A phone has
/// one session at a time per connection.
pub(super) fn start(app: &AppHandle, conn_id: u64, out: mpsc::Sender<ServerMsg>, session: String, hint: Option<String>) {
    let (audio_tx, audio_rx) = mpsc::unbounded_channel();
    let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
    let refusal = if !valid_id(&session) {
        Some(("failed", tr("Sessione di dettatura non valida", "Invalid dictation session")))
    } else {
        let mut all = sessions();
        if all.keys().any(|(conn, _)| *conn == conn_id) {
            Some(("busy", tr("Una dettatura è già in corso su questo dispositivo", "A dictation is already running for this device")))
        } else {
            all.insert((conn_id, session.clone()), Entry { audio: Some(audio_tx), ctl: ctl_tx });
            None
        }
    };
    if let Some((code, message)) = refusal {
        // try_send: a full queue means a phone that stopped reading.
        let _ = out.try_send(end_msg(&session, DictEndReason::Error, Some(code), Some(message.to_string())));
        return;
    }
    let app = app.clone();
    tokio::spawn(async move {
        // Removes the entry even if `run_session` panics (else: "busy" forever).
        struct Remove(Option<(u64, String)>);
        impl Drop for Remove {
            fn drop(&mut self) {
                if let Some(key) = self.0.take() {
                    sessions().remove(&key);
                }
            }
        }
        let _entry = Remove(Some((conn_id, session.clone())));
        run_session(&app, &out, &session, hint, audio_rx, ctl_rx).await;
    });
}

fn control(conn_id: u64, session: &str, ctl: Ctl) {
    if let Some(entry) = sessions().get(&(conn_id, session.to_string())) {
        let _ = entry.ctl.send(ctl);
    }
}

/// `dictstop`.
pub(super) fn stop(conn_id: u64, session: &str) {
    control(conn_id, session, Ctl::Stop);
}

/// `dictcancel`.
pub(super) fn cancel(conn_id: u64, session: &str) {
    control(conn_id, session, Ctl::Cancel);
}

/// The link dropped: its sessions are cancelled.
pub(super) fn cancel_all(conn_id: u64) {
    for ((conn, _), entry) in sessions().iter() {
        if *conn == conn_id {
            let _ = entry.ctl.send(Ctl::Cancel);
        }
    }
}

/// The audio channel of `session` if this connection started it and no stream
/// has it yet; waits up to `wait` for a `dictstart` that is still on its way.
async fn claim_audio(conn_id: u64, session: &str, wait: Duration) -> Option<UnboundedSender<Audio>> {
    let key = (conn_id, session.to_string());
    let deadline = tokio::time::Instant::now() + wait;
    loop {
        if let Some(entry) = sessions().get_mut(&key) {
            // A second stream for the same session is refused.
            return entry.audio.take();
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// The body of a `dictaudio` stream: raw s16le until the phone finishes it.
/// False if the stream is refused (unknown session, or not this connection's).
pub(super) async fn receive_audio<R: tokio::io::AsyncRead + Unpin>(conn_id: u64, session: &str, recv: &mut R) -> bool {
    receive_audio_within(conn_id, session, recv, SESSION_WAIT).await
}

async fn receive_audio_within<R: tokio::io::AsyncRead + Unpin>(conn_id: u64, session: &str, recv: &mut R, wait: Duration) -> bool {
    if !valid_id(session) {
        return false;
    }
    let Some(audio) = claim_audio(conn_id, session, wait).await else { return false };
    let mut budget = Budget::default();
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match recv.read(&mut buf).await {
            Ok(0) => {
                let _ = audio.send(Audio::Eof);
                return true;
            }
            Ok(n) => {
                if !budget.take(n) {
                    let _ = audio.send(Audio::TooLong);
                    return true;
                }
                if audio.send(Audio::Bytes(buf[..n].to_vec())).is_err() {
                    // The session is over; nothing is listening.
                    return true;
                }
            }
            Err(_) => {
                let _ = audio.send(Audio::Broken);
                return true;
            }
        }
    }
}

/// The messages of one session, from `dictready` to `dictend`.
async fn run_session(
    app: &AppHandle,
    out: &mpsc::Sender<ServerMsg>,
    session: &str,
    hint: Option<String>,
    mut audio_rx: UnboundedReceiver<Audio>,
    mut ctl_rx: UnboundedReceiver<Ctl>,
) {
    let (events_tx, mut events) = mpsc::unbounded_channel();
    // Audio and control meanwhile queue up in their channels.
    let handle = match engine::start(app, hint.as_deref(), events_tx).await {
        Ok(handle) => handle,
        Err(e) => {
            let _ = out.send(end_msg(session, DictEndReason::Error, Some(e.code()), Some(e.message()))).await;
            return;
        }
    };
    if out.send(ServerMsg::DictReady { session: session.to_string() }).await.is_err() {
        handle.cancel();
        return;
    }
    let mut decoder = PcmDecoder::default();
    // The session was told to end: further audio is ignored.
    let mut finished = false;
    let (mut audio_open, mut ctl_open) = (true, true);
    // Set when this side ended the session: what `dictend` says instead of "cancelled".
    let mut failure: Option<String> = None;
    loop {
        tokio::select! {
            event = events.recv() => {
                let msg = match event {
                    Some(Event::Partial(text)) => ServerMsg::DictPartial { session: session.to_string(), text },
                    Some(Event::Final(text)) => ServerMsg::DictFinal { session: session.to_string(), text },
                    Some(Event::End { reason, message }) => {
                        let msg = match (failure.take(), reason) {
                            (Some(message), _) => end_msg(session, DictEndReason::Error, Some("failed"), Some(message)),
                            (None, EndReason::Done) => end_msg(session, DictEndReason::Done, None, None),
                            (None, EndReason::Cancelled) => end_msg(session, DictEndReason::Cancelled, None, None),
                            (None, EndReason::Error) => end_msg(session, DictEndReason::Error, Some("failed"), message),
                        };
                        let _ = out.send(msg).await;
                        return;
                    }
                    // The thread died without a word.
                    None => {
                        let message = tr("Il riconoscimento vocale si è interrotto.", "Speech recognition stopped unexpectedly.").to_string();
                        let _ = out.send(end_msg(session, DictEndReason::Error, Some("failed"), Some(message))).await;
                        return;
                    }
                };
                if out.send(msg).await.is_err() {
                    handle.cancel();
                    return;
                }
            }
            audio = audio_rx.recv(), if audio_open => match audio {
                Some(Audio::Bytes(bytes)) => {
                    if !finished {
                        handle.audio(decoder.push(&bytes));
                    }
                }
                Some(Audio::Eof) => {
                    audio_open = false;
                    if !finished {
                        finished = true;
                        handle.stop();
                    }
                }
                Some(Audio::TooLong) => {
                    audio_open = false;
                    if !finished {
                        finished = true;
                        failure = Some(tr("Registrazione troppo lunga (massimo 10 minuti).", "Recording too long (10 minutes at most).").to_string());
                        handle.cancel();
                    }
                }
                Some(Audio::Broken) | None => {
                    audio_open = false;
                    if !finished {
                        finished = true;
                        failure = Some(tr("Flusso audio interrotto.", "The audio stream was interrupted.").to_string());
                        handle.cancel();
                    }
                }
            },
            ctl = ctl_rx.recv(), if ctl_open => match ctl {
                Some(Ctl::Stop) => {
                    if !finished {
                        finished = true;
                        handle.stop();
                    }
                }
                Some(Ctl::Cancel) | None => {
                    ctl_open = false;
                    if !finished {
                        finished = true;
                        handle.cancel();
                    }
                }
            },
            // The link is gone: nobody to tell.
            _ = out.closed() => {
                handle.cancel();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_WAIT: Duration = Duration::ZERO;

    #[test]
    fn session_ids_are_one_short_token() {
        assert!(valid_id("a1-b2"));
        assert!(!valid_id(""));
        assert!(!valid_id("a b"));
        assert!(!valid_id("a\nb"));
        assert!(!valid_id(&"x".repeat(MAX_ID_BYTES + 1)));
        assert!(valid_id(&"x".repeat(MAX_ID_BYTES)));
    }

    #[tokio::test]
    async fn a_stream_for_a_session_of_another_connection_is_refused() {
        let (audio_tx, _audio_rx) = mpsc::unbounded_channel();
        let (ctl_tx, _ctl_rx) = mpsc::unbounded_channel();
        sessions().insert((7, "own".into()), Entry { audio: Some(audio_tx), ctl: ctl_tx });
        let mut empty: &[u8] = &[];
        assert!(!receive_audio_within(8, "own", &mut empty, NO_WAIT).await);
        assert!(!receive_audio_within(7, "nope", &mut empty, NO_WAIT).await);
        // The right connection gets it once; a second stream is refused.
        assert!(receive_audio_within(7, "own", &mut empty, NO_WAIT).await);
        assert!(!receive_audio_within(7, "own", &mut empty, NO_WAIT).await);
        sessions().remove(&(7, "own".into()));
    }

    #[tokio::test]
    async fn audio_over_the_limit_ends_the_stream_with_too_long() {
        let (audio_tx, mut audio_rx) = mpsc::unbounded_channel();
        let (ctl_tx, _ctl_rx) = mpsc::unbounded_channel();
        sessions().insert((9, "big".into()), Entry { audio: Some(audio_tx), ctl: ctl_tx });
        let big = vec![0u8; engine::MAX_BYTES + 2];
        let mut body: &[u8] = &big;
        assert!(receive_audio_within(9, "big", &mut body, NO_WAIT).await);
        let mut got_too_long = false;
        while let Ok(a) = audio_rx.try_recv() {
            got_too_long |= matches!(a, Audio::TooLong);
        }
        assert!(got_too_long);
        sessions().remove(&(9, "big".into()));
    }
}
