//! Native child webviews for the in-app browser panel (`kind: "url"` pages).
//!
//! Each page gets its own `Window::add_child` webview positioned over the
//! panel's viewport rectangle (Tauri multi-webview, cargo feature `unstable`).
//! The frontend half is src/browser/nativeView.ts.
//!
//! # Security: web content here has ZERO Tauri IPC access
//!
//! The pages loaded in these children are untrusted. Evidence for the setup:
//!
//! * A capability listing a window under `windows` is enabled on ALL webviews
//!   of that window, children included (tauri-utils-2.10.1 acl/capability.rs:
//!   "the capability will be enabled on all the webviews of that window").
//!   `RuntimeAuthority::resolve_access` accepts a command when either the
//!   webview label OR the window label matches (tauri-2.11.5
//!   src/ipc/authority.rs ~349-352, 458-460). So capabilities/default.json
//!   lists the labels under `webviews` (not `windows`): the main webview of a
//!   `WebviewWindow` has the same label as its window ("main", "win-<uuid>",
//!   see windows.rs window_open), while children are labelled `fcb-*` and so
//!   match no capability at all ("If a webview or its window is not matching
//!   any capability then it has no access to the IPC layer").
//! * Even a matching capability only applies to its `local` context: pages
//!   outside the app URL are `Origin::Remote`, and src/webview/mod.rs
//!   ~1823 rejects any invoke with `invoke.acl.is_none()` when `!is_local`,
//!   "so remote content can never reach custom commands unless an explicit
//!   `remote` capability has been configured". We have no `remote` capability.
//! * The origins that ARE local are the dev server (`devUrl`, `is_local_url`
//!   -> `get_app_url().make_relative`) and the custom schemes
//!   (`http://flowcode-preview.localhost` on Windows). `validate_url` refuses
//!   those, for explicit URLs and for in-page navigations/redirects
//!   (`on_navigation`), so a child can never reach a local origin. Only
//!   http(s) is accepted.
//! * `window.open` is denied (`on_new_window`) and forwarded to the frontend.
//!
//! # A window with a child is no longer a `WebviewWindow`
//!
//! Tauri counts a window as a `WebviewWindow` only while every webview in it
//! carries the window's own label (`Window::is_webview_window`). Once a
//! `fcb-*` child exists, commands taking a `tauri::WebviewWindow` argument
//! fail with "current webview is not a WebviewWindow", and
//! `get_webview_window` / `webview_windows` stop returning that window. So
//! commands take `tauri::Window` and liveness checks use `get_window` /
//! `windows` - never the `WebviewWindow` variants.
//!
//! # Profile
//!
//! Children use `data_directory(<app local data>/browser-profile)`, a separate
//! WebView2 user-data folder / WebKitGTK context, so test logins never mix
//! with the app's own storage. wry keeps one WebContext per data directory
//! (tauri-runtime-wry WebContextStore) and WebView2 creates one environment
//! per folder. macOS ignores `data_directory` (WKWebView data store).
//!
//! # DevTools
//!
//! Needs tauri's `devtools` feature in release builds, which turns devtools on
//! by default for every webview. The app windows therefore opt out explicitly
//! (`devtools(cfg!(debug_assertions))` in windows.rs and the config patch in
//! lib.rs); only these children set `devtools(true)`.
//!
//! # Threading
//!
//! `Window::add_child` blocks on the main thread, so every command here is
//! `async` (sync commands run on the main thread and would deadlock).

use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Rect, State, Url, WebviewUrl, Window,
};

/// Live children kept per window; the least recently shown is destroyed past this.
const MAX_LIVE: usize = 4;

const RESERVED_HOSTS: [&str; 5] = [
    "tauri.localhost",
    "ipc.localhost",
    "asset.localhost",
    "flowcode-plugin.localhost",
    "flowcode-preview.localhost",
];

static TICK: AtomicU64 = AtomicU64::new(1);

struct Entry {
    page_id: String,
    label: String,
    last_used: u64,
}

