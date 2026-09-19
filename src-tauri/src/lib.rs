mod agents;
mod fs;
mod plugins;
mod pty;
mod system;

use pty::PtyState;

// Native window chrome + Acrylic backdrop, Windows 11 only.
//
// These three DWM attributes have to agree with each other and with the CSS
// `.app-shell`, which is why they live in one function:
//
// * DWMWA_SYSTEMBACKDROP_TYPE (what `window_vibrancy::apply_acrylic` sets to
//   DWMSBT_TRANSIENTWINDOW) makes DWM paint a blurred backdrop across the
//   window's *whole* rect, behind the webview's transparent pixels. Acrylic
//   rather than Mica: Mica only samples the desktop wallpaper, so on a dark
//   wallpaper under the dark theme it is indistinguishable from plain black,
//   whereas acrylic blurs whatever is actually behind the window - which is
//   the "frosted glass" this is meant to look like.
// * Because of that backdrop, DWMWCP_DONOTROUND is wrong here. It was right
//   back when there was no backdrop (a square but fully invisible native
//   rect, with the only visible shape drawn by CSS), but with a backdrop on,
//   a square native rect paints a blurred square right behind the CSS rounded
//   corners - which is exactly the "square edge around the rounded corner"
//   artifact. So we let DWM round (DWMWCP_ROUND, 8px on Win11) and match
//   `.app-shell`'s border-radius to 8px so the two curves coincide.
// * Enabling a system backdrop also makes DWM draw its own 1px border around
//   the window. DWMWA_BORDER_COLOR = DWMWA_COLOR_NONE removes it, leaving
//   only the CSS `1px solid var(--window-border)`.
//
// Kept deliberately minimal otherwise: no DwmExtendFrameIntoClientArea and no
// DwmEnableBlurBehindWindow(fEnable: 0), and no delayed re-apply. None of
// them are needed; the frame-extend in particular fights tao's own
// transparency setup (tao calls DwmEnableBlurBehindWindow with an empty
// region at creation time when `transparent: true`, which is what gives the
// window per-pixel alpha in the first place - the backdrop composites fine
// underneath that).
//
// Note the backdrop is only *visible* to the extent the CSS on top of it is
// translucent: see --surface-alpha in src/themes/themes.css.
#[cfg(target_os = "windows")]
fn apply_window_chrome(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
    };

    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(h) = handle.as_raw() else { return };
    let hwnd = h.hwnd.get() as *mut core::ffi::c_void;

    let pref = DWMWCP_ROUND;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        );
    }

    // DWMWA_COLOR_NONE - "do not draw the border at all".
    let border: u32 = 0xFFFF_FFFE;
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            &border as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&border) as u32,
        );
    }

    let _ = window_vibrancy::apply_acrylic(window, None);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                // On its own thread: `setup()` runs on the main/event-loop
                // thread, and this app's window is already shown by the
                // time `setup()` runs (see tauri.conf.json - not created
                // lazily here) - blocking this closure on warmup_conpty's
                // own child.wait() would freeze that window (visible but
                // "not responding") for however long it takes, instead of
                // just delaying how soon the *frontend's* first real pty
                // spawn is safe. See warmup_conpty's own doc comment for
                // why it exists at all.
                std::thread::spawn(pty::warmup_conpty);
                if let Some(window) = _app.get_webview_window("main") {
                    apply_window_chrome(&window);
                }
            }
            Ok(())
        })
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fs::read_dir,
            fs::search_dir,
            fs::home_dir,
            fs::config_dir,
            fs::read_shortcuts_defaults,
            fs::read_shortcuts_overrides,
            fs::write_shortcuts_overrides,
            fs::create_file_entry,
            fs::create_dir_entry,
            fs::rename_entry,
            fs::duplicate_entry,
            fs::delete_entry,
            fs::read_text_file,
            fs::write_text_file,
            fs::get_file_info,
            plugins::list_plugins,
            plugins::save_plugin,
            plugins::delete_plugin,
            plugins::run_plugin_command,
            plugins::run_plugin_command_stdout,
            plugins::check_cli_status,
            agents::list_agent_sessions,
            agents::list_claude_agents,
            agents::list_codex_sessions,
            system::system_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
