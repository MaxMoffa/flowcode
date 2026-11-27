//! Context menus in their own transparent window. The in-app browser's pages
//! are native child webviews that always paint above the app's DOM, so a menu
//! drawn in the DOM would be hidden behind them. A top-level window owned by
//! the app window sits above its child webviews, so the frontend renders the
//! menu there instead (see src/context-menu/menuPopupClient.ts).

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder, Window};

/// Windows that show the app (`main`, `win-*`), as opposed to the auxiliary
/// ones (menu popups, browser probes, crash dialog).
pub fn is_app_window(label: &str) -> bool {
    label == "main" || label.starts_with("win-")
}

fn popup_label(owner: &str) -> String {
    format!("menu-popup-{owner}")
}

/// Creates the owner's menu popup (hidden) unless it exists, and returns its label.
#[tauri::command]
pub fn menu_popup_ensure(app: AppHandle, window: Window) -> Result<String, String> {
    let label = popup_label(window.label());
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = (&app, &window, &label);
        Err("unsupported".to_string())
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        if app.get_webview_window(&label).is_some() {
            return Ok(label);
        }
        let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html#menu-popup".into()))
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .visible(false)
            .focused(false)
            .always_on_top(false)
            .inner_size(1.0, 1.0)
            .devtools(cfg!(debug_assertions));
        // An owner, not a `.parent(&WebviewWindow)`: `get_webview_window`
        // breaks on windows that hold child webviews. An owned window stays
        // above its owner and is destroyed with it. (`parent_raw` on Windows
        // would make a WS_CHILD window clipped to the owner, hence `owner_raw`.)
        #[cfg(windows)]
        let builder = builder.owner_raw(window.hwnd().map_err(|e| e.to_string())?);
        #[cfg(target_os = "macos")]
        let builder = builder.parent_raw(window.ns_window().map_err(|e| e.to_string())?);
        builder.build().map_err(|e| e.to_string())?;
        Ok(label)
    }
}

/// Called by the popup once it has laid the menu out: sizes the window around
/// the menu (plus `pad` of room for its shadow), keeps the menu inside the
/// screen's work area like the DOM menu does, and shows it.
#[tauri::command]
pub fn menu_popup_open(app: AppHandle, window: Window, x: f64, y: f64, width: f64, height: f64, pad: f64) -> Result<(), String> {
    let monitors = app.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors
        .into_iter()
        .find(|m| {
            let p = m.position();
            let s = m.size();
            x >= p.x as f64 && x < p.x as f64 + s.width as f64 && y >= p.y as f64 && y < p.y as f64 + s.height as f64
        })
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "no monitor".to_string())?;
    let scale = monitor.scale_factor();
    let wa = monitor.work_area();
    let (mw, mh) = (width * scale, height * scale);
    let margin = 8.0 * scale;
    let (left, top) = (wa.position.x as f64, wa.position.y as f64);
    let (right, bottom) = (left + wa.size.width as f64, top + wa.size.height as f64);
    let mx = x.min(right - mw - margin).max(left + margin);
    let my = y.min(bottom - mh - margin).max(top + margin);
    let p = pad * scale;
    window.set_size(PhysicalSize::new((mw + 2.0 * p).round(), (mh + 2.0 * p).round())).map_err(|e| e.to_string())?;
    window.set_position(PhysicalPosition::new((mx - p).round(), (my - p).round())).map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Hides the calling popup.
#[tauri::command]
pub fn menu_popup_hide(window: Window) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_windows_exclude_popups() {
        assert!(is_app_window("main"));
        assert!(is_app_window("win-1"));
        assert!(!is_app_window("menu-popup-main"));
        assert!(!is_app_window("menu-popup-win-1"));
    }
}