/// Window label -> its live browser children.
#[derive(Default)]
pub struct BrowserViews(Mutex<HashMap<String, Vec<Entry>>>);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// A webview label (alphanumeric, `-`, `_`) unique per (window, page id).
fn view_label(window: &str, page_id: &str) -> String {
    let clean: String = page_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .take(40)
        .collect();
    // FNV-1a of the raw id keeps ids that sanitise alike apart.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in page_id.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("fcb-{window}-{clean}-{h:016x}")
}

/// Only http(s) pages of the open web / the user's own servers. Refuses every
/// origin Tauri would treat as local (see the module doc).
fn validate_url(raw: &str) -> Result<Url, String> {
    let url: Url = raw.trim().parse().map_err(|e| format!("invalid url: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) urls can be opened".into());
    }
    let host = url.host_str().ok_or("url has no host")?.to_ascii_lowercase();
    if RESERVED_HOSTS.contains(&host.as_str()) {
        return Err("reserved app host".into());
    }
    if tauri::is_dev() {
        // The dev server is the app's local origin: never let a child load it.
        let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1");
        if loopback && url.port_or_known_default() == Some(1420) {
            return Err("the app's own dev server cannot be opened".into());
        }
    }
    Ok(url)
}

fn emit<S: Serialize + Clone>(app: &AppHandle, window: &str, event: &str, payload: S) {
    let _ = app.emit_to(EventTarget::webview_window(window), event, payload);
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UrlPayload<'a> {
    page_id: &'a str,
    url: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LoadPayload<'a> {
    page_id: &'a str,
    state: &'a str,
    url: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TitlePayload<'a> {
    page_id: &'a str,
    title: &'a str,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadPayload<'a> {
    page_id: &'a str,
    url: &'a str,
    path: Option<String>,
    success: Option<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload<'a> {
    page_id: &'a str,
    kind: &'a str,
    code: &'a str,
    url: &'a str,
}

fn emit_error(app: &AppHandle, window: &str, page_id: &str, kind: &str, code: &str, url: &str) {
    emit(app, window, "browser-view-error", ErrorPayload { page_id, kind, code, url });
}

/// Error `kind` of the `browser-view-error` contract for a WebView2
/// `COREWEBVIEW2_WEB_ERROR_STATUS` name (prefix stripped). `None` = not an
/// error worth a page (the user or a login prompt interrupted the load).
#[cfg_attr(not(windows), allow(dead_code))]
fn kind_for_web_error(code: &str) -> Option<&'static str> {
    match code {
        "OPERATION_CANCELED" | "VALID_AUTHENTICATION_CREDENTIALS_REQUIRED" | "VALID_PROXY_AUTHENTICATION_REQUIRED" => None,
        "CONNECTION_REFUSED" | "CONNECTION_ABORTED" | "CONNECTION_RESET" | "CANNOT_CONNECT" => Some("refused"),
        "HOST_NAME_NOT_RESOLVED" => Some("dns"),
        "DISCONNECTED" => Some("offline"),
        "TIMEOUT" => Some("timeout"),
        c if c.starts_with("CERTIFICATE_") || c.starts_with("CLIENT_CERTIFICATE_") => Some("cert"),
        _ => Some("other"),
    }
}

/// Same mapping from a GLib/WebKit error message (Linux has no status enum).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn kind_for_message(msg: &str) -> &'static str {
    let m = msg.to_ascii_lowercase();
    if m.contains("connection refused") {
        "refused"
    } else if m.contains("resolve") || m.contains("name or service") {
        "dns"
    } else if m.contains("timed out") {
        "timeout"
    } else {
        "other"
    }
}

/// Loopback hosts only: `localhost`, 127.0.0.0/8, `::1`.
fn is_loopback_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']');
    h.eq_ignore_ascii_case("localhost") || h.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

