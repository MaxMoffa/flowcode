#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by Flowcode's own updater (see updater.rs in the main app):
    // `--update <install dir> --wait-pid <pid>` installs over that folder
    // with no window at all, then relaunches Flowcode.
    let args: Vec<String> = std::env::args().collect();
    if let Some(i) = args.iter().position(|a| a == "--update") {
        let install_dir = args.get(i + 1).cloned().unwrap_or_default();
        let wait_pid = args
            .iter()
            .position(|a| a == "--wait-pid")
            .and_then(|j| args.get(j + 1))
            .and_then(|p| p.parse::<u32>().ok());
        flowcode_installer_lib::silent_update(&install_dir, wait_pid);
        return;
    }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    if std::env::args().any(|a| a == "--uninstall") {
        flowcode_installer_lib::uninstall::run();
        return;
    }
    flowcode_installer_lib::run();
}
