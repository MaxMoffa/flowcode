//! The reconnect side of `Remote`: the backoff sleep, starting and stopping
//! the loop task, and the loop that dials, serves and redials.

use crate::backoff::{backoff_delay, failures_after_link, REBUILD_ENDPOINT_EVERY};
use crate::link::{self, LinkError, Session};
use crate::serve::{serve, Exit};
use crate::state::{Phase, Remote, StateEvent, Status};
use crate::store::{self, Pairing};
use flowcode_remote_proto::{ClientMsg, ServerMsg};
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

impl Remote {
    /// Stops the loop while the app is out of sight and the link is not wanted
    /// (`suspend_link`, the background cap); `app_resumed` restarts it.
    pub(crate) fn suspend(self: &Arc<Self>, app: &AppHandle) {
        if self.visible.load(Ordering::SeqCst) || (self.bg_settings().enabled && !self.bg_capped.load(Ordering::SeqCst)) || self.pairing.load(Ordering::SeqCst) {
            return;
        }
        let (running, host_name, status) = {
            let inner = self.lock();
            (inner.task.is_some(), inner.state.host_name.clone(), inner.state.status)
        };
        if !running || status == Status::Unpaired {
            return;
        }
        self.stop_task();
        // A resume between the check and the stop saw the loop still running and
        // only nudged it: restart it ourselves.
        if self.visible.load(Ordering::SeqCst) {
            self.ensure_task(app);
            return;
        }
        self.log.push("suspended in background");
        self.set_state(app, Status::Offline, host_name, None);
    }

    /// Backoff sleep that `retry_now` can end early.
    pub(crate) async fn wait(&self, app: &AppHandle, host: Option<String>, error: String, attempt: u32, delay: Duration) {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64) + delay.as_millis() as u64;
        // Registered before the state is published: a `retry_now` the UI sends
        // on seeing "waiting" can then never slip in between.
        let notified = self.retry.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        self.log.push(format!("attempt failed ({error}); retry in {} s (failure {attempt})", delay.as_secs()));
        self.emit(app, StateEvent::new(Status::Offline).host(host).error(Some(error)).phase(Phase::Waiting, attempt, Some(at)));
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = &mut notified => {}
        }
    }

    /// Stops the reconnect loop (if any) and drops its outbound queue.
    pub(crate) fn stop_task(&self) {
        let mut inner = self.lock();
        inner.generation += 1;
        inner.out = None;
        if let Some(task) = inner.task.take() {
            task.abort();
        }
    }

    /// Starts the loop unless one is running. Checked and started under one
    /// lock: `connect` and `app_resumed` arrive together at launch, and the
    /// second must not abort the first one's dial in progress.
    pub(crate) fn ensure_task(self: &Arc<Self>, app: &AppHandle) {
        self.spawn_task(app, None, true);
    }

    pub(crate) fn start_task(self: &Arc<Self>, app: &AppHandle, initial: Option<Session>) {
        self.spawn_task(app, initial, false);
    }

    pub(crate) fn spawn_task(self: &Arc<Self>, app: &AppHandle, initial: Option<Session>, only_if_idle: bool) {
        let mut inner = self.lock();
        if only_if_idle && inner.task.is_some() {
            return;
        }
        inner.generation += 1;
        let generation = inner.generation;
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        let (remote, app) = (Arc::clone(self), app.clone());
        inner.task = Some(tauri::async_runtime::spawn(async move {
            reconnect_loop(&app, &remote, initial).await;
            let mut inner = remote.lock();
            if inner.generation == generation {
                inner.task = None;
                inner.out = None;
            }
        }));
    }
}

/// One dial + handshake with the stored desktop.
pub(crate) async fn connect_once(app: &AppHandle, remote: &Remote, pairing: &Pairing, failures: u32) -> Result<Session, LinkError> {
    let host = Some(pairing.host_name.clone());
    // Repeated failures may mean the endpoint is stuck on a dead network
    // (Wi-Fi <-> mobile switch, Android suspending the app): start over with a
    // fresh one. Not while a `pair` holds the current endpoint.
    if failures > 0 && failures.is_multiple_of(REBUILD_ENDPOINT_EVERY) && !remote.pairing.load(Ordering::SeqCst) {
        remote.log.push(format!("endpoint rebuilt after {failures} failed attempts"));
        remote.reset_endpoint().await;
    }
    remote.emit(app, StateEvent::new(Status::Connecting).host(host.clone()).phase(Phase::Dialing, failures, None));
    let endpoint = remote.endpoint().await.map_err(LinkError::Transient)?;
    // Cheap and harmless when nothing changed; cures stale paths when it did.
    if failures > 0 {
        remote.log.push("network change signalled to iroh before dialing");
        endpoint.network_change().await;
    }
    link::handshake_with(
        &endpoint,
        &pairing.node,
        ClientMsg::Auth { token: pairing.token.clone() },
        || remote.emit(app, StateEvent::new(Status::Connecting).host(host.clone()).phase(Phase::Handshake, failures, None)),
        |line| remote.log.push(line),
    )
    .await
}