/// True when a TCP connect to the loopback `host:port` of `raw` succeeds within
/// 700 ms. Anything not loopback is an error, so this can never scan other hosts.
fn probe_loopback(raw: &str) -> Result<bool, String> {
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
    let url: Url = raw.trim().parse().map_err(|e| format!("invalid url: {e}"))?;
    let host = url.host_str().ok_or("url has no host")?;
    if !is_loopback_host(host) {
        return Err("only loopback hosts can be probed".into());
    }
    let port = url.port_or_known_default().ok_or("url has no port")?;
    let ips: Vec<IpAddr> = match host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
        Ok(ip) => vec![ip],
        Err(_) => vec![Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()],
    };
    let deadline = std::time::Instant::now() + Duration::from_millis(700);
    for ip in ips {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() {
            break;
        }
        if TcpStream::connect_timeout(&SocketAddr::new(ip, port), left).is_ok() {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Whether a loopback `url` accepts TCP connections: the "server down" page
/// polls this to reload by itself when the dev server comes back.
#[tauri::command]
pub async fn browser_probe_local(url: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || probe_loopback(&url)).await.map_err(|e| e.to_string())?
}

fn rect(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect {
        position: LogicalPosition::new(x, y).into(),
        size: LogicalSize::new(w.max(1.0), h.max(1.0)).into(),
    }
}

fn webview_of(app: &AppHandle, label: &str) -> Result<tauri::Webview, String> {
    app.get_webview(label).ok_or_else(|| "browser view not found".to_string())
}

fn find_label(state: &BrowserViews, window: &str, page_id: &str) -> Option<String> {
    lock(&state.0)
        .get(window)?
        .iter()
        .find(|e| e.page_id == page_id)
        .map(|e| e.label.clone())
}

fn build_child(
    app: &AppHandle,
    window: &Window,
    label: &str,
    page_id: &str,
    url: Url,
    bounds: (f64, f64, f64, f64),
) -> Result<(), String> {
    let win = window.label().to_string();
    let last_url = Arc::new(Mutex::new(String::new()));

    // Emits `browser-view-navigated` only when the url really changed.
    let note_url = {
        let (app, win, pid, last) = (app.clone(), win.clone(), page_id.to_string(), last_url.clone());
        move |u: &str| {
            let mut l = lock(&last);
            if *l != u {
                *l = u.to_string();
                emit(&app, &win, "browser-view-navigated", UrlPayload { page_id: &pid, url: u });
            }
        }
    };
    let note_url = Arc::new(note_url);

    let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url));
    builder = builder.devtools(true);
    if let Ok(dir) = app.path().app_local_data_dir() {
        builder = builder.data_directory(dir.join("browser-profile"));
    }

    let nav_note = note_url.clone();
    let (nav_app, nav_win, nav_pid) = (app.clone(), win.clone(), page_id.to_string());
    builder = builder.on_navigation(move |u| {
        if u.as_str() == "about:blank" {
            return true;
        }
        let ok = validate_url(u.as_str()).is_ok();
        if ok {
            nav_note(u.as_str());
        } else {
            emit_error(&nav_app, &nav_win, &nav_pid, "blocked", "BLOCKED_LOCAL_ORIGIN", u.as_str());
        }
        ok
    });

    {
        let (app, win, pid, note) = (app.clone(), win.clone(), page_id.to_string(), note_url.clone());
        builder = builder.on_page_load(move |_, payload| {
            let state = match payload.event() {
                PageLoadEvent::Started => "started",
                PageLoadEvent::Finished => "finished",
            };
            note(payload.url().as_str());
            emit(
                &app,
                &win,
                "browser-view-load",
                LoadPayload { page_id: &pid, state, url: payload.url().as_str() },
            );
        });
    }
    {
        let (app, win, pid) = (app.clone(), win.clone(), page_id.to_string());
        builder = builder.on_document_title_changed(move |_, title| {
            emit(&app, &win, "browser-view-title", TitlePayload { page_id: &pid, title: &title });
        });
    }
    {
        let (app, win, pid) = (app.clone(), win.clone(), page_id.to_string());
        builder = builder.on_new_window(move |url, _| {
            // Denied: the frontend opens it as a new tab. A popup that needs
            // `window.opener` (OAuth popups) therefore cannot work.
            if validate_url(url.as_str()).is_ok() {
                emit(&app, &win, "browser-view-new-window", UrlPayload { page_id: &pid, url: url.as_str() });
            }
            NewWindowResponse::Deny
        });
    }
    {
        let (app, win, pid) = (app.clone(), win.clone(), page_id.to_string());
        builder = builder.on_download(move |_, event| {
            match event {
                DownloadEvent::Requested { url, destination } => emit(
                    &app,
                    &win,
                    "browser-view-download",
                    DownloadPayload {
                        page_id: &pid,
                        url: url.as_str(),
                        path: Some(destination.to_string_lossy().into_owned()),
                        success: None,
                    },
                ),
                DownloadEvent::Finished { url, path, success } => emit(
                    &app,
                    &win,
                    "browser-view-download",
                    DownloadPayload {
                        page_id: &pid,
                        url: url.as_str(),
                        path: path.map(|p| p.to_string_lossy().into_owned()),
                        success: Some(success),
                    },
                ),
                _ => {}
            }
            // Default destination: the user's Downloads folder.
            true
        });
    }

    let (x, y, w, h) = bounds;
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())?;

    attach_error_handlers(app, &win, label, page_id);

    // on_navigation does not fire for history.pushState (SPA routes), so the
    // address bar is kept honest by polling the webview's current URL.
    let (app, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let Some(wv) = app.get_webview(&label) else { break };
            if let Ok(u) = wv.url() {
                if u.scheme() == "http" || u.scheme() == "https" {
                    note_url(u.as_str());
                }
            }
        }
    });
    Ok(())
}

