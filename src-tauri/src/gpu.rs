//! "Hardware acceleration" setting. Some GPU setups (seen on a hybrid
//! AMD + NVIDIA laptop with WebView2 154) hand WebView2 garbage tiles: bands
//! of the window come out gray or as red/green UV-gradient test patterns.
//! Launching with `--disable-gpu` makes it render cleanly, so the app lets
//! the user turn GPU rendering off.
//!
//! WebView2 reads its browser arguments only when its environment is created,
//! i.e. before the first window exists, so the choice is a file in the config
//! dir read at startup (`apply_at_startup`) rather than frontend storage, and
//! a change takes effect on the next launch.

use std::path::PathBuf;

/// Same folder as Tauri's `app_config_dir()` on Windows (%APPDATA% +
/// identifier in tauri.conf.json) - computed by hand because startup needs it
/// before any `AppHandle` exists.
fn settings_path() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    Some(PathBuf::from(appdata).join("com.maxmoffa.flowcode").join("gpu.json"))
}

fn read_enabled() -> bool {
    settings_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v["hardwareAcceleration"].as_bool())
        .unwrap_or(true)
}

/// Call before `tauri::Builder` creates any window. Sets
/// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, which every window's WebView2
/// environment picks up. That variable replaces the arguments wry would
/// otherwise pass, so wry's own default switches are repeated here, and any
/// value already set by the user is kept in front.
pub fn apply_at_startup() {
    if !cfg!(target_os = "windows") || read_enabled() {
        return;
    }
    const VAR: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    const WRY_DEFAULTS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";
    let existing = std::env::var(VAR).unwrap_or_default();
    let base = if existing.trim().is_empty() { WRY_DEFAULTS.to_string() } else { existing };
    if base.contains("--disable-gpu") {
        return;
    }
    // Runs at the top of `run()`, before Tauri or any other thread that could
    // read the environment has started.
    std::env::set_var(VAR, format!("{base} --disable-gpu"));
}

#[tauri::command]
pub fn get_hardware_acceleration() -> bool {
    read_enabled()
}

#[tauri::command]
pub fn set_hardware_acceleration(enabled: bool) -> Result<(), String> {
    let path = settings_path().ok_or("APPDATA non disponibile")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let contents = serde_json::json!({ "hardwareAcceleration": enabled }).to_string();
    std::fs::write(path, contents).map_err(|e| e.to_string())
}
