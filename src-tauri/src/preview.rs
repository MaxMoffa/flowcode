//! Backend of the in-app browser panel: the `flowcode-preview` URI scheme, and
//! the few commands the panel needs that a webview can't do for itself.
//!
//! Why a host page exists: the app CSP's `frame-src` deliberately allows only
//! the plugin and preview schemes, so an agent-view plugin iframe can't
//! navigate itself to an outside site to exfiltrate data. Rather than widening
//! the app CSP to `http: https:`, the panel frames a host page served here
//! (preview scheme), and a web host page whose CSP allows `frame-src http:
//! https:` frames web pages. Artifacts use a separate host whose CSP permits
//! only preview-file URLs, including when a script navigates its own iframe.
//! The host only obeys `postMessage`s whose
//! `event.source === window.parent`, so a sibling plugin frame can't use it as
//! a proxy, and it ignores its query string, so a URL can't be smuggled in
//! through navigation either.
//!
//! Files of a previewed folder are served too, from a root the frontend
//! registered first. A response CSP confines artifact resources to that root;
//! the iframe sandbox also keeps them away from the app's origin.

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
/// The parent policy also blocks an artifact's own navigations, which its connect-src cannot cover.
const ARTIFACT_HOST_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; \
frame-src http://flowcode-preview.localhost/f/ flowcode-preview://localhost/f/; \
base-uri 'none'; form-action 'none'; object-src 'none'";

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
    let root = PathBuf::from(&dir);
    if !crate::fs::is_local_path(&root, false) || !crate::fs::links_stay_local(&root) { return Err("network paths cannot be previewed".into()); }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
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

fn local_frame_target(url: &str) -> bool {
    let Ok(url) = tauri::Url::parse(url) else { return false };
    if !matches!(url.scheme(), "http" | "https") { return false; }
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost" || host.ends_with(".localhost") || host.trim_matches(['[', ']']).parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

/// Asks a site whether it lets itself be framed, so the panel can say so
/// instead of showing a blank iframe. Only headers are read. A network error
/// is not a verdict: the iframe is left to try.
#[tauri::command]
pub async fn preview_frame_check(url: String) -> Result<FrameCheck, String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("only http(s) URLs can be checked".to_string());
    }
    if local_frame_target(&url) { return Ok(FrameCheck { blocked: false }); }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout(FRAME_CHECK_TIMEOUT)
            .redirects(FRAME_CHECK_REDIRECTS)
            .resolver(crate::link_preview::PublicOnly)
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

fn host_response(kind: &str, body: &'static str, csp: &'static str) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", kind)
        .header("Content-Security-Policy", csp)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Referrer-Policy", "no-referrer")
        .body(body.as_bytes().to_vec())
        .unwrap_or_default()
}

/// A previewed file. CORS is open because the artifact runs in a sandboxed
/// iframe with an opaque origin, which makes fetching its own sibling files
/// (ES modules included) a cross-origin request.
pub(crate) fn artifact_csp(sources: &str) -> String {
    format!("default-src 'none'; script-src 'unsafe-inline' {sources}; style-src 'unsafe-inline' {sources}; \
connect-src {sources}; img-src {sources} data: blob:; font-src {sources} data:; media-src {sources} blob:; \
worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
}

fn file_response(kind: &str, body: Vec<u8>, token: &str) -> Response<Vec<u8>> {
    let sources = format!("http://flowcode-preview.localhost/f/{token}/ flowcode-preview://localhost/f/{token}/");
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", kind)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header("Content-Security-Policy", artifact_csp(&sources))
        .header("Referrer-Policy", "no-referrer")
        .body(body)
        .unwrap_or_default()
}

/// The Windows default scrollbar is a chunky light-grey bar; a previewed page
/// gets the app's thin one instead. Translucent grey, so it reads on light and
/// dark pages alike (the app's own colours aren't reachable from the page).
const SCROLLBAR_STYLE: &str = "<style data-flowcode>::-webkit-scrollbar{width:10px;height:10px}\
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}\
::-webkit-scrollbar-thumb{background-color:rgba(128,128,128,.4);border-radius:5px;border:2px solid transparent;background-clip:padding-box}\
::-webkit-scrollbar-thumb:hover{background-color:rgba(128,128,128,.7)}</style>";

/// Puts `SCROLLBAR_STYLE` right after the opening `<head>` (or `<html>`) tag.
/// Never before a doctype: that would drop the page into quirks mode. A page
/// with neither tag is left as it is.
fn inject_scrollbar_style(mut body: Vec<u8>) -> Vec<u8> {
    let after_open_tag = |body: &[u8], tag: &[u8]| -> Option<usize> {
        // The tag name must end there: `<head` is not `<header>`.
        let start = (0..body.len().saturating_sub(tag.len())).find(|&i| {
            body[i..i + tag.len()].eq_ignore_ascii_case(tag) && matches!(body[i + tag.len()], b'>' | b' ' | b'\t' | b'\r' | b'\n')
        })?;
        let end = body[start..].iter().position(|&b| b == b'>')?;
        Some(start + end + 1)
    };
    let Some(at) = after_open_tag(&body, b"<head").or_else(|| after_open_tag(&body, b"<html")) else {
        return body;
    };
    body.splice(at..at, SCROLLBAR_STYLE.bytes());
    body
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
    if rel.split('/').any(|part| part.starts_with('.')) { return None; }
    let root = lock(&app.state::<PreviewRoots>().0).get(token)?.clone();
    let file = root.join(&rel);
    if !crate::fs::links_stay_local(&file) { return None; }
    let file = file.canonicalize().ok()?;
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
        "host/index.html" => host_response("text/html; charset=utf-8", HOST_HTML, HOST_CSP),
        "host/artifact.html" => host_response("text/html; charset=utf-8", HOST_HTML, ARTIFACT_HOST_CSP),
        "host/host.js" => host_response("text/javascript; charset=utf-8", HOST_JS, HOST_CSP),
        _ => match resolve_preview_file(app, &path) {
            Some((rel, file)) => match std::fs::read(file) {
                Ok(body) => {
                    let kind = content_type(&rel);
                    let body = if kind.starts_with("text/html") { inject_scrollbar_style(body) } else { body };
                    let token = path.strip_prefix("f/").and_then(|p| p.split('/').next()).unwrap_or_default();
                    file_response(kind, body, token)
                }
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
    fn artifact_host_refuses_outside_navigation_but_web_host_can_frame_web_pages() {
        let artifact = host_response("text/html", HOST_HTML, ARTIFACT_HOST_CSP);
        let csp = artifact.headers()["Content-Security-Policy"].to_str().unwrap();
        let frames = csp.split(';').find(|part| part.trim_start().starts_with("frame-src ")).unwrap();
        assert_eq!(frames.trim(), "frame-src http://flowcode-preview.localhost/f/ flowcode-preview://localhost/f/");
        assert!(HOST_CSP.contains("frame-src http: https:"));
        assert!(!csp.contains("allow-same-origin"));
    }

    #[test]
    fn only_loopback_and_localhost_targets_skip_the_network_frame_check() {
        for url in ["http://localhost:3000", "https://dev.localhost/", "http://localhost./", "http://127.0.0.2/", "http://[::1]/", "http://0.0.0.0/"] {
            assert!(local_frame_target(url), "{url}");
        }
        for url in ["https://example.com/", "http://169.254.169.254/", "http://192.168.1.1/", "http://localhost.attacker.test/", "http://localhost@attacker.test/", "file://localhost/a"] {
            assert!(!local_frame_target(url), "{url}");
        }
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = random_token().unwrap();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, random_token().unwrap());
    }
}
