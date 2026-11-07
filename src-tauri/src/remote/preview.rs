//! Preview streams: the phone's in-app browser opens one extra bidirectional
//! stream per HTTP connection on the authenticated link. The first line names
//! the target (`flowcode_remote_proto::PreviewTarget`), what follows is plain
//! HTTP/1.1. A `port` target is a raw tunnel to a loopback dev server; a
//! `files` target is answered here, from the working folder of a terminal tab.

use std::convert::Infallible;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use flowcode_remote_proto::{parse_preview_header, PreviewTarget, PREVIEW_HEADER_MAX};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::header::{HeaderValue, ALLOW, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS};
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::endpoint::Connection;
use tauri::Manager;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};
use tokio::net::TcpStream;
use tokio::sync::Semaphore;

use super::Shared;

/// Preview streams served at once per phone: a page opens a handful of
/// connections, a runaway client must not exhaust the desktop.
const MAX_STREAMS: usize = 64;
/// The whole first line has to arrive within this.
const HEADER_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// Largest file the `files` server sends; it is read whole.
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Accepts the preview streams of `connection` until it ends. The first
/// bidirectional stream was the control stream (taken by the handshake), so
/// every one accepted here is a preview stream; the link is already
/// authenticated. The caller aborts the returned task with the connection.
pub(super) fn spawn_accept_loop(connection: Connection, shared: Arc<Shared>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let slots = Arc::new(Semaphore::new(MAX_STREAMS));
        loop {
            // A slot first, so a flood waits in QUIC's own stream limits.
            let Ok(permit) = Arc::clone(&slots).acquire_owned().await else { break };
            let Ok((send, recv)) = connection.accept_bi().await else { break };
            let shared = Arc::clone(&shared);
            tokio::spawn(async move {
                serve_stream(&shared, send, recv).await;
                drop(permit);
            });
        }
    })
}

async fn serve_stream(shared: &Shared, mut send: iroh::endpoint::SendStream, mut recv: iroh::endpoint::RecvStream) {
    let Some(target) = read_header(&mut recv).await else {
        let _ = send.reset(1u32.into());
        return;
    };
    match target {
        PreviewTarget::Port(port) => {
            let Some(mut tcp) = connect_loopback(port).await else {
                shared.log.line(&format!("preview: nothing listening on port {port}"));
                let _ = send.reset(2u32.into());
                return;
            };
            let mut stream = tokio::io::join(recv, send);
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
            // The copy already shut the write side down on EOF; this covers
            // the paths where it ended on an error.
            let (_, mut send) = stream.into_inner();
            let _ = send.finish();
        }
        PreviewTarget::Files(pty_id) => {
            let root = shared.app.state::<crate::windows::WindowTabs>().cwd_of(&pty_id).map(PathBuf::from);
            serve_files(tokio::io::join(recv, send), root).await;
        }
        PreviewTarget::ChatFiles(chat_id) => {
            let root = shared.app.state::<crate::chat::ChatState>().preview_root(&chat_id).ok();
            serve_files(tokio::io::join(recv, send), root).await;
        }
    }
}

/// Reads the first line of a stream, one byte at a time: the bytes after the
/// newline belong to HTTP and must stay unread. `None` for a line that is too
/// long, not a target, or not complete within `HEADER_TIMEOUT`.
async fn read_header<R: AsyncRead + Unpin>(reader: &mut R) -> Option<PreviewTarget> {
    let line = tokio::time::timeout(HEADER_TIMEOUT, async {
        let mut line = Vec::with_capacity(32);
        loop {
            let byte = reader.read_u8().await.ok()?;
            line.push(byte);
            if byte == b'\n' {
                return Some(line);
            }
            if line.len() >= PREVIEW_HEADER_MAX {
                return None;
            }
        }
    })
    .await
    .ok()??;
    parse_preview_header(std::str::from_utf8(&line).ok()?)
}

/// Some dev servers bind only `::1`, others only `127.0.0.1`.
async fn connect_loopback(port: u16) -> Option<TcpStream> {
    for ip in [SocketAddr::from((Ipv4Addr::LOCALHOST, port)), SocketAddr::from((Ipv6Addr::LOCALHOST, port))] {
        if let Ok(Ok(tcp)) = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(ip)).await {
            return Some(tcp);
        }
    }
    None
}

