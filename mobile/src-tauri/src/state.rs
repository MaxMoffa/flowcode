//! The connection state the phone shares between the reconnect loop and the
//! commands: what the UI is told, and the `Remote` that owns everything.

use crate::background::{self, Background};
use crate::connlog::ConnLog;
use crate::secure::SecureStore;
use crate::link;
use crate::store;
use flowcode_remote_proto::ClientMsg;
use iroh::Endpoint;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Notify};

/// A deep link that was not picked up by the pairing screen goes stale.
pub(crate) const PENDING_LINK_TTL: Duration = Duration::from_secs(120);

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Status {
    #[default]
    Unpaired,
    Connecting,
    Online,
    Offline,
}

/// Where a reconnect attempt is.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Phase {
    /// Backoff sleep.
    Waiting,
    Dialing,
    Handshake,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StateEvent {
    pub(crate) status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) host_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase: Option<Phase>,
    /// Consecutive failures since the link was last online.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) attempt: Option<u32>,
    /// Unix ms when the next attempt starts; only while waiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) retry_at: Option<u64>,
}

impl StateEvent {
    pub(crate) fn new(status: Status) -> Self {
        StateEvent { status, ..Default::default() }
    }

    pub(crate) fn host(mut self, host_name: Option<String>) -> Self {
        self.host_name = host_name;
        self
    }

    pub(crate) fn error(mut self, error: Option<String>) -> Self {
        self.error = error;
        self
    }

