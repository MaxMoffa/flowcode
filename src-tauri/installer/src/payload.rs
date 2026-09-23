//! The main app's already-built output, embedded at compile time so the
//! installer is a single self-contained file - see `build.rs` for where
//! `FLOWCODE_STAGE_DIR` comes from.

#[cfg(target_os = "windows")]
pub static FLOWCODE_BIN: &[u8] = include_bytes!(concat!(env!("FLOWCODE_STAGE_DIR"), "/flowcode.exe"));
#[cfg(not(target_os = "windows"))]
pub static FLOWCODE_BIN: &[u8] = include_bytes!(concat!(env!("FLOWCODE_STAGE_DIR"), "/flowcode"));

pub static SHORTCUTS_JSON: &[u8] =
    include_bytes!(concat!(env!("FLOWCODE_STAGE_DIR"), "/config/shortcuts.json"));

/// Windows Terminal's ConPTY, installed beside `flowcode.exe` so the app uses
/// it instead of the inbox one - see `src-tauri/conpty/README.md`.
#[cfg(target_os = "windows")]
pub static CONPTY_DLL: &[u8] = include_bytes!(concat!(env!("FLOWCODE_STAGE_DIR"), "/conpty.dll"));
#[cfg(target_os = "windows")]
pub static OPENCONSOLE_EXE: &[u8] = include_bytes!(concat!(env!("FLOWCODE_STAGE_DIR"), "/x64/OpenConsole.exe"));

/// App icons straight from the repo (not staged - they're source files, not
/// build output): the .desktop entry's icon on Linux, the bundle icon of the
/// `Flowcode.app` the installer assembles on macOS.
#[cfg(target_os = "linux")]
pub static APP_ICON_PNG: &[u8] = include_bytes!("../../icons/icon.png");
#[cfg(target_os = "macos")]
pub static APP_ICON_ICNS: &[u8] = include_bytes!("../../icons/icon.icns");
