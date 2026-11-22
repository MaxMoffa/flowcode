mod acp_adapters;
mod agents;
mod fs;
mod git;
mod gpu;
mod attention;
mod chat;
mod chat_images;
mod chat_mcp;
mod terminal_mcp;
mod agent_insight;
mod context;
mod crash;
mod dictation;
pub use dictation::run_gpu_probe_if_requested as run_gpu_probe;
mod net;
mod newtab_background;
mod notify;
mod plugins;
mod profiles;
mod mem_watch;
mod process_job;
mod provider_launcher;
pub use provider_launcher::run_if_requested as run_provider_cli;
mod provider_auth;
mod provider_auth_keys;
mod preview;
mod pty;
mod remote;
mod remote_client;
mod session;
mod spend;
mod system;
mod updater;
mod util;
mod gemini;
mod opencode;
mod cline;
mod usage_limits;
mod link_preview;
mod mcp_icons;
mod vibe;
mod opencode_db;
mod cline_db;
mod view_plugins;
mod watcher;
mod windows;
mod browser_view;
mod browser_downloads;

use pty::PtyState;
use tauri::Manager;

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

/// The frontend's current UI language - what the backend's own messages
/// (errors surfaced in the UI) are worded in. See shared/src/i18n.rs.
#[tauri::command]
fn set_ui_language(language: String) {
    flowcode_shared::i18n::set_language(&language);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // First, so a panic anywhere later (even in startup) is recorded for the
    // next launch to report; see crash.rs.
    crash::install_panic_hook();
    gpu::apply_at_startup();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Serves installed agent view plugins to their sandboxed iframes (see
        // view_plugins.rs). The app CSP's `frame-src` (tauri.conf.json, which
        // can't carry comments) names this scheme and nothing else: it governs
        // both where an iframe may load from and where it may navigate, which
        // is what stops a view from sending itself off to exfiltrate data.
        .register_uri_scheme_protocol("flowcode-plugin", |ctx, request| {
            view_plugins::serve(ctx.app_handle(), &request)
        })
        // Serves the browser panel's host page and the files of a previewed
        // folder (see preview.rs). Its own scheme, separate from flowcode-plugin,
        // because the two have opposite trust: a plugin is sandboxed from the
        // network, a preview artifact may load CDN scripts.
        .register_uri_scheme_protocol("flowcode-preview", |ctx, request| preview::serve(ctx.app_handle(), &request))
        .setup(|app| {
            #[cfg(target_os = "windows")]
            {
                // The `unstable` tauri feature (needed for the native browser
                // child webviews) builds every window's own webview as a
                // "child" one, and Tauri then skips attaching the invisible
                // resize borders undecorated windows need on Windows: the
                // window could not be resized from its edges. Re-setting
                // `resizable` attaches them.
                for w in app.webview_windows().values() {
                    let _ = w.set_resizable(true);
                }
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
            }
            #[cfg(any(target_os = "windows", target_os = "macos"))]
            if let Some(window) = app.get_window("main") {
                flowcode_shared::apply_window_chrome(&window);
            }
            // Pictures of past chats; replayed history stores the ones it needs again.
            if let Ok(cache) = app.path().app_cache_dir() {
                chat_images::init(cache.join("chat-images"));
            }
            std::thread::spawn(chat_images::purge_old);
            std::thread::spawn(chat::purge_attachments);
            browser_downloads::purge_pending(app.handle());
            let remote = remote::RemoteState::load(app.handle());
            remote.autostart();
            app.manage(remote);
            app.manage(remote_client::RemoteClients::new(app.handle()));
            // Late, so the check never competes with the app's own startup.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(20));
                acp_adapters::refresh_in_background(&handle, "claude");
                acp_adapters::refresh_in_background(&handle, "codex");
            });
            // After the marker exists, look for sessions that died uncleanly.
            crash::init(app.handle());
            mem_watch::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if let tauri::WindowEvent::Resized(_) = event {
                windows::sync_webview_visibility(window);
            }
            if let tauri::WindowEvent::Destroyed = event {
                let app = window.app_handle();
                let label = window.label();
                // A closed window takes its terminals with it - nothing is
                // left to show them in.
                app.state::<PtyState>().kill_owned_by(label);
                provider_auth::cancel_owner(&format!("desktop:{label}"));
                app.state::<chat::ChatState>().kill_owned_by(label);
                app.state::<std::sync::Arc<remote_client::RemoteClients>>().forget_window(label);
                app.state::<dictation::DictationState>().forget(label);
                app.state::<session::SessionStore>().forget_window(app, label);
                app.state::<windows::WindowInits>().forget(label);
                app.state::<windows::WindowTabs>().forget(label);
                #[cfg(target_os = "windows")]
                windows::forget_minimized(label);
                app.state::<watcher::DirWatchers>().forget(label);
                browser_view::forget_window(app, label);
            }
        })
        .manage(preview::PreviewRoots::default())
        .manage(PtyState::default())
        .manage(chat::ChatState::default())
        .manage(dictation::DictationState::default())
        .manage(agents::ProbePids::default())
        .manage(session::SessionStore::default())
        .manage(browser_view::BrowserViews::default())
        .manage(windows::WindowInits::default())
        .manage(windows::WindowTabs::default())
        .manage(watcher::DirWatchers::default())
        .manage(updater::UpdaterState::default())
        .invoke_handler(tauri::generate_handler![
            browser_view::browser_view_show,
            browser_view::browser_view_bounds,
            browser_view::browser_view_hide,
            browser_view::browser_view_navigate,
            browser_view::browser_view_back,
            browser_view::browser_view_forward,
            browser_view::browser_view_reload,
            browser_view::browser_view_close,
            browser_view::browser_view_devtools,
            browser_view::browser_view_clear_data,
            browser_view::browser_view_snapshot,
            browser_view::browser_favicon,
            browser_view::browser_probe_local,
            browser_view::browser_view_theme,
            browser_downloads::browser_downloads_list,
            browser_downloads::browser_download_answer,
            browser_downloads::browser_download_cancel,
            browser_downloads::browser_download_open,
            browser_downloads::browser_download_reveal,
            browser_downloads::browser_downloads_open_folder,
            browser_downloads::browser_download_remove,
            browser_downloads::browser_downloads_clear,
            browser_downloads::browser_download_retry,
            set_ui_language,
            crash::crash_pending,
            crash::crash_dismiss,
            crash::crash_dismiss_all,
            crash::crash_issue_url,
            #[cfg(debug_assertions)]
            crash::crash_simulate,
            gpu::get_hardware_acceleration,
            gpu::set_hardware_acceleration,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_detach,
            pty::pty_attach,
            chat::chat_start,
            chat::chat_prompt,
            chat::chat_stage_attachment,
            chat::chat_unstage_attachment,
            chat::chat_cancel,
            chat::chat_resume_schedule,
            chat::chat_resume_update,
            chat::chat_resume_cancel_all,
            chat::chat_permission,
            chat::chat_ask,
            chat::chat_set_mode,
            chat::chat_set_model,
            chat::chat_set_thought,
            chat::chat_goal,
            chat::chat_close,
            chat::chat_renew,
            chat::delegate::delegate_cancel,
            chat::delegate::terminal_delegates,
            chat::chat_adapter_ready,
            chat::chat_events,
            chat::chat_events_page,
            chat::chat_preview,
            chat::chat_preview_save,
            chat::chat_image,
            chat::chat_image_file,
            chat::chat_image_path,
            chat::chat_image_url,
            dictation::dictation_supported,
            dictation::dictation_start,
            dictation::dictation_stop,
            dictation::cleanup::dictation_cleanup,
            dictation::dictation_models,
            dictation::dictation_gpus,
            dictation::dictation_download_model,
            dictation::dictation_cancel_download,
            dictation::dictation_delete_model,
            dictation::dictation_set_remote_prefs,
            session::session_put,
            windows::window_open,
            windows::window_take_init,
            windows::window_move_to_cursor,
            windows::window_at_cursor,
            windows::window_report_tabs,
            notify::notify_show,
            notify::notify_phones,
            notify::notify_once,
            attention::attention_set,
            updater::update_check,
            updater::update_install,
            updater::release_notes,
            updater::release_cover,
            pty::pty_foreground,
            pty::list_shell_options,
            fs::read_dir,
            fs::is_directory,
            fs::search_dir,
            fs::home_dir,
            fs::config_dir,
            fs::take_installer_features,
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
            fs::path_kind,
            fs::path_kinds,
            plugins::list_plugins,
            plugins::save_plugin,
            plugins::delete_plugin,
            plugins::run_plugin_command,
            net::network_online,
            plugins::check_cli_status,
            provider_auth::provider_auth,
            plugins::codex_needs_no_daemon,
            plugins::open_in_vscode,
            agents::list_agent_sessions,
            agents::agent_detection_dump,
            agents::end_pty_agent,
            agents::agent_session_saved,
            agents::list_claude_agents,
            agents::list_claude_sessions,
            agents::list_codex_sessions,
            agents::run_claude_usage_probe,
            git::git_repo_root,
            git::git_worktrees,
            git::git_toplevel,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_show_file,
            git::git_discard,
            git::git_branches,
            git::git_switch_branch,
            profiles::profiles_list,
            profiles::profile_create,
            profiles::profile_update,
            profiles::profile_delete,
            profiles::profile_for_path,
            profiles::profile_logout,
            spend::cli_spend,
            opencode::opencode_console,
            cline::cline_usage,
            context::agent_context,
            agent_insight::agent_tools,
            agent_insight::agent_session_usage,
            agent_insight::chat_cache_info,
            plugins::cli_billing_mode,
            view_plugins::view_plugins_list,
            view_plugins::view_plugin_install,
            view_plugins::view_plugin_delete,
            newtab_background::newtab_background_set,
            newtab_background::newtab_background_get,
            newtab_background::newtab_background_clear,
            vibe::list_vibe_sessions,
            opencode_db::list_opencode_sessions,
            cline_db::list_cline_sessions,
            vibe::vibe_usage_stats,
            vibe::vibe_ensure_model,
            link_preview::link_preview,
            mcp_icons::mcp_icon,
            preview::preview_register_root,
            preview::preview_frame_check,
            preview::preview_pdf_bytes,
            preview::preview_image_bytes,
            preview::preview_probe_port,
            preview::preview_file_mtime,
            system::system_info,
            system::open_with_default_app,
            system::wsl_default_distro,
            system::wsl_home_dir,
            system::powershell_history,
            system::set_window_square_corners,
            watcher::watch_dir,
            watcher::unwatch_dir,
            remote::remote_status,
            remote::remote_set_enabled,
            remote::remote_pair_start,
            remote::remote_revoke,
            remote::remote_snapshot_reply,
            remote::remote_pair_decide,
            remote::remote_pair_cancel,
            remote::remote_size_claim,
            remote::remote_publish_usage,
            remote::remote_publish_settings,
            remote::remote_publish_browser_tabs,
            remote::remote_publish_update,
            remote::remote_set_allow_update,
            remote::remote_publish_profiles,
            remote::remote_publish_actions,
            remote_client::remote_hosts,
            remote_client::remote_host_inspect,
            remote_client::remote_host_fingerprint,
            remote_client::remote_host_pair,
            remote_client::remote_host_cancel_pair,
            remote_client::remote_host_connect,
            remote_client::remote_host_disconnect,
            remote_client::remote_host_forget,
            remote_client::remote_host_send,
            remote_client::remote_host_cached,
        ])
        .build({
            // The `devtools` cargo feature (browser_view.rs) enables devtools on
            // every webview in release; the config-created main window opts out.
            let mut context = tauri::generate_context!();
            for w in context.config_mut().app.windows.iter_mut() {
                w.devtools = Some(cfg!(debug_assertions));
            }
            context
        })
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                crash::end_session();
                provider_auth::shutdown();
                app.state::<chat::ChatState>().shutdown();
                app.state::<PtyState>().shutdown();
            }
        });
}
