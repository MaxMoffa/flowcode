mod fs;
mod plugins;
mod pty;

use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            fs::read_dir,
            fs::home_dir,
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
            plugins::run_plugin_command_stdout,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
