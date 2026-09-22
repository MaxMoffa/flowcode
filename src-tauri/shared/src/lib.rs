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
pub fn run_command_blocking(command: &str) -> std::io::Result<std::process::Output> {
    if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            // Not `.args(["/C", command])`: Rust escapes each element of
            // `args` as its own argv entry (doubling/backslash-escaping any
            // quotes `command` already contains), then cmd.exe's own /C
            // unquoting re-parses that already-mangled text - two
            // incompatible escaping conventions stacked on each other. That
            // corrupted e.g. `claude -p "/usage"` just enough that claude
            // stopped recognizing `/usage` as its client-side slash command
            // and treated it as a literal chat prompt instead. `raw_arg`
            // hands cmd.exe the command text byte-for-byte, matching how a
            // real `cmd /C claude -p "/usage"` invocation reads it.
            std::process::Command::new("cmd")
                .arg("/C")
                .raw_arg(command)
                .stdin(std::process::Stdio::null())
                // Without this, cmd.exe (a console-subsystem process) gets
                // its own new console allocated since this GUI app has
                // none to inherit - a window flashes open and closes for
                // every single command run, including background polls
                // every few seconds.
                .creation_flags(CREATE_NO_WINDOW)
                .output()
        }
        #[cfg(not(target_os = "windows"))]
        unreachable!()
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        std::process::Command::new(shell)
            .args(["-lc", command])
            .stdin(std::process::Stdio::null())
            .output()
    }
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
#[cfg(target_os = "windows")]
pub fn apply_window_chrome(window: &tauri::WebviewWindow) {
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