/// Engine-level load failures -> `browser-view-error` (wry only reports
/// started/finished). macOS: nothing yet, WKWebView's delegate belongs to wry.
fn attach_error_handlers(app: &AppHandle, window: &str, label: &str, page_id: &str) {
    let Some(wv) = app.get_webview(label) else { return };
    let (app, window, page_id) = (app.clone(), window.to_string(), page_id.to_string());
    #[cfg(windows)]
    let _ = wv.with_webview(move |pw| unsafe { attach_webview2_errors(pw, app, window, page_id) });
    #[cfg(target_os = "linux")]
    let _ = wv.with_webview(move |pw| attach_webkit_errors(pw, app, window, page_id));
    #[cfg(not(any(windows, target_os = "linux")))]
    let _ = (wv, app, window, page_id);
}

#[cfg(windows)]
unsafe fn attach_webview2_errors(pw: tauri::webview::PlatformWebview, app: AppHandle, window: String, page_id: String) {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{take_pwstr, NavigationCompletedEventHandler, ProcessFailedEventHandler};
    use windows::core::PWSTR;
    use windows::core::BOOL;

    let Ok(core) = pw.controller().CoreWebView2() else { return };

    fn status_name(s: COREWEBVIEW2_WEB_ERROR_STATUS) -> &'static str {
        match s {
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_COMMON_NAME_IS_INCORRECT => "CERTIFICATE_COMMON_NAME_IS_INCORRECT",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_EXPIRED => "CERTIFICATE_EXPIRED",
            COREWEBVIEW2_WEB_ERROR_STATUS_CLIENT_CERTIFICATE_CONTAINS_ERRORS => "CLIENT_CERTIFICATE_CONTAINS_ERRORS",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_REVOKED => "CERTIFICATE_REVOKED",
            COREWEBVIEW2_WEB_ERROR_STATUS_CERTIFICATE_IS_INVALID => "CERTIFICATE_IS_INVALID",
            COREWEBVIEW2_WEB_ERROR_STATUS_SERVER_UNREACHABLE => "SERVER_UNREACHABLE",
            COREWEBVIEW2_WEB_ERROR_STATUS_TIMEOUT => "TIMEOUT",
            COREWEBVIEW2_WEB_ERROR_STATUS_ERROR_HTTP_INVALID_SERVER_RESPONSE => "ERROR_HTTP_INVALID_SERVER_RESPONSE",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_ABORTED => "CONNECTION_ABORTED",
            COREWEBVIEW2_WEB_ERROR_STATUS_CONNECTION_RESET => "CONNECTION_RESET",
            COREWEBVIEW2_WEB_ERROR_STATUS_DISCONNECTED => "DISCONNECTED",
            COREWEBVIEW2_WEB_ERROR_STATUS_CANNOT_CONNECT => "CANNOT_CONNECT",
            COREWEBVIEW2_WEB_ERROR_STATUS_HOST_NAME_NOT_RESOLVED => "HOST_NAME_NOT_RESOLVED",
            COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED => "OPERATION_CANCELED",
            COREWEBVIEW2_WEB_ERROR_STATUS_REDIRECT_FAILED => "REDIRECT_FAILED",
            COREWEBVIEW2_WEB_ERROR_STATUS_UNEXPECTED_ERROR => "UNEXPECTED_ERROR",
            COREWEBVIEW2_WEB_ERROR_STATUS_VALID_AUTHENTICATION_CREDENTIALS_REQUIRED => "VALID_AUTHENTICATION_CREDENTIALS_REQUIRED",
            COREWEBVIEW2_WEB_ERROR_STATUS_VALID_PROXY_AUTHENTICATION_REQUIRED => "VALID_PROXY_AUTHENTICATION_REQUIRED",
            _ => "UNKNOWN",
        }
    }

    // NavigationCompleted only fires for the main document (frames have their own event).
    let (a, w, p) = (app.clone(), window.clone(), page_id.clone());
    let nav = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
        let (Some(args), Some(sender)) = (args, sender) else { return Ok(()) };
        let mut ok = BOOL(1);
        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS(0);
        if args.IsSuccess(&mut ok).is_err() || ok.as_bool() || args.WebErrorStatus(&mut status).is_err() {
            return Ok(());
        }
        let code = status_name(status);
        if let Some(kind) = kind_for_web_error(code) {
            let mut src = PWSTR::null();
            let url = if sender.Source(&mut src).is_ok() { take_pwstr(src) } else { String::new() };
            emit_error(&a, &w, &p, kind, code, &url);
        }
        Ok(())
    }));
    // The tokens are dropped on purpose: the handlers live as long as the view.
    let mut token = Default::default();
    let _ = core.add_NavigationCompleted(&nav, &mut token);

    let proc = ProcessFailedEventHandler::create(Box::new(move |sender, args| {
        let (Some(args), Some(sender)) = (args, sender) else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(0);
        if args.ProcessFailedKind(&mut kind).is_err() {
            return Ok(());
        }
        // FRAME_RENDER_PROCESS_EXITED only kills an iframe: the page itself still works.
        let code = match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "RENDER_PROCESS_EXITED",
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "RENDER_PROCESS_UNRESPONSIVE",
            _ => return Ok(()),
        };
        let mut src = PWSTR::null();
        let url = if sender.Source(&mut src).is_ok() { take_pwstr(src) } else { String::new() };
        emit_error(&app, &window, &page_id, "crash", code, &url);
        Ok(())
    }));
    let mut token = Default::default();
    let _ = core.add_ProcessFailed(&proc, &mut token);
}

