//! Extra Flowcode windows - opened by dragging a tab out of one (or by
//! session restore bringing back more than one) - and the cursor hit-testing
//! that tells a tab drop which window it landed on.

use std::collections::HashMap;
use std::sync::Mutex;

use flowcode_shared::i18n::tr;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::util::lock;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// What each new window starts with, keyed by its label - taken once by the
/// window itself when its frontend boots (`window_take_init`): the tab
/// dragged into it, or the tabs a restored session gives it.
#[derive(Default)]
pub struct WindowInits(Mutex<HashMap<String, Value>>);

impl WindowInits {
    pub fn forget(&self, label: &str) {
        lock(&self.0).remove(label);
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Placement {
    /// Where a dragged-out tab was dropped, sized like the window it left.
    AtCursor,
    /// A restored window's saved outer bounds, in physical pixels.
    Bounds { x: i32, y: i32, width: u32, height: u32 },
}

/// Where a window has to sit for the cursor to land on its first tab, as if
/// the tab had been carried there.
fn under_cursor(app: &AppHandle, scale: f64) -> Option<PhysicalPosition<i32>> {
    let cursor = app.cursor_position().ok()?;
    Some(PhysicalPosition::new(
        (cursor.x - 110.0 * scale).round() as i32,
        (cursor.y - 18.0 * scale).round() as i32,
    ))
}

/// Whether any monitor still shows the point - saved bounds from a monitor
/// unplugged since would otherwise open a window nobody can see.
fn on_some_monitor(app: &AppHandle, x: i32, y: i32) -> bool {
    app.available_monitors().is_ok_and(|monitors| {
        monitors.iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            x >= p.x && y >= p.y && x < p.x + s.width as i32 && y < p.y + s.height as i32
        })
    })
}

#[tauri::command]
pub async fn window_open(
    app: AppHandle,
    window: WebviewWindow,
    inits: State<'_, WindowInits>,
    init: Value,
    placement: Placement,
) -> Result<String, String> {
    let label = format!("win-{}", uuid::Uuid::new_v4().simple());
    lock(&inits.0).insert(label.clone(), init);
    let new = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Flowcode")
        .inner_size(1100.0, 700.0)
        // Same floor as tauri.conf.json: the narrow layout is designed for it.
        .min_inner_size(380.0, 480.0)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .visible(false)
        .build()
        .map_err(|e| {
            inits.forget(&label);
            e.to_string()
        })?;
    match placement {
        Placement::AtCursor => {
            if let Ok(size) = window.outer_size() {
                let _ = new.set_size(size);
            }
            let scale = window.scale_factor().unwrap_or(1.0);
            if let Some(pos) = under_cursor(&app, scale) {
                let _ = new.set_position(pos);
            }
        }
        Placement::Bounds { x, y, width, height } => {
            let _ = new.set_size(PhysicalSize::new(width, height));
            if on_some_monitor(&app, x + 40, y + 20) {
                let _ = new.set_position(PhysicalPosition::new(x, y));
            } else {
                let _ = new.center();
            }
        }
    }
    #[cfg(target_os = "windows")]
    flowcode_shared::apply_window_chrome(&new);
    let _ = new.show();
    let _ = new.set_focus();
    Ok(label)
}

/// The calling window's starting content, if it was opened by `window_open`.
#[tauri::command]
pub fn window_take_init(window: WebviewWindow, inits: State<'_, WindowInits>) -> Option<Value> {
    lock(&inits.0).remove(window.label())
}

/// Moves the calling window under the cursor - dragging a window's only tab
/// out of it just carries the whole window along.
#[tauri::command]
pub fn window_move_to_cursor(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = under_cursor(&app, scale).ok_or(tr("posizione del cursore non disponibile", "cursor position unavailable"))?;
    window.set_position(pos).map_err(|e| e.to_string())
}

