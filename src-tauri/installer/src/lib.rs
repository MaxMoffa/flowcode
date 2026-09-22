mod install;
mod payload;
#[cfg(target_os = "windows")]
pub mod uninstall;

#[tauri::command]
fn installer_default_dir() -> String {
    install::default_dir()
}

#[tauri::command]
fn installer_check_webview2() -> bool {
    #[cfg(target_os = "windows")]
    {
        install::check_webview2()
    }
    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

#[tauri::command]
fn installer_run(install_dir: String, desktop_shortcut: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        install::perform_install(&install_dir, desktop_shortcut)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (install_dir, desktop_shortcut);
        Err("L'installer supporta solo Windows".to_string())
    }
}

/// Identical contract to the main app's `plugins::run_plugin_command` - the
/// existing per-component CLI-install loop in `InstallerFlow.tsx` calls this
/// same command name with no changes needed.
#[tauri::command]
async fn run_plugin_command(command: String) -> Result<String, String> {
    let command = command.trim().to_string();
    if command.is_empty() {
        return Err("Comando vuoto".to_string());
    }

    let output = tauri::async_runtime::spawn_blocking(move || flowcode_shared::run_command_blocking(&command))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let err_text = String::from_utf8_lossy(&output.stderr);
    let err_text = err_text.trim();
    if !err_text.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err_text);
    }
    if text.is_empty() {
        text = "(nessun output)".to_string();
    }
    Ok(text)
}

#[tauri::command]
fn installer_launch_app(install_dir: String) -> Result<(), String> {
    let exe = std::path::PathBuf::from(&install_dir).join("flowcode.exe");
    std::process::Command::new(exe).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    flowcode_shared::apply_window_chrome(&window);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            installer_default_dir,
            installer_check_webview2,
            installer_run,
            run_plugin_command,
            installer_launch_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running flowcode-installer");
}
