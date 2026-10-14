//! Pairing links (`flowcode://pair`) the OS opens the app with.

use crate::state::Remote;
use std::sync::Arc;
use std::time::Instant;
use tauri::Emitter;
use tauri_plugin_deep_link::DeepLinkExt;

/// Hooks the deep-link plugin up to `Remote::pending_link` and the
/// `remote://deeplink` event.
pub fn install(app: &tauri::App, remote: &Arc<Remote>) {
    // Kept for the webview to pick up (it may not be listening
    // yet on a cold start) and also pushed live. A link is only
    // ever a suggestion for the pairing screen (also to add another
    // computer), it never pairs by itself.
    let on_link = {
        let (remote, handle) = (Arc::clone(remote), app.handle().clone());
        move |urls: Vec<String>| {
            let Some(url) = urls.into_iter().find(|u| u.starts_with("flowcode://")) else { return };
            remote.lock().pending_link = Some((url.clone(), Instant::now()));
            let _ = handle.emit("remote://deeplink", url);
        }
    };
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        on_link(urls.iter().map(|u| u.to_string()).collect());
    }
    app.deep_link().on_open_url(move |event| on_link(event.urls().iter().map(|u| u.to_string()).collect()));
}