/// The Flowcode window under the cursor right now, and where the cursor is
/// inside it (CSS pixels, relative to its page) - so a dropped tab can land in
/// the right window, at the right spot in its tab strip.
#[derive(Serialize)]
pub struct CursorTarget {
    label: Option<String>,
    x: f64,
    y: f64,
}

#[tauri::command]
pub fn window_at_cursor(app: AppHandle) -> Result<CursorTarget, String> {
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let windows = app.webview_windows();
    let hit = topmost_at(&windows, cursor);
    let Some(window) = hit else {
        return Ok(CursorTarget { label: None, x: 0.0, y: 0.0 });
    };
    let inner = window.inner_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(CursorTarget {
        label: Some(window.label().to_string()),
        x: (cursor.x - inner.x as f64) / scale,
        y: (cursor.y - inner.y as f64) / scale,
    })
}

/// Windows: asks the OS which top-level window is really under the point,
/// so overlapping Flowcode windows resolve to the one actually on top.
#[cfg(target_os = "windows")]
fn topmost_at(windows: &HashMap<String, WebviewWindow>, cursor: PhysicalPosition<f64>) -> Option<&WebviewWindow> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};

    let point = POINT { x: cursor.x.round() as i32, y: cursor.y.round() as i32 };
    // SAFETY: plain Win32 queries on a point/handle, no pointers kept.
    let root = unsafe {
        let hwnd = WindowFromPoint(point);
        if hwnd.is_null() {
            return None;
        }
        GetAncestor(hwnd, GA_ROOT)
    };
    windows
        .values()
        .find(|w| w.hwnd().is_ok_and(|h| h.0 as isize == root as isize))
}

/// Elsewhere: the visible, non-minimized window whose bounds contain the
/// point - the focused one first when several overlap.
#[cfg(not(target_os = "windows"))]
fn topmost_at<'a>(windows: &'a HashMap<String, WebviewWindow>, cursor: PhysicalPosition<f64>) -> Option<&'a WebviewWindow> {
    let contains = |w: &WebviewWindow| {
        if !w.is_visible().unwrap_or(false) || w.is_minimized().unwrap_or(false) {
            return false;
        }
        let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) else { return false };
        cursor.x >= p.x as f64
            && cursor.y >= p.y as f64
            && cursor.x < (p.x + s.width as i32) as f64
            && cursor.y < (p.y + s.height as i32) as f64
    };
    let mut hits: Vec<&WebviewWindow> = windows.values().filter(|w| contains(w)).collect();
    hits.sort_by_key(|w| !w.is_focused().unwrap_or(false));
    hits.into_iter().next()
}

/// One terminal tab as its window reports it (`window_report_tabs`) - lets
/// the Agents panel of any window name, and jump to, an agent running in a
/// tab of another window.
#[derive(Deserialize, Serialize, Clone)]
pub struct TabInfo {
    /// `None` until the tab's shell has spawned.
    pub pty_id: Option<String>,
    pub tab_id: String,
    pub label: String,
    pub cwd: String,
}

/// One chat tab as its window reports it: the remote access server joins it
/// with the running chat that has the same agent session (see chat.rs).
#[derive(Deserialize, Serialize, Clone)]
pub struct ChatTabInfo {
    pub tab_id: String,
    pub label: String,
    pub session_id: String,
}

/// Window label -> its terminal tabs, as last reported.
#[derive(Default)]
pub struct WindowTabs {
    terminals: Mutex<HashMap<String, Vec<TabInfo>>>,
    chats: Mutex<HashMap<String, Vec<ChatTabInfo>>>,
}

impl WindowTabs {
    pub fn forget(&self, label: &str) {
        lock(&self.terminals).remove(label);
        lock(&self.chats).remove(label);
    }

