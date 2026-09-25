mod install;
mod payload;
#[cfg(target_os = "windows")]
pub mod uninstall;
#[cfg(target_os = "linux")]
#[path = "uninstall_linux.rs"]
pub mod uninstall;

use flowcode_shared::i18n::{is_italian, tr};

/// The wizard's UI language - see shared/src/i18n.rs.
#[tauri::command]
fn set_ui_language(language: String) {
    flowcode_shared::i18n::set_language(&language);
}

#[tauri::command]
fn installer_default_dir() -> String {
    install::default_dir()
}

/// A Flowcode already on this machine, if any - lets the wizard open straight
/// on "update it?" instead of the full setup.
#[tauri::command]
fn installer_existing_install() -> Option<install::ExistingInstall> {
    install::existing_install()
}

/// The version this installer carries, shown next to the installed one.
#[tauri::command]
fn installer_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
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
    desktop_shortcut: Option<bool>,
    features: Option<Vec<String>>,
) -> Result<(), String> {
    // A relative path would install next to wherever the installer happened
    // to be started from (and point shortcuts/registry there) - never what
    // was meant.
    if !std::path::Path::new(&install_dir).is_absolute() {
        return Err(if is_italian() {
            format!("\"{install_dir}\" non è un percorso completo: scegli la cartella con \"Sfoglia...\".")
        } else {
            format!("\"{install_dir}\" is not a full path: pick the folder with \"Browse...\".")
        });
    }
    // `None` for both = an update over an existing install: keep the
    // desktop shortcut the way it was, and leave the integrations alone -
    // recording a pick would make the app re-apply it (and reset whatever
    // the user changed since) on its next launch.
    let desktop_shortcut = desktop_shortcut.unwrap_or_else(install::had_desktop_shortcut);
    install::perform_install(&install_dir, desktop_shortcut)?;
    match features {
        Some(features) => record_feature_choices(&app, &features),
        None => Ok(()),
    }
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
        .set_title(tr("Scegli la cartella di installazione", "Choose the install folder"))
        .pick_folder(move |result| {
            let _ = tx.send(result.map(|p| p.to_string()));
        });
    tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .unwrap_or(None)
}

/// The in-app updater's hand-off (see main.rs): waits for the running
/// Flowcode to quit, installs this installer's payload over `install_dir`
/// exactly like the wizard's "update" path (desktop shortcut and integrations
/// left as they were), and starts Flowcode again. On failure the error is
/// shown (Windows) or logged, and whatever is installed is started anyway, so
/// an update that couldn't run never leaves the user without their app.
pub fn silent_update(install_dir: &str, wait_pid: Option<u32>) {
    if let Some(pid) = wait_pid {
        wait_for_exit(pid);
    }
    let result = if std::path::Path::new(install_dir).is_absolute() {
        install::perform_install(install_dir, install::had_desktop_shortcut())
    } else {
        Err(if is_italian() {
            format!("cartella di installazione non valida: \"{install_dir}\"")
        } else {
            format!("invalid install folder: \"{install_dir}\"")
        })
    };
    if let Err(e) = &result {
        report_update_error(e);
    }
    let _ = install::launch(install_dir);
}

fn report_update_error(message: &str) {
    let text = format!("{}\n\n{message}", tr("Aggiornamento di Flowcode non riuscito:", "Flowcode update failed:"));
    let _ = std::fs::write(std::env::temp_dir().join("flowcode-update-error.log"), &text);
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let (text, title) = (wide(&text), wide("Flowcode"));
        // SAFETY: both strings are NUL-terminated and outlive the call.
        unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OK | MB_ICONERROR) };
    }
}

/// Blocks until process `pid` has exited (at most ~30s): the files it holds
/// can't all be replaced while it runs, and on macOS the whole app bundle is
/// rewritten.
fn wait_for_exit(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
        // SAFETY: plain handle open/wait/close; a null handle means the
        // process is already gone.
        unsafe {
            let handle = OpenProcess(PROCESS_SYNCHRONIZE, 0, pid);
            if !handle.is_null() {
                WaitForSingleObject(handle, 30_000);
                CloseHandle(handle);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success());
            if !alive {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
    }
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
            set_ui_language,
            installer_default_dir,
            installer_existing_install,
            installer_version,
            installer_check_webview2,
            installer_run,
            installer_launch_app,
            installer_pick_dir,
        ])
        .run(tauri::generate_context!())
        .expect("error while running flowcode-installer");
}
