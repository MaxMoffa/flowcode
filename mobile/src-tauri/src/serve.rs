//! One live link: the reader task, the select loop that pings, forwards
//! and writes, and the guard that tears the connection down.

use crate::backoff::{DEAD_AFTER, PING_EVERY, PROBE_TIMEOUT};
use crate::link::Session;
use crate::state::{Remote, OUT_QUEUE};
use flowcode_remote_proto::{ClientMsg, FrameError, ServerMsg};
use std::sync::atomic::Ordering;
use std::time::Instant;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// What the reader task hands to `serve`.
pub(crate) enum Inbound {
    Msg(ServerMsg),
    /// A frame that arrived whole but is not a message we know (a newer
    /// desktop): skipped, the link goes on.
    Skipped(String),
    /// I/O or framing error: the stream cannot be trusted any more.
    Failed(String),
}

pub(crate) fn classify_frame(frame: Result<ServerMsg, FrameError>) -> Inbound {
    match frame {
        Ok(msg) => Inbound::Msg(msg),
        Err(FrameError::Json(e)) => Inbound::Skipped(e.to_string()),
        Err(e) => Inbound::Failed(e.to_string()),
    }
}

/// Dropped when `serve` ends or its task is aborted (`stop_task`): without it
/// an aborted loop would leave the reader task and the QUIC connection alive.
pub(crate) struct ServeGuard {
    reader: tokio::task::AbortHandle,
    conn: iroh::endpoint::Connection,
}

impl Drop for ServeGuard {
    fn drop(&mut self) {
        self.reader.abort();
        self.conn.close(0u32.into(), b"bye");
    }
}


pub(crate) enum Exit {
    /// The desktop refused us for good.
    Fatal(String),
    Lost(String),
}

pub(crate) async fn serve(app: &AppHandle, remote: &Remote, mut session: Session) -> Exit {
    let (out_tx, mut out_rx) = mpsc::channel::<ClientMsg>(OUT_QUEUE);
    remote.lock().out = Some(out_tx);

    // read_frame is not cancel-safe, so it lives in its own task and the
    // select below only touches the channel.
    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<Inbound>();
    let mut recv = session.recv;
    let reader = tokio::spawn(async move {
        loop {
            let item = classify_frame(flowcode_remote_proto::read_frame::<_, ServerMsg>(&mut recv).await);
            let stop = matches!(item, Inbound::Failed(_));
            if in_tx.send(item).is_err() || stop {
                break;
            }
        }
    });
    // Also covers the loop being aborted mid-`serve`.
    let _guard = ServeGuard { reader: reader.abort_handle(), conn: session.conn.clone() };

    let exit = async {
        let mut ping = tokio::time::interval(PING_EVERY);
        ping.tick().await;
        let mut last_rx = Instant::now();
        // Set when the app resumes: the link must prove itself by then.
        let mut probe_until: Option<tokio::time::Instant> = None;
        if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::List).await {
            return Exit::Lost(e.to_string());
        }
        // Back on a link while hidden: the desktop starts out sending everything.
        if !remote.visible.load(Ordering::SeqCst) && remote.bg_settings().enabled {
            if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::Background { on: true }).await {
                return Exit::Lost(e.to_string());
            }
        }
        let mut warned_unknown = false;
        loop {
            let probe = async {
                match probe_until {
                    Some(t) => tokio::time::sleep_until(t).await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                incoming = in_rx.recv() => match incoming {
                    Some(Inbound::Msg(msg)) => {
                        last_rx = Instant::now();
                        probe_until = None;
                        let _ = app.emit("remote://msg", &msg);
                        if let ServerMsg::Notify { title, body, tab_id } = &msg {
                            remote.on_notify(title, body, tab_id.as_deref());
                        }
                        if let ServerMsg::Error { message, fatal: true, .. } = msg {
                            return Exit::Fatal(message);
                        }
                    }
                    Some(Inbound::Skipped(e)) => {
                        // Still proof that the link is alive.
                        last_rx = Instant::now();
                        probe_until = None;
                        if !warned_unknown {
                            warned_unknown = true;
                            remote.log.push(format!("skipped a message this version does not understand: {e}"));
                        }
                    }
                    Some(Inbound::Failed(e)) => return Exit::Lost(e),
                    None => return Exit::Lost("connection closed".into()),
                },
                outgoing = out_rx.recv() => {
                    let Some(msg) = outgoing else { return Exit::Lost("stopped".into()) };
                    if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &msg).await {
                        return Exit::Lost(e.to_string());
                    }
                }
                _ = ping.tick() => {
                    if last_rx.elapsed() > DEAD_AFTER {
                        return Exit::Lost("the desktop stopped answering".into());
                    }
                    if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::Ping).await {
                        return Exit::Lost(e.to_string());
                    }
                }
                _ = remote.resume.notified() => {
                    remote.log.push("app resumed: probing the link");
                    if let Err(e) = flowcode_remote_proto::write_frame(&mut session.send, &ClientMsg::Ping).await {
                        return Exit::Lost(e.to_string());
                    }
                    probe_until.get_or_insert_with(|| tokio::time::Instant::now() + PROBE_TIMEOUT);
                }
                _ = probe => return Exit::Lost("the desktop did not answer after resuming".into()),
            }
        }
    }
    .await;

    remote.lock().out = None;
    // Before the guard closes the connection ourselves: what QUIC saw end it.
    match session.conn.close_reason() {
        Some(reason) => remote.log.push(format!("QUIC connection closed: {reason}")),
        None => remote.log.push("QUIC connection still open when the link was given up"),
    }
    exit
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_undecodable_frame_is_skipped_but_io_errors_are_fatal() {
        let bad = serde_json::from_str::<ServerMsg>(r#"{"t":"from-the-future"}"#).unwrap_err();
        assert!(matches!(classify_frame(Err(FrameError::Json(bad))), Inbound::Skipped(_)));
        assert!(matches!(classify_frame(Err(FrameError::Closed)), Inbound::Failed(_)));
        assert!(matches!(classify_frame(Err(FrameError::TooLarge(1 << 30))), Inbound::Failed(_)));
        assert!(matches!(classify_frame(Ok(ServerMsg::Pong)), Inbound::Msg(ServerMsg::Pong)));
    }
}
