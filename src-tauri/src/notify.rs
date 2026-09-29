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

#[cfg(target_os = "windows")]
fn show(app: AppHandle, label: String, tab_id: String, title: String, body: String) {
    use tauri_winrt_notification::Toast;
    // An installed build owns its identifier as toast source; a dev build
    // isn't registered with Windows, so borrow PowerShell's like Tauri does.
    let app_id = if tauri::is_dev() {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    };
    let _ = Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .on_activated(move |_| {
            let _ = crate::windows::window_focus_tab(app.clone(), label.clone(), tab_id.clone());
            Ok(())
        })
        .show();
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
