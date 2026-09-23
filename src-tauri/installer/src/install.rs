use std::fs;
use std::path::PathBuf;

use crate::payload::{FLOWCODE_BIN, SHORTCUTS_JSON};

/// Where the wizard's "location" step starts. Always a per-user location, so
/// no platform ever needs elevation (UAC/sudo/admin password):
/// - Windows: `%LOCALAPPDATA%\Programs\Flowcode`, matching modern
///   installers (VS Code, Discord, ...).
/// - macOS: `~/Applications` - the folder `Flowcode.app` is placed in.
/// - Linux: `$XDG_DATA_HOME/flowcode` (`~/.local/share/flowcode`).
pub fn default_dir() -> String {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".to_string());
        format!("{base}\\Programs\\Flowcode")
    }
    #[cfg(target_os = "macos")]
    {
        home_dir().join("Applications").to_string_lossy().into_owned()
    }
    #[cfg(target_os = "linux")]
    {
        xdg_data_home().join("flowcode").to_string_lossy().into_owned()
    }
}

/// What "Apri Flowcode" at the end of the wizard runs.
pub fn launch(install_dir: &str) -> Result<(), String> {
    let install_dir = PathBuf::from(install_dir);
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut cmd = std::process::Command::new("open");
        cmd.arg(install_dir.join("Flowcode.app"));
        cmd
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        let exe = if cfg!(target_os = "windows") { "flowcode.exe" } else { "flowcode" };
        let mut cmd = std::process::Command::new(install_dir.join(exe));
        // Without this the child inherits *this* process's cwd (wherever the
        // installer happened to be run from), not its own install directory.
        // WebView2 falls back to a cwd-relative data folder when nothing
        // overrides it, so a mismatched cwd here was showing a blank webview
        // instead of the app on first launch.
        cmd.current_dir(&install_dir);
        cmd
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(not(target_os = "windows"))]
fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".to_string()))
}

#[cfg(target_os = "linux")]
pub(crate) fn xdg_data_home() -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir().join(".local").join("share"))
}

