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
    let install_dir = std::path::PathBuf::from(&install_dir);
    let exe = install_dir.join("flowcode.exe");
    std::process::Command::new(exe)
        // Without this the child inherits *this* process's cwd (wherever
        // flowcode-installer.exe happened to be run from), not its own
        // install directory. WebView2 falls back to a cwd-relative data
        // folder when nothing overrides it, so a mismatched cwd here was
        // showing a blank webview instead of the app on first launch.
        .current_dir(&install_dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn installer_pick_dir(app: tauri::AppHandle, default_dir: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_directory(&default_dir)
        .set_title("Scegli la cartella di installazione")
        .pick_folder(move |result| {
            let _ = tx.send(result.map(|p| p.to_string()));
        });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .unwrap_or(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            installer_pick_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running flowcode-installer");
}
