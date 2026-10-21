//! Flowcode Mobile: the phone end of the remote protocol. The Rust side owns
//! the iroh connection (so it survives webview reloads and needs no
//! WebSocket/CORS tricks); the webview gets every server message as an event
//! and sends client messages through `send`.

mod background;
mod backoff;
mod commands;
mod computers;
pub mod connlog;
#[cfg(mobile)]
mod deeplink;
pub mod link;
mod reconnect;
mod secure;
mod serve;
mod speech;
mod state;
pub mod store;
mod updater;
mod view_cache;

use background::Background;
use connlog::ConnLog;
use secure::SecureStore;
use state::{Inner, Remote, StateEvent, Status};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use tauri::Manager;
use tokio::sync::Notify;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_opener::init()).plugin(secure::init()).plugin(background::init()).plugin(speech::init()).plugin(updater::init());
    #[cfg(mobile)]
    {
        builder = builder.plugin(tauri_plugin_barcode_scanner::init()).plugin(tauri_plugin_biometric::init()).plugin(tauri_plugin_deep_link::init()).plugin(tauri_plugin_haptics::init());
    }
    builder
        // Agent-view plugin files the desktop sent, served to the sandboxed iframe
        // (tauri.conf.json's `frame-src` allows exactly this origin).
        .register_uri_scheme_protocol("flowcode-plugin", |ctx, request| view_cache::serve(ctx.app_handle(), &request))
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let bg_path = dir.join("background.json");
            let remote = Arc::new(Remote {
                dir,
                codec: app.state::<SecureStore>().inner().clone(),
                endpoint: tokio::sync::Mutex::new(None),
                inner: Mutex::new(Inner { state: StateEvent::new(Status::Connecting), ..Default::default() }),
                retry: Notify::new(),
                resume: Notify::new(),
                pairing: AtomicBool::new(false),
                others_lock: Mutex::new(()),
                pair_cancel: Notify::new(),
                log: ConnLog::default(),
                background: app.state::<Background>().inner().clone(),
                bg: Mutex::new(background::load(&bg_path)),
                bg_texts: Mutex::new((String::new(), String::new())),
                visible: AtomicBool::new(true),
                hide_gen: AtomicU64::new(0),
                bg_capped: AtomicBool::new(false),
            });
            app.manage(Arc::clone(&remote));
            #[cfg(mobile)]
            deeplink::install(app, &remote);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::platform,
            commands::pairing_state,
            commands::take_pending_link,
            commands::inspect_ticket,
            commands::my_fingerprint,
            commands::pair,
            commands::cancel_pair,
            commands::connect,
            commands::send,
            commands::retry_now,
            commands::app_resumed,
            commands::connection_log,
            commands::app_hidden,
            commands::suspend_link,
            commands::background_settings,
            commands::set_background_settings,
            commands::background_texts,
            commands::notification_permission,
            commands::request_notification_permission,
            commands::take_pending_tab,
            commands::unpair,
            speech::speech_available,
            speech::speech_start,
            speech::speech_stop,
            speech::speech_cancel,
            view_cache::view_cache_has,
            view_cache::view_cache_write,
            view_cache::view_cache_commit,
            view_cache::view_cache_prune,
            updater::update_check,
            updater::update_install,
            computers::computers,
            computers::switch_computer,
            computers::forget_computer
        ])
        .run(tauri::generate_context!())
        .expect("error while running Flowcode Mobile");
}
