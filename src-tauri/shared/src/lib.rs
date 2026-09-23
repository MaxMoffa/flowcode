//! Small pieces shared between the main `flowcode` app and the standalone
//! `flowcode-installer` binary, so both get the same console-flash fix and
//! the same native window chrome without one depending on the other.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// `CREATE_NO_WINDOW` (winbase.h) - stops a spawned console-subsystem child
/// (cmd.exe, claude.cmd's node host, wsl.exe, ...) from popping its own
/// console window, which otherwise flashes on screen since a GUI app has no
/// console of its own for the child to inherit. Every Windows
/// `Command::new` that isn't a PTY (ConPTY handles its own window) should
/// set this.
#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The actual blocking spawn-and-wait, shared by every command that needs to
/// run a shell command headlessly. Always call through `spawn_blocking`
/// (never directly from an async command body) - `Command::output()` blocks
/// its calling thread until the child exits.
#[cfg(target_os = "windows")]
pub fn run_command_blocking(command: &str) -> std::io::Result<std::process::Output> {
    // Not `.args(["/C", command])`: Rust escapes each element of `args` as its
    // own argv entry (doubling/backslash-escaping any quotes `command` already
    // contains), then cmd.exe's own /C unquoting re-parses that already-mangled
    // text - two incompatible escaping conventions stacked on each other. That
    // corrupted e.g. `claude -p "/usage"` just enough that claude stopped
    // recognizing `/usage` as a slash command. `raw_arg` hands cmd.exe the
    // command text byte-for-byte, exactly like a real `cmd /C ...` invocation.
    std::process::Command::new("cmd")
        .arg("/C")
        .raw_arg(command)
        .stdin(std::process::Stdio::null())
        // A GUI app has no console for cmd.exe to inherit - without this a
        // console window flashes open and closed for every command run,
        // background polls included.
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

#[cfg(not(target_os = "windows"))]
pub fn run_command_blocking(command: &str) -> std::io::Result<std::process::Output> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    std::process::Command::new(shell)
        .args(["-lc", command])
        .stdin(std::process::Stdio::null())
        .output()
}

/// Trimmed stdout followed by trimmed stderr (newline-separated when both are
/// present) - what a command "printed", for display or for parsing CLIs that
/// report results on stderr (e.g. `codex login status`).
pub fn combined_output(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    match (stdout.trim(), stderr.trim()) {
        (out, "") => out.to_string(),
        ("", err) => err.to_string(),
        (out, err) => format!("{out}\n{err}"),
    }
}

/// Runs `command` headlessly (no terminal, no stdin, so anything expecting
/// interactive input fails fast instead of hanging) off the async runtime and
/// returns its combined output for display - "(nessun output)" if it printed
/// nothing. Shared by the main app's `run_plugin_command` and the installer's
/// identically named command.
pub async fn run_command_for_display(command: String) -> Result<String, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Comando vuoto".to_string());
    }
    let output = tauri::async_runtime::spawn_blocking(move || run_command_blocking(&command))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let text = combined_output(&output);
    Ok(if text.is_empty() { "(nessun output)".to_string() } else { text })
}

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

// When this window (no caption - `decorations: false`) is actually
// maximized (`IsZoomed`), wry/tao's default `WM_NCCALCSIZE` handling leaves
// the proposed client rect a few px short of the monitor's work area on
// every edge, so the webview's own content stops short of the screen edge
// and the OS's default window-background color (light gray) shows through
// in the gap - a thin, stray-looking border/outline hugging the screen.
// Subclass the window and, only while zoomed, replace the proposed client
// rect outright with the monitor's actual work area so content always
// reaches exactly to the (taskbar-aware) screen edge. Restored (and
// Windows-Snap-tiled) windows already size themselves within the work area
// on their own and don't need this.
#[cfg(target_os = "windows")]
unsafe extern "system" fn nc_calc_size_subclass(
    hwnd: windows_sys::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM,
    lparam: windows_sys::Win32::Foundation::LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::Shell::DefSubclassProc;
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsZoomed, NCCALCSIZE_PARAMS, WM_NCCALCSIZE};

    let result = DefSubclassProc(hwnd, msg, wparam, lparam);
    if msg == WM_NCCALCSIZE && wparam != 0 && IsZoomed(hwnd) != 0 {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) != 0 {
            let params = &mut *(lparam as *mut NCCALCSIZE_PARAMS);
            params.rgrc[0] = info.rcWork;
        }
    }
    result
}

/// Toggles DWM's own corner rounding on this window. Called with `true` once
/// at startup (see `apply_window_chrome`'s doc comment for why acrylic needs
/// it), and again with `false` whenever the frontend decides the window is
/// flush against the screen edge - real maximize (`.app-shell.maximized`) or
/// Windows-Snap-tiled (`.app-shell.edge-flush`, see App.tsx's `isEdgeFlush`),
/// since DWM rounds corners unconditionally regardless of window state,
/// and a rounded corner sitting flush against the screen edge or a
/// neighboring snapped window nicks a visible notch out of it rather than
/// just going unnoticed the way it does on a floating window.
#[cfg(target_os = "windows")]
pub fn set_window_corner_rounding(window: &tauri::WebviewWindow, round: bool) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
    };

    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(h) = handle.as_raw() else { return };
    let hwnd = h.hwnd.get() as *mut core::ffi::c_void;

    let pref = if round { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
    unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            &pref as *const _ as *const core::ffi::c_void,
            std::mem::size_of_val(&pref) as u32,
        );
    }
}

#[cfg(target_os = "windows")]
pub fn apply_window_chrome(window: &tauri::WebviewWindow) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
    use windows_sys::Win32::UI::Shell::SetWindowSubclass;

    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::Win32(h) = handle.as_raw() else { return };
    let hwnd = h.hwnd.get() as *mut core::ffi::c_void;

    unsafe {
        SetWindowSubclass(hwnd, Some(nc_calc_size_subclass), 1, 0);
    }

    set_window_corner_rounding(window, true);

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
