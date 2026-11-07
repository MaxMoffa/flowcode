//! The in-app browser: the webview loads pages through the `flowcode-remote`
//! URI scheme and this module fetches them from the desktop. Each request opens
//! its own bidirectional stream on the live iroh connection, names the target
//! on the first line (`preview_header`) and then speaks plain HTTP/1.1 over it,
//! so the desktop only tunnels bytes (or serves a terminal's folder itself).
//!
//! URLs: `/p/<port>/<rest>` is a dev server on the desktop's loopback,
//! `/f/<pty_id>/<rest>` the files of a terminal tab, `/c/<chat_id>/<rest>`
//! the files of a chat. Anything else (a page
//! asking for root-absolute `/assets/app.js`) is placed by its `Referer`.

use crate::state::Remote;
use bytes::Bytes;
use flowcode_remote_proto::{preview_header, PreviewTarget};
use http_body_util::{BodyExt, Full, Limited};
use hyper_util::rt::TokioIo;
use std::sync::Arc;
use std::time::Duration;
use tauri::http::header::{self, HeaderMap, HeaderName, HeaderValue};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager};
use tauri::UriSchemeResponder;

const MAX_REQUEST_BODY: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY: usize = 64 * 1024 * 1024;
/// How long the desktop (or the dev server behind it) has to start answering.
const HEAD_TIMEOUT: Duration = Duration::from_secs(30);
/// The whole exchange, body included.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);

/// Where a request goes and what it asks for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Route {
    pub(crate) target: PreviewTarget,
    /// Path and query as the upstream server sees them (always starts with `/`).
    pub(crate) upstream: String,
}

impl Route {
    /// The `Host` the upstream expects: dev servers reject unknown hosts.
    fn host(&self) -> String {
        match &self.target {
            PreviewTarget::Port(port) => format!("localhost:{port}"),
            PreviewTarget::Files(_) | PreviewTarget::ChatFiles(_) => "localhost".into(),
        }
    }
}

/// `/p/<port>` or `/f/<pty_id>` at the start of `path`, and what follows it
/// (starting with `/`; `/` when nothing does). Segments stay percent-encoded.
fn split_prefix(path: &str) -> Option<(PreviewTarget, &str)> {
    let (kind, rest) = path.strip_prefix('/')?.split_once('/')?;
    let (id, tail) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    match kind {
        "p" => {
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let port = id.parse::<u16>().ok().filter(|p| *p != 0)?;
            Some((PreviewTarget::Port(port), tail))
        }
        "f" if !id.is_empty() => Some((PreviewTarget::Files(id.to_string()), tail)),
        "c" if !id.is_empty() => Some((PreviewTarget::ChatFiles(id.to_string()), tail)),
        _ => None,
    }
}

/// The path of an absolute URL (no query), if it has a scheme and host.
fn url_path(url: &str) -> Option<&str> {
    let after = url.split_once("://")?.1;
    let end = after.find(['?', '#']).unwrap_or(after.len());
    let after = &after[..end];
    Some(after.find('/').map_or("/", |i| &after[i..]))
}

/// Places `path_and_query` (of the request URI) on a target. Pure, so the
/// URL rules are testable without a webview.
pub(crate) fn route(path_and_query: &str, referer: Option<&str>) -> Option<Route> {
    if !path_and_query.starts_with('/') {
        return None;
    }
    let (path, query) = match path_and_query.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path_and_query, None),
    };
    let with_query = |p: &str| match query {
        Some(q) => format!("{p}?{q}"),
        None => p.to_string(),
    };
    if let Some((target, tail)) = split_prefix(path) {
        return Some(Route { target, upstream: with_query(tail) });
    }
    // Not under a prefix: the page that asked tells where it lives.
    let (target, _) = split_prefix(url_path(referer?)?)?;
    Some(Route { target, upstream: path_and_query.to_string() })
}

