//! The transport-agnostic half of a loopback tunnel: a TCP listener whose
//! connections are each carried over one stream of a host's link (desktop
//! client `remote_client/tunnel.rs`, phone `tunnel.rs`). The streams themselves
//! (iroh) stay with the callers.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

/// Binds `preferred` when given and free, else any free loopback port.
pub async fn bind_preferring(preferred: Option<u16>) -> std::io::Result<TcpListener> {
    if let Some(port) = preferred {
        if let Ok(listener) = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, port))).await {
            return Ok(listener);
        }
    }
    TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0))).await
}

/// Accepts connections and runs `on_conn` for each, until `idle` passes with no connection open and none arriving (or accepting fails). Streams in flight die with it.
pub async fn serve_until_idle<F, Fut>(listener: TcpListener, idle: Duration, touch: Arc<Notify>, mut on_conn: F)
where
    F: FnMut(TcpStream) -> Fut,
    Fut: std::future::Future<Output = ()> + Send + 'static,
{
    let mut streams = tokio::task::JoinSet::new();
    'serve: loop {
        let accepted = if streams.is_empty() {
            let sleep = tokio::time::sleep(idle);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    accepted = listener.accept() => break accepted,
                    _ = &mut sleep => break 'serve,
                    // Asked for again: the clock starts over.
                    _ = touch.notified() => sleep.as_mut().reset(tokio::time::Instant::now() + idle),
                }
            }
        } else {
            // Something is open: not idle. When it ends the clock starts over.
            tokio::select! {
                accepted = listener.accept() => accepted,
                _ = streams.join_next() => continue,
            }
        };
        let Ok((tcp, _)) = accepted else { break };
        streams.spawn(on_conn(tcp));
    }
}

/// Sends `header` (the stream's first line) and copies bytes both ways between `tcp` and the stream halves. Returns `send` so the caller can finish it (a QUIC stream needs more than a shutdown).
pub async fn pipe<R, W>(mut tcp: TcpStream, header: &str, recv: R, mut send: W) -> W
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    if send.write_all(header.as_bytes()).await.is_err() {
        return send;
    }
    let mut stream = tokio::io::join(recv, send);
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
    stream.into_inner().1
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn pipe_sends_the_header_then_copies_both_ways() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        // The "host" end of the stream: an in-memory duplex.
        let (near, mut far) = tokio::io::duplex(1024);
        let (recv, send) = tokio::io::split(near);
        let serve = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            pipe(tcp, "port 5173\n", recv, send).await;
        });
        let mut client = TcpStream::connect(addr).await.unwrap();
        client.write_all(b"GET /").await.unwrap();
        let mut got = vec![0u8; 15];
        far.read_exact(&mut got).await.unwrap();
        assert_eq!(&got, b"port 5173\nGET /");
        far.write_all(b"200 OK").await.unwrap();
        let mut back = [0u8; 6];
        client.read_exact(&mut back).await.unwrap();
        assert_eq!(&back, b"200 OK");
        // Both ends closed: the copy ends.
        drop(client);
        drop(far);
        tokio::time::timeout(Duration::from_secs(5), serve).await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn a_closed_tunnel_port_is_reused_when_free_and_replaced_when_taken() {
        let first = bind_preferring(None).await.unwrap();
        let port = first.local_addr().unwrap().port();
        drop(first);
        let again = bind_preferring(Some(port)).await.unwrap();
        assert_eq!(again.local_addr().unwrap().port(), port);
        let other = bind_preferring(Some(port)).await.unwrap();
        assert_ne!(other.local_addr().unwrap().port(), port);
    }

    #[tokio::test]
    async fn an_unused_listener_ends_after_the_idle_time() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), serve_until_idle(listener, Duration::from_millis(80), Arc::new(Notify::new()), |_tcp| async {})).await;
        assert!(ended.is_ok());
    }

    #[tokio::test]
    async fn touching_a_listener_restarts_its_idle_clock() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let touch = Arc::new(Notify::new());
        let serve = tokio::spawn(serve_until_idle(listener, Duration::from_millis(200), Arc::clone(&touch), |_tcp| async {}));
        for _ in 0..3 {
            tokio::time::sleep(Duration::from_millis(120)).await;
            touch.notify_one();
        }
        assert!(!serve.is_finished());
        assert!(tokio::time::timeout(Duration::from_secs(5), serve).await.is_ok());
    }

    #[tokio::test]
    async fn an_open_connection_keeps_the_listener_and_the_clock_restarts_after_it() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let serve = tokio::spawn(serve_until_idle(listener, Duration::from_millis(100), Arc::new(Notify::new()), |_tcp| async {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }));
        let _client = TcpStream::connect(addr).await.unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(!serve.is_finished());
        assert!(tokio::time::timeout(Duration::from_secs(5), serve).await.is_ok());
    }
}
