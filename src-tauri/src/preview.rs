//! Backend of the in-app browser panel: the `flowcode-preview` URI scheme, and
//! the few commands the panel needs that a webview can't do for itself.
//!
//! Why a host page exists: the app CSP's `frame-src` deliberately allows only
//! the plugin and preview schemes, so an agent-view plugin iframe can't
//! navigate itself to an outside site to exfiltrate data. Rather than widening
//! the app CSP to `http: https:`, the panel frames a host page served here
//! (preview scheme), and that page - whose own CSP allows `frame-src http:
//! https:` - frames the real page. The host only obeys `postMessage`s whose
//! `event.source === window.parent`, so a sibling plugin frame can't use it as
//! a proxy, and it ignores its query string, so a URL can't be smuggled in
//! through navigation either.
//!
//! Files of a previewed folder are served too, from a root the frontend
//! registered first. Those carry no CSP (an artifact may load CDN scripts);
//! what isolates them is the sandbox of the iframe they are shown in.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, UNIX_EPOCH};

use serde::Serialize;
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::{AppHandle, Manager, State};

use crate::util::lock;
use crate::view_plugins::{content_type, percent_decode, sanitize_path};

const HOST_HTML: &str = include_str!("preview_host/index.html");
const HOST_JS: &str = include_str!("preview_host/host.js");

/// Sent with the host page only. Scripts come from the page's own files (no
/// inline), and it may frame web pages and preview files and nothing else.
const HOST_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; \
frame-src http: https: flowcode-preview:; base-uri 'none'; form-action 'none'; object-src 'none'";

const FRAME_CHECK_USER_AGENT: &str = "Mozilla/5.0 (compatible; Flowcode browser panel)";
const FRAME_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const FRAME_CHECK_REDIRECTS: u32 = 5;
const PROBE_TIMEOUT: Duration = Duration::from_millis(400);

/// Folders the frontend asked to serve, by the random token that appears in
/// their URLs. The token is what keeps one page from reading another folder
/// by guessing a path.
#[derive(Default)]
pub struct PreviewRoots(Mutex<HashMap<String, PathBuf>>);