/// Connects, serves, and reconnects until the pairing is gone or the task is
/// aborted. `initial` is a session `pair` already established.
pub(crate) async fn reconnect_loop(app: &AppHandle, remote: &Arc<Remote>, mut initial: Option<Session>) {
    let mut failures: u32 = 0;
    remote.log.push("connection loop started");
    loop {
        let pairing = match store::load_pairing(&remote.pairing_path(), &remote.codec) {
            store::PairingLoad::Found(p) => p,
            store::PairingLoad::Missing => {
                remote.set_state(app, Status::Unpaired, None, None);
                return;
            }
            store::PairingLoad::Corrupt(e) => {
                remote.log.push(format!("stored pairing is invalid ({e}), treating as unpaired"));
                remote.set_state(app, Status::Unpaired, None, None);
                return;
            }
            // Still paired, the Keystore just did not answer: try again later.
            store::PairingLoad::Unreadable(message) => {
                failures += 1;
                remote.wait(app, None, message, failures, backoff_delay(failures, remote.idle())).await;
                continue;
            }
        };
        let session = match initial.take() {
            Some(s) => s,
            None => match connect_once(app, remote, &pairing, failures).await {
                Ok(s) => s,
                Err(LinkError::Fatal(message)) => {
                    remote.log.push(format!("refused for good, pairing forgotten: {message}"));
                    forget(app, remote, &pairing.host_name, message);
                    return;
                }
                Err(LinkError::Transient(message)) => {
                    failures += 1;
                    remote.wait(app, Some(pairing.host_name), message, failures, backoff_delay(failures, remote.idle())).await;
                    continue;
                }
            },
        };
        let host_name = session.host_name.clone();
        let _ = app.emit(
            "remote://msg",
            ServerMsg::Ready {
                device_name: session.device_name.clone(),
                host_name: host_name.clone(),
                app_version: session.app_version.clone(),
                proto: session.proto,
                caps: session.caps.clone(),
            },
        );
        remote.set_state(app, Status::Online, Some(host_name.clone()), None);
        remote.log.push(format!("online with {host_name}"));
        let online_since = Instant::now();
        match serve(app, remote, session).await {
            Exit::Fatal(message) => {
                remote.log.push(format!("desktop sent a fatal error, pairing forgotten: {message}"));
                forget(app, remote, &host_name, message);
                return;
            }
            Exit::Lost(message) => {
                let lived = online_since.elapsed();
                remote.log.push(format!("link closed after {} s: {message}", lived.as_secs()));
                // A link that held is a fresh start; one that died at once keeps
                // counting, so the backoff grows and the endpoint gets rebuilt.
                failures = failures_after_link(failures, lived);
                remote.wait(app, Some(host_name), message, failures, backoff_delay(failures, remote.idle())).await;
            }
        }
    }
}

/// Tells the webview which desktop refused this phone and switched away.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RevokedEvent {
    host: String,
    message: String,
}

/// A fatal error means the desktop no longer knows this device (revoked,
/// wrong token): keeping the pairing would just loop on refusals. The next
/// saved computer, if any, takes its place.
pub(crate) fn forget(app: &AppHandle, remote: &Arc<Remote>, host_name: &str, message: String) {
    store::forget_pairing(&remote.pairing_path());
    // Another saved desktop takes over (its own loop replaces this one).
    if remote.promote_next(app) {
        // After `promote_next`, whose `remote://computer` resets the webview.
        let _ = app.emit("remote://revoked", RevokedEvent { host: host_name.to_string(), message });
        return;
    }
    remote.rearm_with(false);
    remote.set_state(app, Status::Unpaired, None, Some(message));
}
