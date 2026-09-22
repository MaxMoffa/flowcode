//! The main app's already-built output, embedded at compile time so
//! `flowcode-installer.exe` is a single self-contained file - see
//! `build.rs` for where `FLOWCODE_STAGE_DIR` comes from.

pub static FLOWCODE_EXE: &[u8] = include_bytes!(concat!(env!("FLOWCODE_STAGE_DIR"), "/flowcode.exe"));
pub static SHORTCUTS_JSON: &[u8] =
    include_bytes!(concat!(env!("FLOWCODE_STAGE_DIR"), "/config/shortcuts.json"));