/// The user's desktop folder: `xdg-user-dir DESKTOP` on Linux (it's
/// localized - "Scrivania" on an Italian system), `~/Desktop` otherwise.
#[cfg(not(target_os = "windows"))]
pub(crate) fn desktop_dir() -> PathBuf {
    #[cfg(target_os = "linux")]
    if let Ok(out) = std::process::Command::new("xdg-user-dir").arg("DESKTOP").output() {
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    home_dir().join("Desktop")
}

/// Writes an executable, replacing any previous copy. Unlinks first rather
/// than truncating in place: a still-running old Flowcode keeps its (now
/// unlinked) binary mapped, and overwriting a busy executable fails with
/// ETXTBSY on Linux.
#[cfg(not(target_os = "windows"))]
fn write_executable(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::remove_file(path);
    fs::write(path, bytes).map_err(|e| e.to_string())?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
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

/// Suffix for a file set aside by `replace_file` - see `remove_stale_replaced`.
#[cfg(target_os = "windows")]
const REPLACED_SUFFIX: &str = ".flowcode-old";

/// Writes `bytes` to `path`, even when the current copy is in use. Updating
/// while Flowcode is open is the common case - the app holds `flowcode.exe`,
/// every terminal an `OpenConsole.exe`, and `conpty.dll` stays loaded - and
/// Windows refuses to overwrite a running executable or loaded DLL but does
/// allow renaming one. So a failed write moves the old file aside (under a
/// unique name, since an older leftover may itself still be in use) and
/// writes the new one in its place; the running instance keeps its renamed
/// copy until it exits, and the next launch picks up the new version.
#[cfg(target_os = "windows")]
fn replace_file(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    if fs::write(path, bytes).is_ok() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or_default();
    let mut aside = path.as_os_str().to_owned();
    aside.push(format!(".{stamp}{REPLACED_SUFFIX}"));
    fs::rename(path, &aside).map_err(|e| {
        format!(
            "{} è in uso e non può essere sostituito ({e}). Chiudi Flowcode e riprova.",
            path.display()
        )
    })?;
    fs::write(path, bytes).map_err(|e| format!("{}: {e}", path.display()))
}

/// Best-effort cleanup of files `replace_file` set aside on a previous
/// install - anything whose process has exited since goes; whatever is still
/// in use stays for next time.
#[cfg(target_os = "windows")]
fn remove_stale_replaced(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_name().to_string_lossy().ends_with(REPLACED_SUFFIX) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Does the actual install: writes the embedded payload to `install_dir`,
/// leaves a copy of this installer behind as `uninstall.exe`, creates
/// shortcuts, and registers the uninstall entry. The "Integrazioni" picks
/// are recorded separately, by `installer_run` in lib.rs.
#[cfg(target_os = "windows")]
pub fn perform_install(install_dir: &str, desktop_shortcut: bool) -> Result<(), String> {
    use crate::payload::{CONPTY_DLL, OPENCONSOLE_EXE};
    use mslnk::ShellLink;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let install_dir = PathBuf::from(install_dir);
    fs::create_dir_all(install_dir.join("config")).map_err(|e| e.to_string())?;
    fs::create_dir_all(install_dir.join("x64")).map_err(|e| e.to_string())?;
    remove_stale_replaced(&install_dir);
    remove_stale_replaced(&install_dir.join("x64"));

    let exe_path = install_dir.join("flowcode.exe");
    replace_file(&exe_path, FLOWCODE_BIN)?;
    replace_file(&install_dir.join("config").join("shortcuts.json"), SHORTCUTS_JSON)?;
    replace_file(&install_dir.join("conpty.dll"), CONPTY_DLL)?;
    replace_file(&install_dir.join("x64").join("OpenConsole.exe"), OPENCONSOLE_EXE)?;

    let uninstall_exe = install_dir.join("uninstall.exe");
    let self_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let self_bytes = fs::read(&self_exe).map_err(|e| e.to_string())?;
    replace_file(&uninstall_exe, &self_bytes)?;

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

/// The menu entry's file name - also what `uninstall.rs` removes.
#[cfg(target_os = "linux")]
pub(crate) const DESKTOP_FILE: &str = "flowcode.desktop";

/// Linux: the binary plus its files in `install_dir`, a freedesktop entry in
/// `~/.local/share/applications` (what every desktop's app menu/launcher
/// reads - with a "Disinstalla Flowcode" action on it, pointing at the copy
/// of this installer left behind as `uninstall`), and optionally the same
/// entry on the desktop.
#[cfg(target_os = "linux")]
pub fn perform_install(install_dir: &str, desktop_shortcut: bool) -> Result<(), String> {
    use crate::payload::APP_ICON_PNG;
    use std::os::unix::fs::PermissionsExt;

    let install_dir = PathBuf::from(install_dir);
    fs::create_dir_all(install_dir.join("config")).map_err(|e| e.to_string())?;

    let exe_path = install_dir.join("flowcode");
    write_executable(&exe_path, FLOWCODE_BIN)?;
    fs::write(install_dir.join("config").join("shortcuts.json"), SHORTCUTS_JSON).map_err(|e| e.to_string())?;
    let icon_path = install_dir.join("flowcode.png");
    fs::write(&icon_path, APP_ICON_PNG).map_err(|e| e.to_string())?;

    let uninstall_path = install_dir.join("uninstall");
    let self_bytes = fs::read(std::env::current_exe().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    write_executable(&uninstall_path, &self_bytes)?;

    let entry = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Flowcode\n\
         Comment=Il terminale che si adatta a te\n\
         Exec=\"{exe}\"\n\
         Path={dir}\n\
         Icon={icon}\n\
         Terminal=false\n\
         Categories=System;TerminalEmulator;Utility;\n\
         StartupWMClass=flowcode\n\
         Actions=uninstall;\n\
         \n\
         [Desktop Action uninstall]\n\
         Name=Disinstalla Flowcode\n\
         Exec=\"{uninstall}\" --uninstall\n",
        exe = exe_path.display(),
        dir = install_dir.display(),
        icon = icon_path.display(),
        uninstall = uninstall_path.display(),
    );

    let applications = xdg_data_home().join("applications");
    fs::create_dir_all(&applications).map_err(|e| e.to_string())?;
    fs::write(applications.join(DESKTOP_FILE), &entry).map_err(|e| e.to_string())?;
    // Refreshes the menu cache where one exists; harmless (and ignored) where not.
    let _ = std::process::Command::new("update-desktop-database").arg(&applications).status();

    if desktop_shortcut {
        let desktop = desktop_dir();
        fs::create_dir_all(&desktop).map_err(|e| e.to_string())?;
        let shortcut = desktop.join(DESKTOP_FILE);
        fs::write(&shortcut, &entry).map_err(|e| e.to_string())?;
        // Desktop launchers must be executable to run; GNOME additionally
        // wants them marked trusted, which `gio` does when it's around.
        fs::set_permissions(&shortcut, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
        let _ = std::process::Command::new("gio")
            .args(["set", &shortcut.to_string_lossy(), "metadata::trusted", "true"])
            .status();
    }

    Ok(())
}

/// macOS: assembles `Flowcode.app` in `install_dir` (Info.plist, the binary,
/// its icon and config), replacing any previous copy, plus an optional alias
/// on the desktop. No uninstaller is left behind - on macOS removing an app
/// means dragging it to the Trash, which is all this one needs.
#[cfg(target_os = "macos")]
pub fn perform_install(install_dir: &str, desktop_shortcut: bool) -> Result<(), String> {
    use crate::payload::APP_ICON_ICNS;

    let app = PathBuf::from(install_dir).join("Flowcode.app");
    if app.exists() {
        fs::remove_dir_all(&app).map_err(|e| e.to_string())?;
    }
    let contents = app.join("Contents");
    let macos = contents.join("MacOS");
    let resources = contents.join("Resources");
    fs::create_dir_all(&macos).map_err(|e| e.to_string())?;
    fs::create_dir_all(resources.join("config")).map_err(|e| e.to_string())?;

    write_executable(&macos.join("flowcode"), FLOWCODE_BIN)?;
    fs::write(resources.join("icon.icns"), APP_ICON_ICNS).map_err(|e| e.to_string())?;
    fs::write(resources.join("config").join("shortcuts.json"), SHORTCUTS_JSON).map_err(|e| e.to_string())?;

    let version = env!("CARGO_PKG_VERSION");
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>it</string>
  <key>CFBundleDisplayName</key><string>Flowcode</string>
  <key>CFBundleExecutable</key><string>flowcode</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundleIdentifier</key><string>com.maxmoffa.flowcode</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Flowcode</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>{version}</string>
  <key>CFBundleVersion</key><string>{version}</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>LSMinimumSystemVersion</key><string>10.15</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"#
    );
    fs::write(contents.join("Info.plist"), plist).map_err(|e| e.to_string())?;

    if desktop_shortcut {
        let alias = desktop_dir().join("Flowcode.app");
        let _ = fs::remove_file(&alias);
        std::os::unix::fs::symlink(&app, &alias).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    /// A running executable can't be overwritten on Windows - `replace_file`
    /// must still land the new bytes (by moving the busy copy aside), which is
    /// what makes updating over an open Flowcode work.
    #[test]
    fn replace_file_swaps_a_running_executable() {
        let dir = std::env::temp_dir().join(format!("flowcode-replace-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("busy.exe");
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        fs::copy(PathBuf::from(system_root).join(r"System32\PING.EXE"), &exe).unwrap();

        let mut child = std::process::Command::new(&exe)
            .args(["-n", "6", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(fs::write(&exe, b"x").is_err(), "a running exe should be locked");

        replace_file(&exe, b"new contents").unwrap();
        assert_eq!(fs::read(&exe).unwrap(), b"new contents");
        let set_aside = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(REPLACED_SUFFIX));
        assert!(set_aside, "the busy copy should have been renamed aside");

        let _ = child.kill();
        let _ = child.wait();
        remove_stale_replaced(&dir);
        let _ = fs::remove_dir_all(&dir);
    }
}