/// WebKitGTK: `load-failed` (network), `load-failed-with-tls-errors` and a dead
/// web process. Load handlers return `false` so WebKit's default handling runs.
/// Not compiled on the Windows dev machine: typed against webkit2gtk 2.0.2.
#[cfg(target_os = "linux")]
fn attach_webkit_errors(pw: tauri::webview::PlatformWebview, app: AppHandle, window: String, page_id: String) {
    use webkit2gtk::{NetworkError, WebViewExt};

    let wv = pw.inner();
    {
        let (app, window, page_id) = (app.clone(), window.clone(), page_id.clone());
        wv.connect_load_failed(move |_, _, uri, err| {
            if !err.matches(NetworkError::Cancelled) {
                emit_error(&app, &window, &page_id, kind_for_message(err.message()), err.message(), uri);
            }
            false
        });
    }
    {
        let (app, window, page_id) = (app.clone(), window.clone(), page_id.clone());
        wv.connect_load_failed_with_tls_errors(move |_, uri, _, flags| {
            emit_error(&app, &window, &page_id, "cert", &format!("{flags:?}"), uri);
            false
        });
    }
    wv.connect_web_process_terminated(move |view, reason| {
        let url = view.uri().map(|u| u.to_string()).unwrap_or_default();
        emit_error(&app, &window, &page_id, "crash", &format!("{reason:?}"), &url);
    });
}