/// Answers HTTP/1.1 on `io` with the files under `root`. No root (the tab is
/// gone): 404 for everything.
async fn serve_files<S>(io: S, root: Option<PathBuf>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let root = root.map(Arc::new);
    let service = service_fn(move |req| {
        let root = root.clone();
        async move { Ok::<_, Infallible>(answer(root, req).await) }
    });
    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(io), service).await;
}

enum Served {
    Missing,
    TooLarge,
    File { content_type: &'static str, len: u64, body: Vec<u8> },
}

async fn answer(root: Option<Arc<PathBuf>>, req: Request<Incoming>) -> Response<Full<Bytes>> {
    let head = match *req.method() {
        Method::GET => false,
        Method::HEAD => true,
        _ => {
            let mut res = status(StatusCode::METHOD_NOT_ALLOWED);
            res.headers_mut().insert(ALLOW, HeaderValue::from_static("GET, HEAD"));
            return res;
        }
    };
    let Some(root) = root else { return status(StatusCode::NOT_FOUND) };
    let path = req.uri().path().to_string();
    let served = tokio::task::spawn_blocking(move || {
        let Some(file) = resolve_file(&root, &path) else { return Served::Missing };
        let Ok(len) = file.metadata().map(|m| m.len()) else { return Served::Missing };
        if len > MAX_FILE_BYTES {
            return Served::TooLarge;
        }
        let content_type = crate::view_plugins::content_type(&file.to_string_lossy());
        if head {
            return Served::File { content_type, len, body: Vec::new() };
        }
        match std::fs::read(&file) {
            Ok(body) if body.len() as u64 <= MAX_FILE_BYTES => Served::File { content_type, len: body.len() as u64, body },
            Ok(_) => Served::TooLarge,
            Err(_) => Served::Missing,
        }
    })
    .await
    .unwrap_or(Served::Missing);
    match served {
        Served::Missing => status(StatusCode::NOT_FOUND),
        Served::TooLarge => status(StatusCode::PAYLOAD_TOO_LARGE),
        Served::File { content_type, len, body } => {
            let mut res = Response::new(Full::new(Bytes::from(body)));
            let headers = res.headers_mut();
            headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
            headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
            headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            // A HEAD has no body to measure; say how long the GET would be.
            headers.insert(CONTENT_LENGTH, HeaderValue::from(len));
            res
        }
    }
}

fn status(code: StatusCode) -> Response<Full<Bytes>> {
    let mut res = Response::new(Full::new(Bytes::new()));
    *res.status_mut() = code;
    res.headers_mut().insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    res
}

/// The file a request path (as it came on the wire: percent-encoded, maybe
/// with a query) names under `root`. A folder, or an empty path, means its
/// `index.html`. Symlinks are followed, then the result must still sit inside
/// the root, so a link can't lead out of it.
fn resolve_file(root: &Path, request_path: &str) -> Option<PathBuf> {
    let raw = request_path.split(['?', '#']).next().unwrap_or_default();
    let decoded = crate::view_plugins::percent_decode(raw.trim_start_matches('/'))?;
    let decoded = decoded.trim_end_matches('/');
    let rel = if decoded.is_empty() { "index.html".to_string() } else { crate::view_plugins::sanitize_path(decoded)? };
    if rel.split('/').any(|part| part.starts_with('.')) { return None; }
    if !crate::fs::is_local_path(root, false) || !crate::fs::links_stay_local(root) { return None; }
    let root = root.canonicalize().ok()?;
    let file = root.join(&rel);
    if !crate::fs::links_stay_local(&file) { return None; }
    let mut file = file.canonicalize().ok()?;
    if file.is_dir() {
        file = file.join("index.html").canonicalize().ok()?;
    }
    (file.starts_with(&root) && file.is_file()).then_some(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    async fn header_of(bytes: &[u8]) -> (Option<PreviewTarget>, Vec<u8>) {
        let (mut a, mut b) = tokio::io::duplex(4096);
        a.write_all(bytes).await.unwrap();
        drop(a);
        let target = read_header(&mut b).await;
        let mut rest = Vec::new();
        b.read_to_end(&mut rest).await.unwrap();
        (target, rest)
    }

    #[tokio::test]
    async fn header_leaves_the_http_bytes_unread() {
        let (target, rest) = header_of(b"port 5173\nGET / HTTP/1.1\r\n\r\n").await;
        assert_eq!(target, Some(PreviewTarget::Port(5173)));
        assert_eq!(rest, b"GET / HTTP/1.1\r\n\r\n");
        let (target, rest) = header_of(b"files pty-1\nabc").await;
        assert_eq!(target, Some(PreviewTarget::Files("pty-1".into())));
        assert_eq!(rest, b"abc");
    }

    #[tokio::test]
    async fn header_refuses_long_invalid_and_unfinished_lines() {
        let mut long = vec![b'a'; PREVIEW_HEADER_MAX];
        long.push(b'\n');
        assert_eq!(header_of(&long).await.0, None);
        assert_eq!(header_of(b"GET / HTTP/1.1\n").await.0, None);
        assert_eq!(header_of(b"port 0\n").await.0, None);
        assert_eq!(header_of(&[0xff, 0xfe, b'\n']).await.0, None);
        // The sender went away mid-line.
        assert_eq!(header_of(b"port 80").await.0, None);
    }

    fn site(name: &str) -> PathBuf {
        let root = super::super::scratch(name);
        std::fs::write(root.join("index.html"), "<h1>root</h1>").unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub").join("index.html"), "sub").unwrap();
        std::fs::write(root.join("a b.txt"), "text").unwrap();
        root
    }

    #[test]
    fn resolves_files_and_indexes() {
        let root = site("preview-resolve");
        let canon = root.canonicalize().unwrap();
        assert_eq!(resolve_file(&root, "/a%20b.txt?x=1"), Some(canon.join("a b.txt")));
        assert_eq!(resolve_file(&root, "/"), Some(canon.join("index.html")));
        assert_eq!(resolve_file(&root, ""), Some(canon.join("index.html")));
        assert_eq!(resolve_file(&root, "/sub"), Some(canon.join("sub").join("index.html")));
        assert_eq!(resolve_file(&root, "/sub/"), Some(canon.join("sub").join("index.html")));
        assert_eq!(resolve_file(&root, "/missing.js"), None);
    }

    #[test]
    fn refuses_paths_leading_out() {
        let root = site("preview-escape");
        let inner = root.join("sub");
        std::fs::write(root.join("secret.txt"), "s").unwrap();
        assert_eq!(resolve_file(&inner, "/../secret.txt"), None);
        assert_eq!(resolve_file(&inner, "/..%2fsecret.txt"), None);
        assert_eq!(resolve_file(&inner, "/%2e%2e/secret.txt"), None);
        assert_eq!(resolve_file(&inner, "/..%5csecret.txt"), None);
    }

    #[test]
    fn refuses_symlinks_out_of_the_root() {
        let root = site("preview-symlink");
        let inner = root.join("sub");
        std::fs::write(root.join("secret.txt"), "s").unwrap();
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(root.join("secret.txt"), inner.join("link.txt")).is_ok();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(root.join("secret.txt"), inner.join("link.txt")).is_ok();
        if !linked {
            return;
        }
        assert_eq!(resolve_file(&inner, "/link.txt"), None);
    }

    async fn get(root: Option<PathBuf>, request: &str) -> String {
        let (mut client, server) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(serve_files(server, root));
        client.write_all(request.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        client.read_to_end(&mut out).await.unwrap();
        task.await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn files_service_answers_http() {
        let root = site("preview-http");
        let req = |method: &str, path: &str| format!("{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");

        let res = get(Some(root.clone()), &req("GET", "/sub/?v=1")).await;
        assert!(res.starts_with("HTTP/1.1 200 OK"), "{res}");
        let lower = res.to_ascii_lowercase();
        assert!(lower.contains("content-type: text/html; charset=utf-8"), "{res}");
        assert!(lower.contains("x-content-type-options: nosniff"), "{res}");
        assert!(lower.contains("cache-control: no-store"), "{res}");
        assert!(res.ends_with("sub"), "{res}");

        let res = get(Some(root.clone()), &req("HEAD", "/a%20b.txt")).await;
        assert!(res.starts_with("HTTP/1.1 200 OK"), "{res}");
        assert!(res.to_ascii_lowercase().contains("content-length: 4"), "{res}");
        assert!(!res.contains("text\n") && !res.ends_with("text"), "{res}");

        assert!(get(Some(root.clone()), &req("GET", "/nope")).await.starts_with("HTTP/1.1 404"));
        assert!(get(Some(root.clone()), &req("GET", "/..%2f..%2fsecret")).await.starts_with("HTTP/1.1 404"));
        assert!(get(Some(root.clone()), &req("POST", "/")).await.starts_with("HTTP/1.1 405"));
        assert!(get(None, &req("GET", "/")).await.starts_with("HTTP/1.1 404"));
    }
}
