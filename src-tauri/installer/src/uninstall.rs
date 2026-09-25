//! Entered directly from `main.rs` when launched as `flowcode-installer.exe
//! --uninstall` (the copy of this binary left in the install dir, referenced
//! by the registry's `UninstallString`). No Tauri/webview involved - a
//! single yes/no confirmation doesn't need one.

use std::ffi::OsStr;
use std::iter::once;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_YESNO,
};

use crate::install::{desktop_shortcut_path, start_menu_shortcut_path, UNINSTALL_KEY};
use flowcode_shared::i18n::tr;

fn wide(s: &str) -> Vec<u16> {
    OsStr::new(s).encode_wide().chain(once(0)).collect()
}

fn message_box(text: &str, title: &str, flags: u32) -> i32 {
    let text = wide(text);
    let title = wide(title);
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), flags) }
}

fn read_install_location() -> Option<PathBuf> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey(UNINSTALL_KEY).ok()?;
    let value: String = key.get_value("InstallLocation").ok()?;
    Some(PathBuf::from(value))
}

fn remove_uninstall_registry() {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(UNINSTALL_KEY);
}

fn remove_shortcut(path: &Path) {
    let _ = std::fs::remove_file(path);
}

pub fn run() {
    let confirmed = message_box(
        tr("Vuoi disinstallare Flowcode da questo computer?", "Do you want to uninstall Flowcode from this computer?"),
        tr("Disinstalla Flowcode", "Uninstall Flowcode"),
        MB_YESNO | MB_ICONQUESTION,
    ) == IDYES;
    if !confirmed {
        return;
    }

    remove_shortcut(&start_menu_shortcut_path());
    remove_shortcut(&desktop_shortcut_path());

    if let Some(install_dir) = read_install_location() {
        // Best-effort: this process's own exe (`uninstall.exe`, inside
        // `install_dir`) can't remove itself synchronously, but Windows
        // allows deleting an in-use exe - it's unlinked once this process
        // exits, so `remove_dir_all` still succeeds.
        let _ = std::fs::remove_dir_all(&install_dir);
    }

    remove_uninstall_registry();

    message_box(
        tr("Flowcode è stato disinstallato.", "Flowcode has been uninstalled."),
        tr("Disinstalla Flowcode", "Uninstall Flowcode"),
        MB_OK | MB_ICONINFORMATION,
    );
}
