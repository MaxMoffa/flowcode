mod agents;
mod fs;
mod plugins;
mod pty;
mod system;

use pty::PtyState;

/// Runs blocking work (filesystem walks, process spawns, process-table
/// refreshes) on Tokio's blocking pool. Tauri runs a plain sync command on the
/// main/event-loop thread, so anything slow there freezes the whole window;
/// an `async` command awaiting this keeps the UI responsive instead.
pub(crate) async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                // On its own thread: `setup()` runs on the main/event-loop
                // thread, and this app's window is already shown by the
                // time `setup()` runs (see tauri.conf.json - not created
                // lazily here) - blocking this closure on warmup_conpty's
                // own child.wait() would freeze that window (visible but
                // "not responding") for however long it takes, instead of
                // just delaying how soon the *frontend's* first real pty
                // spawn is safe. See warmup_conpty's own doc comment for
                // why it exists at all.
                std::thread::spawn(pty::warmup_conpty);
                if let Some(window) = _app.get_webview_window("main") {
                    flowcode_shared::apply_window_chrome(&window);
                }
            }
            Ok(())
        })
        .manage(PtyState::default())
        .manage(agents::ProbePids::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::list_shell_options,
            fs::read_dir,
            fs::is_directory,
            fs::search_dir,
            fs::home_dir,
            fs::config_dir,
            fs::read_shortcuts_defaults,
            fs::read_shortcuts_overrides,
            fs::write_shortcuts_overrides,
            fs::create_file_entry,
            fs::create_dir_entry,
            fs::rename_entry,
            fs::duplicate_entry,
            fs::delete_entry,
            fs::read_text_file,
            fs::write_text_file,
            fs::get_file_info,
            plugins::list_plugins,
            plugins::save_plugin,
            plugins::delete_plugin,
            plugins::run_plugin_command,
            plugins::check_cli_status,
            agents::list_agent_sessions,
            agents::list_claude_agents,
            agents::list_codex_sessions,
            agents::run_claude_usage_probe,
            system::system_info,
            system::wsl_default_distro,
            system::wsl_home_dir,
            system::set_window_square_corners,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