    pub(crate) fn phase(mut self, phase: Phase, attempt: u32, retry_at: Option<u64>) -> Self {
        self.phase = Some(phase);
        self.attempt = Some(attempt);
        self.retry_at = retry_at;
        self
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PairingState {
    pub(crate) paired: bool,
    pub(crate) host_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TicketInfo {
    pub(crate) host_name: String,
    /// Fingerprint of the desktop's node id, to confirm before pairing.
    pub(crate) fingerprint: String,
}

#[derive(Default)]
pub(crate) struct Inner {
    pub(crate) task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// Bumped on every (re)start so a finishing task knows whether it is
    /// still the current one.
    pub(crate) generation: u64,
    pub(crate) out: Option<mpsc::Sender<ClientMsg>>,
    pub(crate) state: StateEvent,
    /// A `flowcode://pair` link and when it arrived; see `PENDING_LINK_TTL`.
    pub(crate) pending_link: Option<(String, Instant)>,
}

pub(crate) struct Remote {
    pub(crate) dir: PathBuf,
    /// Seals the key and pairing files (Android Keystore; pass-through elsewhere).
    /// Its calls block briefly, which is fine on the async runtime workers.
    pub(crate) codec: SecureStore,
    /// Created lazily and rebuilt after repeated failures (`reset_endpoint`).
    pub(crate) endpoint: tokio::sync::Mutex<Option<Endpoint>>,
    pub(crate) inner: Mutex<Inner>,
    /// Cuts the backoff sleep short (`retry_now`). Only `notify_waiters` is
    /// used, so a call with nobody waiting leaves no permit behind to skip a
    /// later backoff.
    pub(crate) retry: Notify,
    /// The app came back to the foreground: probe an online link. Signalled
    /// with `notify_one` so a resume that lands while `serve` is busy writing
    /// is kept (the future is recreated every iteration of its select).
    pub(crate) resume: Notify,
    /// A `pair` is running; a second one is refused.
    pub(crate) pairing: AtomicBool,
    /// Serializes read-modify-write of computers.json.
    pub(crate) others_lock: Mutex<()>,
    /// Wakes a running `pair` to abandon the wait for the desktop's confirmation.
    pub(crate) pair_cancel: Notify,
    /// The last events of the connection, for Settings > diagnostics.
    pub(crate) log: ConnLog,
    /// Foreground service + notifications (Android only).
    pub(crate) background: Background,
    /// "Stay connected in the background", kept in memory and in `background.json`.
    pub(crate) bg: Mutex<background::Settings>,
    /// Title and text of the service's ongoing notification, as the webview
    /// worded them (it knows the language and the desktop's name).
    pub(crate) bg_texts: Mutex<(String, String)>,
    /// The webview is visible. Starts true: the app launches in the foreground.
    pub(crate) visible: AtomicBool,
    /// Bumped on every hide and resume; a background-cap timer only acts if it
    /// is still the one of the latest hide.
    pub(crate) hide_gen: AtomicU64,
    /// The background cap ran out while hidden: the service has stopped itself
    /// (see `ConnectionService`), so the link is treated as in the mode's absence.
    pub(crate) bg_capped: AtomicBool,
}

/// Messages waiting for the link; `send` refuses more instead of growing
/// without bound while the link is stuck.
pub(crate) const OUT_QUEUE: usize = 256;

/// Clears `Remote::pairing` however `pair` ends.
pub(crate) struct PairGuard<'a>(pub(crate) &'a AtomicBool);

impl Drop for PairGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl Remote {
    pub(crate) fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn background_path(&self) -> PathBuf {
        self.dir.join("background.json")
    }

    pub(crate) fn bg_settings(&self) -> background::Settings {
        *self.bg.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Tells the Kotlin side whether to keep the app alive in the background:
    /// only when the mode is on and a desktop is paired.
    pub(crate) fn rearm_with(&self, paired: bool) {
        let settings = self.bg_settings();
        let (title, text) = self.bg_texts.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if let Err(e) = self.background.set_armed(settings.enabled && paired, &title, &text, settings.cap_minutes) {
            self.log.push(format!("background service not armed: {e}"));
        }
    }

    /// Like `rearm_with`, reading the pairing (a Keystore call: not on the main thread).
    pub(crate) fn rearm(&self) {
        self.rearm_with(store::load_pairing(&self.pairing_path(), &self.codec).is_paired());
    }

    /// Queues a message on the live link, if there is one.
    pub(crate) fn queue(&self, msg: ClientMsg) {
        let out = self.lock().out.clone();
        if let Some(out) = out {
            let _ = out.try_send(msg);
        }
    }

    /// A desktop notification arrived: with the app out of sight and the mode
    /// on, show it as an Android notification (the webview shows it otherwise).
    pub(crate) fn on_notify(&self, title: &str, body: &str, tab_id: Option<&str>) {
        let post = !self.visible.load(Ordering::SeqCst) && self.bg_settings().enabled;
        self.log.push(format!("notification from the desktop ({})", if post { "posted" } else { "app visible or mode off" }));
        if post {
            if let Err(e) = self.background.notify(title, body, tab_id) {
                self.log.push(format!("notification failed: {e}"));
            }
        }
    }

    /// Hidden with nothing keeping the link wanted (mode off, or its cap ran
    /// out): see `backoff_delay`.
    pub(crate) fn idle(&self) -> bool {
        !self.visible.load(Ordering::SeqCst) && (!self.bg_settings().enabled || self.bg_capped.load(Ordering::SeqCst))
    }

    pub(crate) fn key_path(&self) -> PathBuf {
        self.dir.join("device.key")
    }

    pub(crate) fn pairing_path(&self) -> PathBuf {
        self.dir.join("pairing.json")
    }

    pub(crate) async fn endpoint(&self) -> Result<Endpoint, String> {
        let mut slot = self.endpoint.lock().await;
        if let Some(endpoint) = slot.as_ref().filter(|e| !e.is_closed()) {
            return Ok(endpoint.clone());
        }
        let key = store::load_or_create_key(&self.key_path(), &self.codec)?;
        let endpoint = link::bind(key).await?;
        *slot = Some(endpoint.clone());
        Ok(endpoint)
    }

    /// Throws the endpoint away; the next `endpoint()` binds a fresh one.
    pub(crate) async fn reset_endpoint(&self) {
        let old = self.endpoint.lock().await.take();
        if let Some(old) = old {
            // Closed before the next bind: two endpoints with one key alive at
            // once would fight over the relay's single slot for this node id.
            let _ = tokio::time::timeout(Duration::from_secs(2), old.close()).await;
        }
    }

    /// Tells iroh the network may have changed (Android does not expose that to
    /// native code), so it re-probes its paths instead of trusting stale ones.
    pub(crate) async fn network_change(&self) {
        let endpoint = self.endpoint.lock().await.clone();
        if let Some(endpoint) = endpoint {
            endpoint.network_change().await;
        }
    }

    pub(crate) fn emit(&self, app: &AppHandle, event: StateEvent) {
        self.lock().state = event.clone();
        let _ = app.emit("remote://state", event);
    }

    pub(crate) fn set_state(&self, app: &AppHandle, status: Status, host_name: Option<String>, error: Option<String>) {
        self.emit(app, StateEvent::new(status).host(host_name).error(error));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_serializes_lowercase() {
        let json = serde_json::to_value(StateEvent::new(Status::Offline).phase(Phase::Waiting, 2, Some(5))).unwrap();
        assert_eq!(json["status"], "offline");
        assert_eq!(json["phase"], "waiting");
        assert_eq!(json["retryAt"], 5);
    }
}
