//! Extra Flowcode windows - opened by dragging a tab out of one (or by
//! session restore bringing back more than one) - and the cursor hit-testing
//! that tells a tab drop which window it landed on.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// What each new window starts with, keyed by its label - taken once by the
/// window itself when its frontend boots (`window_take_init`): the tab
/// dragged into it, or the tabs a restored session gives it.
#[derive(Default)]
pub struct WindowInits(Mutex<HashMap<String, Value>>);

impl WindowInits {
    pub fn forget(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
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
    inits.0.lock().unwrap().insert(label.clone(), init);
    let new = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Flowcode")
        .inner_size(1100.0, 700.0)
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
    inits.0.lock().unwrap().remove(window.label())
}

/// Moves the calling window under the cursor - dragging a window's only tab
/// out of it just carries the whole window along.
#[tauri::command]
pub fn window_move_to_cursor(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let pos = under_cursor(&app, scale).ok_or("posizione del cursore non disponibile")?;
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
fn topmost_at<'a>(windows: &'a HashMap<String, WebviewWindow>, cursor: PhysicalPosition<f64>) -> Option<&'a WebviewWindow> {
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

/// Window label -> its terminal tabs, as last reported.
#[derive(Default)]
pub struct WindowTabs(Mutex<HashMap<String, Vec<TabInfo>>>);

impl WindowTabs {
    pub fn forget(&self, label: &str) {
        self.0.lock().unwrap().remove(label);
    }

    /// Pty session id -> (window label, tab).
    pub fn by_pty(&self) -> HashMap<String, (String, TabInfo)> {
        let windows = self.0.lock().unwrap();
        windows
            .iter()
            .flat_map(|(label, tabs)| {
                tabs.iter()
                    .filter_map(move |t| t.pty_id.clone().map(|id| (id, (label.clone(), t.clone()))))
            })
            .collect()
    }
}

#[tauri::command]
pub fn window_report_tabs(window: WebviewWindow, state: State<'_, WindowTabs>, tabs: Vec<TabInfo>) {
    state.0.lock().unwrap().insert(window.label().to_string(), tabs);
}

/// Brings window `label` to the front with tab `tab_id` selected - a
/// double-click on an agent the Agents panel lists from another window.
#[tauri::command]
pub fn window_focus_tab(app: AppHandle, label: String, tab_id: String) -> Result<(), String> {
    use tauri::Emitter;
    let window = app.get_webview_window(&label).ok_or("finestra non trovata")?;
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    window.emit_to(label.as_str(), "tab:focus", tab_id).map_err(|e| e.to_string())
}
