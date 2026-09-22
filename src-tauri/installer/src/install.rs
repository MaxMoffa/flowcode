use std::fs;
use std::path::PathBuf;

use crate::payload::{FLOWCODE_EXE, SHORTCUTS_JSON};

/// `%LOCALAPPDATA%\Programs\Flowcode` - a per-user install needs no UAC
/// elevation, matching modern installers (VS Code, Discord, ...).
pub fn default_dir() -> String {
    let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
    format!("{base}\\Programs\\Flowcode")
}

#[cfg(target_os = "windows")]
pub(crate) fn start_menu_shortcut_path() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    PathBuf::from(appdata).join(r"Microsoft\Windows\Start Menu\Programs\Flowcode.lnk")
}

#[cfg(target_os = "windows")]
pub(crate) fn desktop_shortcut_path() -> PathBuf {
    let profile = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(profile).join(r"Desktop\Flowcode.lnk")
}

/// Registers Flowcode under Windows' per-user uninstall list -
/// `HKCU\...\Uninstall\Flowcode`, not HKLM, matching the per-user install.
#[cfg(target_os = "windows")]
pub(crate) const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Flowcode";

/// Whether the Evergreen WebView2 runtime is present - checked so the intro
/// step can show a non-blocking "download WebView2" link if not. Full
/// silent-bootstrap parity with the old NSIS template (which installs it
/// automatically) is a deliberate fast-follow, not a v1 blocker.
#[cfg(target_os = "windows")]
pub fn check_webview2() -> bool {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    const CLIENT_KEY: &str = r"SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    const WOW64_KEY: &str = r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(CLIENT_KEY).is_ok()
        || RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(WOW64_KEY).is_ok()
        || RegKey::predef(HKEY_CURRENT_USER).open_subkey(CLIENT_KEY).is_ok()
}

/// Does the actual install: writes the embedded payload to `install_dir`,
/// leaves a copy of this installer behind as `uninstall.exe`, creates
/// shortcuts, and registers the uninstall entry. CLI extras (Claude
/// Code/Codex) are handled separately by the frontend's existing
/// `run_plugin_command` loop, not folded in here.
#[cfg(target_os = "windows")]
pub fn perform_install(install_dir: &str, desktop_shortcut: bool) -> Result<(), String> {
    use mslnk::ShellLink;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let install_dir = PathBuf::from(install_dir);
    fs::create_dir_all(install_dir.join("config")).map_err(|e| e.to_string())?;

    let exe_path = install_dir.join("flowcode.exe");
    fs::write(&exe_path, FLOWCODE_EXE).map_err(|e| e.to_string())?;
    fs::write(install_dir.join("config").join("shortcuts.json"), SHORTCUTS_JSON).map_err(|e| e.to_string())?;

    let uninstall_exe = install_dir.join("uninstall.exe");
    let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    fs::copy(&self_exe, &uninstall_exe).map_err(|e| e.to_string())?;

    let start_menu = start_menu_shortcut_path();
    if let Some(parent) = start_menu.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    ShellLink::new(&exe_path)
        .and_then(|link| link.create_lnk(&start_menu))
        .map_err(|e| e.to_string())?;

    if desktop_shortcut {
        let desktop = desktop_shortcut_path();
        ShellLink::new(&exe_path)
            .and_then(|link| link.create_lnk(&desktop))
            .map_err(|e| e.to_string())?;
    }

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey(UNINSTALL_KEY).map_err(|e| e.to_string())?;
    key.set_value("DisplayName", &"Flowcode").map_err(|e| e.to_string())?;
    key.set_value("DisplayIcon", &exe_path.to_string_lossy().to_string()).map_err(|e| e.to_string())?;
    key.set_value("DisplayVersion", &env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;
    key.set_value("Publisher", &"Massimo Moffa").map_err(|e| e.to_string())?;
    key.set_value("InstallLocation", &install_dir.to_string_lossy().to_string()).map_err(|e| e.to_string())?;
    key.set_value("UninstallString", &format!("\"{}\" --uninstall", uninstall_exe.to_string_lossy()))
        .map_err(|e| e.to_string())?;
    key.set_value("NoModify", &1u32).map_err(|e| e.to_string())?;
    key.set_value("NoRepair", &1u32).map_err(|e| e.to_string())?;

    Ok(())
}