/// The URL prefix of `target`, for rewriting redirects back into our scheme.
fn prefix_of(target: &PreviewTarget) -> String {
    match target {
        PreviewTarget::Port(port) => format!("/p/{port}"),
        PreviewTarget::Files(pty_id) => format!("/f/{pty_id}"),
        PreviewTarget::ChatFiles(chat_id) => format!("/c/{chat_id}"),
    }
}

/// Request headers worth passing upstream. Host and the connection framing are
/// set by us; Referer and Origin name our private scheme, which a dev server
/// could only misjudge; identity encoding keeps the body readable as is.
pub(crate) fn upstream_headers(src: &HeaderMap) -> HeaderMap {
    const SKIP: [HeaderName; 6] =
        [header::HOST, header::REFERER, header::ORIGIN, header::CONNECTION, header::CONTENT_LENGTH, header::ACCEPT_ENCODING];
    let mut out = HeaderMap::new();
    for (name, value) in src {
        if !SKIP.contains(name) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

/// Response headers worth handing to the webview: hop-by-hop ones describe the
/// stream to the desktop, and the length is recomputed for what we send.
pub(crate) fn downstream_headers(src: &HeaderMap) -> HeaderMap {
    const SKIP: [HeaderName; 5] =
        [header::CONNECTION, HeaderName::from_static("keep-alive"), header::TRANSFER_ENCODING, header::UPGRADE, header::CONTENT_LENGTH];
    let mut out = HeaderMap::new();
    for (name, value) in src {
        if !SKIP.contains(name) {
            out.append(name.clone(), value.clone());
        }
    }
    out
}

/// A redirect that names the desktop's own server (`http://localhost:5173/x`)
/// or the site root (`/x`) must stay inside our scheme, under the same prefix.
pub(crate) fn rewrite_location(location: &str, target: &PreviewTarget) -> String {
    let prefix = prefix_of(target);
    if let Some(rest) = location.strip_prefix('/') {
        // `//host/x` is protocol-relative, not a path.
        return if rest.starts_with('/') { location.to_string() } else { format!("{prefix}{location}") };
    }
    let PreviewTarget::Port(port) = target else { return location.to_string() };
    let Some(after) = location.strip_prefix("http://").or_else(|| location.strip_prefix("https://")) else {
        return location.to_string();
    };
    let end = after.find(['/', '?', '#']).unwrap_or(after.len());
    let (authority, tail) = after.split_at(end);
    let (host, host_port) = match authority.rsplit_once(':') {
        // `[::1]` has colons of its own; its port only follows the bracket.
        Some((h, p)) if !p.contains(']') => (h, p.parse::<u16>().ok()),
        _ => (authority, None),
    };
    if !matches!(host, "localhost" | "127.0.0.1" | "[::1]") || host_port != Some(*port) {
        return location.to_string();
    }
    match tail.chars().next() {
        None => format!("{prefix}/"),
        Some('/') => format!("{prefix}{tail}"),
        Some(_) => format!("{prefix}/{tail}"),
    }
}

fn plain(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    let mut response = Response::new(text.as_bytes().to_vec());
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    response
}

/// A failed load: the text for a person, and a note to the in-app browser, which shows its own page.
fn failure(status: StatusCode, text: &str) -> Response<Vec<u8>> {
    let escaped = text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let body = format!("<!doctype html><meta charset=\"utf-8\"><script>parent.postMessage({{flowcodeFrameError:true}},\"*\")</script><pre>{escaped}</pre>");
    let mut response = Response::new(body.into_bytes());
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Entry point of the `flowcode-remote` scheme.
pub(crate) fn serve(app: &AppHandle, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let conn = app.try_state::<Arc<Remote>>().and_then(|remote| remote.lock().conn.clone());
    tauri::async_runtime::spawn(async move {
        let response = match handle(conn, request).await {
            Ok(response) => response,
            Err((status, message)) if matches!(status, StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::NOT_FOUND) => failure(status, &message),
            Err((status, message)) => plain(status, &message),
        };
        responder.respond(response);
    });
}

/// A file that isn't there: the desktop answers a bare 404, which would leave the frame blank. A dev server's own 404 stays as it sent it.
fn missing_file(target: &PreviewTarget, status: StatusCode, body_len: usize) -> bool {
    !matches!(target, PreviewTarget::Port(_)) && status == StatusCode::NOT_FOUND && body_len == 0
}

async fn handle(conn: Option<iroh::endpoint::Connection>, request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, (StatusCode, String)> {
    let Some(conn) = conn else { return Err((StatusCode::SERVICE_UNAVAILABLE, "not connected".into())) };
    let path_and_query = request.uri().path_and_query().map_or("/", |pq| pq.as_str());
    let referer = request.headers().get(header::REFERER).and_then(|v| v.to_str().ok());
    let Some(route) = route(path_and_query, referer) else { return Err((StatusCode::NOT_FOUND, "not found".into())) };
    if request.body().len() > MAX_REQUEST_BODY {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "request body too large".into()));
    }
    let bad_gateway = |e: &dyn std::fmt::Display| (StatusCode::BAD_GATEWAY, format!("bad gateway: {e}"));
    match tokio::time::timeout(TOTAL_TIMEOUT, fetch(&conn, &route, request)).await {
        Ok(Ok(response)) if missing_file(&route.target, response.status(), response.body().len()) => Err((StatusCode::NOT_FOUND, "not found".into())),
        Ok(Ok(response)) => Ok(response),
        Ok(Err(e)) => Err(bad_gateway(&e)),
        Err(_) => Err(bad_gateway(&"timed out")),
    }
}

async fn fetch(conn: &iroh::endpoint::Connection, route: &Route, request: Request<Vec<u8>>) -> Result<Response<Vec<u8>>, String> {
    let (mut send, recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    send.write_all(preview_header(&route.target).as_bytes()).await.map_err(|e| e.to_string())?;
    let (mut sender, driver) =
        hyper::client::conn::http1::handshake::<_, Full<Bytes>>(TokioIo::new(tokio::io::join(recv, send))).await.map_err(|e| e.to_string())?;
    // Ends with the stream; nothing to report once the response is in.
    tauri::async_runtime::spawn(async move {
        let _ = driver.await;
    });

    let (parts, body) = request.into_parts();
    let mut upstream = hyper::Request::new(Full::new(Bytes::from(body)));
    *upstream.method_mut() = parts.method;
    *upstream.uri_mut() = route.upstream.parse().map_err(|e: tauri::http::uri::InvalidUri| e.to_string())?;
    let headers = upstream.headers_mut();
    *headers = upstream_headers(&parts.headers);
    headers.insert(header::HOST, HeaderValue::from_str(&route.host()).map_err(|e| e.to_string())?);
    headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    headers.insert(header::CONNECTION, HeaderValue::from_static("close"));

    let response = tokio::time::timeout(HEAD_TIMEOUT, sender.send_request(upstream))
        .await
        .map_err(|_| "no answer from the desktop".to_string())?
        .map_err(|e| e.to_string())?;
    let (head, body) = response.into_parts();
    let body = Limited::new(body, MAX_RESPONSE_BODY).collect().await.map_err(|e| e.to_string())?.to_bytes();

    let mut headers = downstream_headers(&head.headers);
    if let Some(location) = head.headers.get(header::LOCATION).and_then(|v| v.to_str().ok()) {
        if let Ok(value) = HeaderValue::from_str(&rewrite_location(location, &route.target)) {
            headers.insert(header::LOCATION, value);
        }
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if !matches!(route.target, PreviewTarget::Port(_)) {
        let (kind, id) = match &route.target {
            PreviewTarget::Files(id) => ("f", id),
            PreviewTarget::ChatFiles(id) => ("c", id),
            _ => unreachable!(),
        };
        if !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("invalid preview id".into()); }
        let sources = format!("flowcode-remote://localhost/{kind}/{id}/ http://flowcode-remote.localhost/{kind}/{id}/ https://flowcode-remote.localhost/{kind}/{id}/");
        let csp = format!("default-src 'none'; script-src 'unsafe-inline' {sources}; style-src 'unsafe-inline' {sources}; connect-src {sources}; img-src {sources} data: blob:; media-src {sources} blob:; font-src {sources} data:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
        headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_str(&csp).map_err(|e| e.to_string())?);
        // Artifacts have an opaque sandbox origin, including their sibling resources.
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        headers.insert(header::REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    }
    let mut out = Response::new(body.to_vec());
    *out.status_mut() = head.status;
    *out.headers_mut() = headers;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn port(p: u16, upstream: &str) -> Option<Route> {
        Some(Route { target: PreviewTarget::Port(p), upstream: upstream.into() })
    }

    fn files(id: &str, upstream: &str) -> Option<Route> {
        Some(Route { target: PreviewTarget::Files(id.into()), upstream: upstream.into() })
    }

    #[test]
    fn failure_is_html_that_tells_the_parent() {
        let response = failure(StatusCode::BAD_GATEWAY, "bad gateway: <refused> & more");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "text/html; charset=utf-8");
        let body = String::from_utf8(response.into_body()).unwrap();
        assert!(body.contains("flowcodeFrameError"));
        assert!(body.contains("&lt;refused&gt; &amp; more"));
        assert!(!body.contains("<refused>"));
    }

    #[test]
    fn only_an_empty_404_on_files_is_missing() {
        let nf = StatusCode::NOT_FOUND;
        assert!(missing_file(&PreviewTarget::Files("t".into()), nf, 0));
        assert!(missing_file(&PreviewTarget::ChatFiles("c".into()), nf, 0));
        assert!(!missing_file(&PreviewTarget::Files("t".into()), nf, 9));
        assert!(!missing_file(&PreviewTarget::Files("t".into()), StatusCode::OK, 0));
        assert!(!missing_file(&PreviewTarget::Port(3000), nf, 0));
    }

    #[test]
    fn routes_ports_and_files_keeping_query_and_encoding() {
        assert_eq!(route("/p/5173/", None), port(5173, "/"));
        assert_eq!(route("/p/5173", None), port(5173, "/"));
        assert_eq!(route("/p/5173/a%20b/c.js?x=1&y=%2F", None), port(5173, "/a%20b/c.js?x=1&y=%2F"));
        assert_eq!(route("/f/pty-1/index.html", None), files("pty-1", "/index.html"));
        assert_eq!(route("/f/pty-1/", None), files("pty-1", "/"));
    }

    #[test]
    fn refuses_bad_ports_and_empty_ids() {
        for bad in ["/p/0/", "/p/65536/", "/p/99999999999/", "/p//x", "/p/abc/", "/p/+80/", "/f//x", "/f/", "/p/", "/", "", "x"] {
            assert_eq!(route(bad, None), None, "{bad:?}");
        }
        assert_eq!(route("/p/65535/", None), port(65535, "/"));
    }

    #[test]
    fn root_absolute_requests_follow_the_referer() {
        let referer = Some("http://flowcode-remote.localhost/p/3000/app/index.html?a=1");
        assert_eq!(route("/assets/app.js?v=2", referer), port(3000, "/assets/app.js?v=2"));
        assert_eq!(route("/x", Some("flowcode-remote://localhost/f/t9/dir/")), files("t9", "/x"));
        assert_eq!(route("/assets/app.js", Some("https://example.com/other")), None);
        assert_eq!(route("/assets/app.js", Some("not a url")), None);
        assert_eq!(route("/assets/app.js", None), None);
        // Its own prefix wins over the referer.
        assert_eq!(route("/p/4000/y", referer), port(4000, "/y"));
    }

    #[test]
    fn request_headers_drop_the_ones_we_own() {
        let mut src = HeaderMap::new();
        for (k, v) in [
            ("host", "flowcode-remote.localhost"),
            ("referer", "x"),
            ("origin", "x"),
            ("connection", "keep-alive"),
            ("content-length", "3"),
            ("accept-encoding", "gzip"),
            ("accept", "text/html"),
            ("cookie", "a=b"),
        ] {
            src.append(HeaderName::from_static(k), HeaderValue::from_static(v));
        }
        let out = upstream_headers(&src);
        let mut names: Vec<_> = out.keys().map(|k| k.as_str()).collect();
        names.sort();
        assert_eq!(names, ["accept", "cookie"]);
    }

    #[test]
    fn response_headers_drop_hop_by_hop_and_length() {
        let mut src = HeaderMap::new();
        for (k, v) in [
            ("connection", "close"),
            ("keep-alive", "timeout=5"),
            ("transfer-encoding", "chunked"),
            ("upgrade", "websocket"),
            ("content-length", "3"),
            ("content-type", "text/css"),
            ("set-cookie", "a=b"),
            ("set-cookie", "c=d"),
        ] {
            src.append(HeaderName::from_static(k), HeaderValue::from_static(v));
        }
        let out = downstream_headers(&src);
        assert_eq!(out.len(), 3);
        assert_eq!(out.get_all("set-cookie").iter().count(), 2);
        assert!(out.contains_key("content-type"));
    }

    #[test]
    fn locations_stay_inside_the_scheme() {
        let p = PreviewTarget::Port(5173);
        assert_eq!(rewrite_location("http://localhost:5173/login?next=/", &p), "/p/5173/login?next=/");
        assert_eq!(rewrite_location("http://127.0.0.1:5173/x", &p), "/p/5173/x");
        assert_eq!(rewrite_location("https://[::1]:5173/x", &p), "/p/5173/x");
        assert_eq!(rewrite_location("http://localhost:5173", &p), "/p/5173/");
        assert_eq!(rewrite_location("http://localhost:5173?a=1", &p), "/p/5173/?a=1");
        assert_eq!(rewrite_location("/dashboard", &p), "/p/5173/dashboard");
        // Not ours: another port, another host, protocol-relative, relative.
        assert_eq!(rewrite_location("http://localhost:3000/x", &p), "http://localhost:3000/x");
        assert_eq!(rewrite_location("http://localhost/x", &p), "http://localhost/x");
        assert_eq!(rewrite_location("https://example.com:5173/x", &p), "https://example.com:5173/x");
        assert_eq!(rewrite_location("//example.com/x", &p), "//example.com/x");
        assert_eq!(rewrite_location("next/page", &p), "next/page");
        let f = PreviewTarget::Files("t1".into());
        assert_eq!(rewrite_location("/other.html", &f), "/f/t1/other.html");
        assert_eq!(rewrite_location("http://localhost:5173/x", &f), "http://localhost:5173/x");
    }

    #[test]
    fn hosts_match_what_dev_servers_accept() {
        assert_eq!(Route { target: PreviewTarget::Port(8080), upstream: "/".into() }.host(), "localhost:8080");
        assert_eq!(Route { target: PreviewTarget::Files("t".into()), upstream: "/".into() }.host(), "localhost");
        assert_eq!(Route { target: PreviewTarget::ChatFiles("c".into()), upstream: "/".into() }.host(), "localhost");
    }

    #[test]
    fn chat_files_keep_their_root_for_pages_assets_and_redirects() {
        let target = PreviewTarget::ChatFiles("chat-1".into());
        assert_eq!(route("/c/chat-1/docs/report.html?v=2", None), Some(Route { target: target.clone(), upstream: "/docs/report.html?v=2".into() }));
        assert_eq!(route("/assets/app.js", Some("http://flowcode-remote.localhost/c/chat-1/docs/report.html")), Some(Route { target: target.clone(), upstream: "/assets/app.js".into() }));
        assert_eq!(rewrite_location("/docs/next.html", &target), "/c/chat-1/docs/next.html");
        assert_eq!(route("/c/", None), None);
    }
}
