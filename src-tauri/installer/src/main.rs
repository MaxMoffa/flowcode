#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "windows")]
    if std::env::args().any(|a| a == "--uninstall") {
        flowcode_installer_lib::uninstall::run();
        return;
    }
    flowcode_installer_lib::run();
}