    /// Every reported chat tab (that has a session) as (window label, tab),
    /// ordered like `list`.
    pub fn list_chats(&self) -> Vec<(String, ChatTabInfo)> {
        let windows = lock(&self.chats);
        let mut labels: Vec<&String> = windows.keys().collect();
        labels.sort();
        labels
            .into_iter()
            .flat_map(|label| windows[label].iter().map(move |t| (label.clone(), t.clone())))
            .collect()
    }

    /// Every reported tab as (window label, tab), windows in label order and
    /// tabs in the order their window reported them - a stable listing for
    /// the remote client (see remote.rs).
    pub fn list(&self) -> Vec<(String, TabInfo)> {
        let windows = lock(&self.terminals);
        let mut labels: Vec<&String> = windows.keys().collect();
        labels.sort();
        labels
            .into_iter()
            .flat_map(|label| windows[label].iter().map(move |t| (label.clone(), t.clone())))
            .collect()
    }

    /// Pty session id -> (window label, tab).
    pub fn by_pty(&self) -> HashMap<String, (String, TabInfo)> {
        let windows = lock(&self.terminals);
        windows
            .iter()
            .flat_map(|(label, tabs)| {
                tabs.iter()
                    .filter_map(move |t| t.pty_id.clone().map(|id| (id, (label.clone(), t.clone()))))
            })
            .collect()
    }

    /// The working folder of the tab showing a pty session, if any.
    pub fn cwd_of(&self, pty_id: &str) -> Option<String> {
        let windows = lock(&self.terminals);
        windows.values().flatten().find(|t| t.pty_id.as_deref() == Some(pty_id)).map(|t| t.cwd.clone())
    }
}

#[tauri::command]
pub fn window_report_tabs(
    window: WebviewWindow,
    state: State<'_, WindowTabs>,
    remote: State<'_, crate::remote::RemoteState>,
    tabs: Vec<TabInfo>,
    chats: Option<Vec<ChatTabInfo>>,
) {
    lock(&state.terminals).insert(window.label().to_string(), tabs);
    lock(&state.chats).insert(window.label().to_string(), chats.unwrap_or_default());
    // Phones see a tab opened or closed without waiting for the next refresh.
    remote.tabs_reported();
}

/// Brings window `label` to the front with tab `tab_id` selected - a
/// double-click on an agent the Agents panel lists from another window.
#[tauri::command]
pub fn window_focus_tab(app: AppHandle, label: String, tab_id: String) -> Result<(), String> {
    use tauri::Emitter;
    let window = app.get_webview_window(&label).ok_or(tr("finestra non trovata", "window not found"))?;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    window.emit_to(label.as_str(), "tab:focus", tab_id).map_err(|e| e.to_string())
}

/// Hides the WebView2 controller while its window is minimized and shows it
/// again on restore - what Microsoft asks hosts to do, and what wry leaves
/// out. Without it a transparent window sometimes comes back from the
/// taskbar with nothing but its acrylic backdrop: the webview never draws a
/// frame again until it's resized. Called on every resize; acts only when
/// the minimized state flips.
#[cfg(target_os = "windows")]
static MINIMIZED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);

/// Drops a closed window's entry from the minimized set.
#[cfg(target_os = "windows")]
pub fn forget_minimized(label: &str) {
    if let Some(set) = lock(&MINIMIZED).as_mut() {
        set.remove(label);
    }
}

#[cfg(target_os = "windows")]
pub fn sync_webview_visibility(window: &tauri::Window) {
    use std::collections::HashSet;
    let minimized = window.is_minimized().unwrap_or(false);
    let label = window.label().to_string();
    let changed = {
        let mut set = lock(&MINIMIZED);
        let set = set.get_or_insert_with(HashSet::new);
        if minimized { set.insert(label.clone()) } else { set.remove(&label) }
    };
    if !changed {
        return;
    }
    let Some(webview) = window.app_handle().get_webview_window(&label) else { return };
    let _ = webview.with_webview(move |platform| unsafe {
        let _ = platform.controller().SetIsVisible(!minimized);
    });
}