fn random_token() -> Result<String, String> {
    let mut buf = [0u8; 16];
    getrandom::fill(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// Registers `dir` for serving and returns its token. The same folder always
/// gets the same token, so reopening a preview keeps its URLs stable.
#[tauri::command]
pub fn preview_register_root(state: State<PreviewRoots>, dir: String) -> Result<String, String> {
    let root = PathBuf::from(&dir).canonicalize().map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err(format!("{dir}: not a directory"));
    }
    let mut roots = lock(&state.0);
    if let Some((token, _)) = roots.iter().find(|(_, path)| **path == root) {
        return Ok(token.clone());
    }
    let token = random_token()?;
    roots.insert(token.clone(), root);
    Ok(token)
}

/// Whether response headers forbid framing the page: `X-Frame-Options` DENY or
/// SAMEORIGIN, or a CSP `frame-ancestors` that doesn't allow `*` (`'none'`,
/// `'self'` and specific hosts all keep the app out).
fn frame_blocked(xfo: Option<&str>, csps: &[&str]) -> bool {
    if xfo.is_some_and(|v| {
        let v = v.trim();
        v.eq_ignore_ascii_case("deny") || v.eq_ignore_ascii_case("sameorigin")
    }) {
        return true;
    }
    csps.iter().any(|csp| {
        csp.split(';').any(|directive| {
            let mut parts = directive.split_whitespace();
            parts.next().is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors")) && !parts.any(|s| s == "*")
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameCheck {
    pub blocked: bool,
}

/// Asks a site whether it lets itself be framed, so the panel can say so
/// instead of showing a blank iframe. Only headers are read. A network error
/// is not a verdict: the iframe is left to try.
#[tauri::command]
pub async fn preview_frame_check(url: String) -> Result<FrameCheck, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs can be checked".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(FRAME_CHECK_TIMEOUT)
            .redirects(FRAME_CHECK_REDIRECTS)
            .user_agent(FRAME_CHECK_USER_AGENT)
            .build();
        let response = match agent.get(&url).call() {
            Ok(response) | Err(ureq::Error::Status(_, response)) => response,
            Err(_) => return FrameCheck { blocked: false },
        };
        let xfo = response.header("X-Frame-Options");
        let csp_values: Vec<String> =
            response.all("Content-Security-Policy").into_iter().map(str::to_string).collect();
        let csps: Vec<&str> = csp_values.iter().map(String::as_str).collect();
        FrameCheck { blocked: frame_blocked(xfo, &csps) }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Whether something listens on a local port. "localhost" can mean either
/// loopback family (Vite on recent Node binds only `::1`), so both are tried.
#[tauri::command]
pub async fn preview_probe_port(port: u16) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let v4 = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let v6 = SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port);
        [v4, v6].iter().any(|addr| TcpStream::connect_timeout(addr, PROBE_TIMEOUT).is_ok())
    })
    .await
    .unwrap_or(false)
}

/// Last modification time of a file in ms since the epoch, for live reload.
#[tauri::command]
pub fn preview_file_mtime(path: String) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn host_response(kind: &str, body: &'static str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", kind)
        .header("Content-Security-Policy", HOST_CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .body(body.as_bytes().to_vec())
        .unwrap_or_default()
}

/// A previewed file. CORS is open because the artifact runs in a sandboxed
/// iframe with an opaque origin, which makes fetching its own sibling files
/// (ES modules included) a cross-origin request.
fn file_response(kind: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", kind)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .unwrap_or_default()
}

fn status_response(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(status).header("Content-Type", "text/plain").body(Vec::new()).unwrap_or_default()
}

/// `/f/<token>/<rel path>` resolved to a file inside the registered root.
/// Canonicalized and re-checked against the root, so a symlink inside the
/// folder can't lead out of it.
fn resolve_preview_file(app: &AppHandle, decoded_path: &str) -> Option<(String, PathBuf)> {
    let rest = decoded_path.strip_prefix("f/")?;
    let (token, rel) = rest.split_once('/')?;
    let rel = sanitize_path(rel)?;
    let root = lock(&app.state::<PreviewRoots>().0).get(token)?.clone();
    let file = root.join(&rel).canonicalize().ok()?;
    (file.starts_with(&root) && file.is_file()).then_some((rel, file))
}

/// Handler of the `flowcode-preview` URI scheme. The frontend builds URLs with
/// `convertFileSrc("host", "flowcode-preview")`, which is
/// `http://flowcode-preview.localhost/host` on Windows and
/// `flowcode-preview://localhost/host` elsewhere.
pub fn serve(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET {
        return status_response(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(path) = percent_decode(request.uri().path().trim_start_matches('/')) else {
        return status_response(StatusCode::NOT_FOUND);
    };
    match path.as_str() {
        "host/index.html" => host_response("text/html; charset=utf-8", HOST_HTML),
        "host/host.js" => host_response("text/javascript; charset=utf-8", HOST_JS),
        _ => match resolve_preview_file(app, &path) {
            Some((rel, file)) => match std::fs::read(file) {
                Ok(body) => file_response(content_type(&rel), body),
                Err(_) => status_response(StatusCode::NOT_FOUND),
            },
            None => status_response(StatusCode::NOT_FOUND),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_options_block_deny_and_sameorigin() {
        assert!(frame_blocked(Some("DENY"), &[]));
        assert!(frame_blocked(Some("sameorigin"), &[]));
        assert!(frame_blocked(Some(" SameOrigin "), &[]));
        assert!(!frame_blocked(Some("ALLOWALL"), &[]));
    }

    #[test]
    fn frame_ancestors_block_unless_wildcard() {
        assert!(frame_blocked(None, &["frame-ancestors 'none'"]));
        assert!(frame_blocked(None, &["default-src 'self'; frame-ancestors 'self' https://x.com"]));
        assert!(!frame_blocked(None, &["frame-ancestors *"]));
        assert!(!frame_blocked(None, &["default-src 'self'; script-src 'none'"]));
    }

    #[test]
    fn unrestricted_responses_are_not_blocked() {
        assert!(!frame_blocked(None, &[]));
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = random_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, random_token().unwrap());
    }
}