fn destroy(app: &AppHandle, label: &str) {
    if let Some(wv) = app.get_webview(label) {
        let _ = wv.close();
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_view_show(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let url = validate_url(&url)?;
    let win = window.label().to_string();
    let label = view_label(&win, &page_id);

    if let Some(wv) = app.get_webview(&label) {
        wv.set_bounds(rect(x, y, width, height)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
    } else {
        build_child(&app, &window, &label, &page_id, url, (x, y, width, height))?;
    }

    let mut doomed = Vec::new();
    {
        let mut map = lock(&state.0);
        let list = map.entry(win).or_default();
        let tick = TICK.fetch_add(1, Ordering::Relaxed);
        match list.iter_mut().find(|e| e.page_id == page_id) {
            Some(e) => e.last_used = tick,
            None => list.push(Entry { page_id: page_id.clone(), label: label.clone(), last_used: tick }),
        }
        // One visible child per window.
        for e in list.iter().filter(|e| e.page_id != page_id) {
            if let Some(wv) = app.get_webview(&e.label) {
                let _ = wv.hide();
            }
        }
        while list.len() > MAX_LIVE {
            let oldest = list
                .iter()
                .enumerate()
                .filter(|(_, e)| e.page_id != page_id)
                .min_by_key(|(_, e)| e.last_used)
                .map(|(i, _)| i);
            match oldest {
                Some(i) => doomed.push(list.remove(i).label),
                None => break,
            }
        }
    }
    for label in doomed {
        destroy(&app, &label);
    }
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn browser_view_bounds(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let Some(label) = find_label(&state, window.label(), &page_id) else { return Ok(()) };
    webview_of(&app, &label)?
        .set_bounds(rect(x, y, width, height))
        .map_err(|e| e.to_string())
}

/// Hides one page's child, or every child of the calling window when `page_id` is omitted.
#[tauri::command]
pub async fn browser_view_hide(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: Option<String>,
) -> Result<(), String> {
    let labels: Vec<String> = lock(&state.0)
        .get(window.label())
        .map(|l| {
            l.iter()
                .filter(|e| page_id.as_deref().is_none_or(|p| p == e.page_id))
                .map(|e| e.label.clone())
                .collect()
        })
        .unwrap_or_default();
    for label in labels {
        if let Some(wv) = app.get_webview(&label) {
            let _ = wv.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_view_navigate(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
    url: String,
) -> Result<(), String> {
    let url = validate_url(&url)?;
    let label = find_label(&state, window.label(), &page_id).ok_or("browser view not found")?;
    webview_of(&app, &label)?.navigate(url).map_err(|e| e.to_string())
}

fn eval_on(app: &AppHandle, state: &BrowserViews, window: &Window, page_id: &str, js: &str) -> Result<(), String> {
    let label = find_label(state, window.label(), page_id).ok_or("browser view not found")?;
    webview_of(app, &label)?.eval(js).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_view_back(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
) -> Result<(), String> {
    eval_on(&app, &state, &window, &page_id, "history.back()")
}

#[tauri::command]
pub async fn browser_view_forward(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
) -> Result<(), String> {
    eval_on(&app, &state, &window, &page_id, "history.forward()")
}

#[tauri::command]
pub async fn browser_view_reload(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
    ignore_cache: Option<bool>,
) -> Result<(), String> {
    let label = find_label(&state, window.label(), &page_id).ok_or("browser view not found")?;
    let wv = webview_of(&app, &label)?;
    #[cfg(windows)]
    if ignore_cache.unwrap_or(false) {
        // Page.reload{ignoreCache} is the DevTools protocol's hard reload.
        return wv
            .with_webview(|pw| unsafe {
                use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
                use windows::core::HSTRING;
                if let Ok(core) = pw.controller().CoreWebView2() {
                    let _ = core.CallDevToolsProtocolMethod(
                        &HSTRING::from("Page.reload"),
                        &HSTRING::from("{\"ignoreCache\":true}"),
                        &CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(()))),
                    );
                }
            })
            .map_err(|e| e.to_string());
    }
    #[cfg(not(windows))]
    let _ = ignore_cache;
    wv.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_view_close(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
) -> Result<(), String> {
    let label = {
        let mut map = lock(&state.0);
        let Some(list) = map.get_mut(window.label()) else { return Ok(()) };
        list.iter().position(|e| e.page_id == page_id).map(|i| list.remove(i).label)
    };
    if let Some(label) = label {
        destroy(&app, &label);
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_view_devtools(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
) -> Result<(), String> {
    let label = find_label(&state, window.label(), &page_id).ok_or("browser view not found")?;
    webview_of(&app, &label)?.open_devtools();
    Ok(())
}

/// Clears cookies/storage of the shared `browser-profile` (all pages' children
/// use the same data directory), through the given page's child.
#[tauri::command]
pub async fn browser_view_clear_data(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
) -> Result<(), String> {
    let label = find_label(&state, window.label(), &page_id).ok_or("browser view not found")?;
    webview_of(&app, &label)?.clear_all_browsing_data().map_err(|e| e.to_string())
}

/// PNG data URL of what the page currently shows, for the frontend's freeze
/// frame while a DOM overlay must cover the (always on top) native view.
/// Windows only; elsewhere `None` and the frontend shows a plain placeholder.
///
/// `CapturePreview` must start on the UI thread (`with_webview` runs there) and
/// its completion handler fires on that same thread, so the command never
/// waits there: the handler reads the stream and sends the bytes through a
/// oneshot channel that this async command awaits (500 ms cap).
#[tauri::command]
pub async fn browser_view_snapshot(
    app: AppHandle,
    window: Window,
    state: State<'_, BrowserViews>,
    page_id: String,
) -> Result<Option<String>, String> {
    let label = find_label(&state, window.label(), &page_id).ok_or("browser view not found")?;
    let wv = webview_of(&app, &label)?;
    #[cfg(windows)]
    {
        use base64::Engine;
        let (tx, rx) = tokio::sync::oneshot::channel::<Option<Vec<u8>>>();
        if wv.with_webview(move |pw| unsafe { capture_png(pw, tx) }).is_err() {
            return Ok(None);
        }
        Ok(match tokio::time::timeout(Duration::from_millis(500), rx).await {
            Ok(Ok(Some(png))) => {
                Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
            }
            _ => None,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = wv;
        Ok(None)
    }
}

#[cfg(windows)]
unsafe fn capture_png(pw: tauri::webview::PlatformWebview, tx: tokio::sync::oneshot::Sender<Option<Vec<u8>>>) {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};

    unsafe fn read_all(stream: &IStream) -> Option<Vec<u8>> {
        let mut stat = STATSTG::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).ok()?;
        let len = stat.cbSize as usize;
        if len == 0 || len > 16 * 1024 * 1024 {
            return None;
        }
        stream.Seek(0, STREAM_SEEK_SET, None).ok()?;
        let mut buf = vec![0u8; len];
        let mut read = 0u32;
        stream.Read(buf.as_mut_ptr().cast(), len as u32, Some(&mut read)).ok().ok()?;
        buf.truncate(read as usize);
        Some(buf)
    }

    let Ok(core) = pw.controller().CoreWebView2() else { return };
    let Ok(stream) = CreateStreamOnHGlobal(HGLOBAL::default(), true) else { return };
    let keep = stream.clone();
    // `tx` lives in the handler: if the call fails it is dropped and the awaiting command gets None.
    let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
        let _ = tx.send(if res.is_ok() { unsafe { read_all(&keep) } } else { None });
        Ok(())
    }));
    let _ = core.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG, &stream, &handler);
}

static FAVICONS: Mutex<Option<HashMap<String, Option<String>>>> = Mutex::new(None);
const FAVICON_MAX: u64 = 64 * 1024;

/// `<origin>/favicon.ico` of a public site as a data URL (null when absent),
/// cached per origin. Only open-web hosts: the resolver refuses private ranges.
#[tauri::command]
pub async fn browser_favicon(url: String) -> Result<Option<String>, String> {
    let url = validate_url(&url)?;
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    let loopback = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified());
    if host == "localhost" || host.ends_with(".localhost") || loopback {
        return Ok(None);
    }
    let origin = url.origin().ascii_serialization();
    if let Some(hit) = lock(&FAVICONS).as_ref().and_then(|m| m.get(&origin)) {
        return Ok(hit.clone());
    }
    let target = format!("{origin}/favicon.ico");
    let found = tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        use std::io::Read;
        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(3))
            .redirects(3)
            .resolver(crate::link_preview::PublicOnly)
            .build();
        let response = agent.get(&target).call().ok()?;
        let mime = response.content_type().to_ascii_lowercase();
        if mime.starts_with("text/") || mime.contains("json") {
            return None;
        }
        let mime = if mime.starts_with("image/") { mime } else { "image/x-icon".to_string() };
        let mut bytes = Vec::new();
        response.into_reader().take(FAVICON_MAX + 1).read_to_end(&mut bytes).ok()?;
        if bytes.is_empty() || bytes.len() as u64 > FAVICON_MAX {
            return None;
        }
        Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
    })
    .await
    .map_err(|e| e.to_string())?;
    lock(&FAVICONS).get_or_insert_with(HashMap::new).insert(origin, found.clone());
    Ok(found)
}

/// The window is gone: its children died with it; drop the bookkeeping.
pub fn forget_window(app: &AppHandle, window: &str) {
    lock(&app.state::<BrowserViews>().0).remove(window);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_error_kinds() {
        assert_eq!(kind_for_web_error("CANNOT_CONNECT"), Some("refused"));
        assert_eq!(kind_for_web_error("CONNECTION_RESET"), Some("refused"));
        assert_eq!(kind_for_web_error("HOST_NAME_NOT_RESOLVED"), Some("dns"));
        assert_eq!(kind_for_web_error("DISCONNECTED"), Some("offline"));
        assert_eq!(kind_for_web_error("TIMEOUT"), Some("timeout"));
        assert_eq!(kind_for_web_error("CERTIFICATE_EXPIRED"), Some("cert"));
        assert_eq!(kind_for_web_error("CLIENT_CERTIFICATE_CONTAINS_ERRORS"), Some("cert"));
        assert_eq!(kind_for_web_error("REDIRECT_FAILED"), Some("other"));
        assert_eq!(kind_for_web_error("OPERATION_CANCELED"), None);
        assert_eq!(kind_for_web_error("VALID_PROXY_AUTHENTICATION_REQUIRED"), None);
    }

    #[test]
    fn message_kinds() {
        assert_eq!(kind_for_message("Could not connect: Connection refused"), "refused");
        assert_eq!(kind_for_message("Name or service not known"), "dns");
        assert_eq!(kind_for_message("Could not resolve hostname"), "dns");
        assert_eq!(kind_for_message("Operation timed out"), "timeout");
        assert_eq!(kind_for_message("boom"), "other");
    }

    #[test]
    fn probe_accepts_only_loopback() {
        for u in ["http://example.com:80", "http://192.168.1.10:3000", "http://10.0.0.1", "http://localhost.evil.com:80"] {
            assert!(probe_loopback(u).is_err(), "{u}");
        }
        assert!(probe_loopback("nope").is_err());
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        assert_eq!(probe_loopback(&format!("http://127.0.0.1:{port}")), Ok(true));
        assert_eq!(probe_loopback(&format!("http://localhost:{port}/x")), Ok(true));
        drop(l);
        assert_eq!(probe_loopback(&format!("http://127.0.0.1:{port}")), Ok(false));
        assert!(probe_loopback("http://[::1]:1").is_ok());
        assert!(probe_loopback("http://127.9.9.9:1").is_ok());
    }
}
