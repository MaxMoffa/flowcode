mod install;
mod payload;
#[cfg(target_os = "windows")]
pub mod uninstall;
#[cfg(target_os = "linux")]
#[path = "uninstall_linux.rs"]
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

/// `(async)`: writing the embedded payload (the whole app binary) to disk
/// takes long enough to freeze the window if run on the UI thread.
#[tauri::command(async)]
fn installer_run(
    app: tauri::AppHandle,
    install_dir: String,
    desktop_shortcut: bool,
    features: Vec<String>,
) -> Result<(), String> {
    // A relative path would install next to wherever the installer happened
    // to be started from (and point shortcuts/registry there) - never what
    // was meant.
    if !std::path::Path::new(&install_dir).is_absolute() {
        return Err(format!(
            "\"{install_dir}\" non è un percorso completo: scegli la cartella con \"Sfoglia...\"."
        ));
    }
    install::perform_install(&install_dir, desktop_shortcut)?;
    record_feature_choices(&app, &features)
}

/// Hands the wizard's "Integrazioni" picks to the app: its first launch
/// reads (then deletes) this file and enables/pins just those plugins - see
/// `take_installer_features` in the main app. Written into the *app's*
/// config folder (its own identifier, not this installer's), which is where
/// that command looks.
fn record_feature_choices(app: &tauri::AppHandle, features: &[String]) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().config_dir().map_err(|e| e.to_string())?.join("com.maxmoffa.flowcode");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::json!({ "features": features }).to_string();
    std::fs::write(dir.join("installer-features.json"), json).map_err(|e| e.to_string())
}

#[tauri::command]
fn installer_launch_app(install_dir: String) -> Result<(), String> {
    install::launch(&install_dir)
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
            installer_launch_app,
            installer_pick_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running flowcode-installer");
}
