//! Native desktop notifications for agent events (see src/notifications) -
//! a click on one brings its window to the front with the tab selected.

use tauri::AppHandle;

/// Shows a notification; clicking it focuses `tab_id` in window `label`.
/// Fire-and-forget: a notification that can't be shown is never an error
/// worth surfacing to the user.
#[tauri::command]
pub fn notify_show(app: AppHandle, label: String, tab_id: String, title: String, body: String) {
    show(app, label, tab_id, title, body);
}

/// Like `notify_show`, not tied to a tab, and shown once per `key` however
/// many windows ask - each window watches the same usage limits (see
/// src/notifications/limitResetWatcher.ts).
#[tauri::command]
pub fn notify_once(app: AppHandle, key: String, label: String, title: String, body: String) {
    use std::collections::HashSet;
    use std::sync::{LazyLock, Mutex};
    static SHOWN: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
    if SHOWN.lock().unwrap_or_else(|e| e.into_inner()).insert(key) {
        show(app, label, String::new(), title, body);
    }
}

#[cfg(target_os = "windows")]
fn show(app: AppHandle, label: String, tab_id: String, title: String, body: String) {
    use tauri_winrt_notification::Toast;
    let app_id = app.config().identifier.clone();
    register_toast_source(&app);
    let _ = Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .on_activated(move |_| {
            let _ = crate::windows::window_focus_tab(app.clone(), label.clone(), tab_id.clone());
            Ok(())
        })
        .show();
}

/// Windows labels a toast with the name and icon registered for its source
/// id, and falls back to the raw id (or, for an unknown one, nothing useful)
/// otherwise - so register ours once per run. Same for dev and installed
/// builds, which keeps the toast reading "Flowcode" instead of "Windows
/// PowerShell". The icon has to be a file on disk, so the embedded PNG is
/// written out to the app's local data folder first.
#[cfg(target_os = "windows")]
fn register_toast_source(app: &AppHandle) {
    use std::os::windows::process::CommandExt;
    use std::sync::Once;
    use tauri::Manager;
    static REGISTERED: Once = Once::new();
    REGISTERED.call_once(|| {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let key = format!(r"HKCU\Software\Classes\AppUserModelId\{}", app.config().identifier);
        let reg = |name: &str, value: &str| {
            let _ = std::process::Command::new("reg")
                .args(["add", &key, "/v", name, "/t", "REG_SZ", "/d", value, "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        };
        reg("DisplayName", "Flowcode");
        let icon = app.path().app_local_data_dir().ok().and_then(|dir| {
            let file = dir.join("toast-icon.png");
            std::fs::create_dir_all(&dir).ok()?;
            std::fs::write(&file, include_bytes!("../icons/128x128.png")).ok()?;
            Some(file)
        });
        if let Some(icon) = icon {
            reg("IconUri", &icon.to_string_lossy());
        }
    });
}

#[cfg(not(target_os = "windows"))]
fn show(app: AppHandle, label: String, tab_id: String, title: String, body: String) {
    // `show()` can block (D-Bus round trip) and, on Linux, the click has to
    // be waited for - so all of it happens off the caller's thread.
    std::thread::spawn(move || {
        let Ok(handle) = notify_rust::Notification::new().summary(&title).body(&body).action("default", "default").show() else {
            return;
        };
        #[cfg(all(unix, not(target_os = "macos")))]
        handle.wait_for_action(|action| {
            if action == "default" {
                let _ = crate::windows::window_focus_tab(app.clone(), label.clone(), tab_id.clone());
            }
        });
        #[cfg(target_os = "macos")]
        let _ = (handle, app, label, tab_id);
    });
}
