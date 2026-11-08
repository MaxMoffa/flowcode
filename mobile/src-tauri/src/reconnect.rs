//! The reconnect side of `Remote`: the backoff sleep, starting and stopping
//! the loop task, and the loop that dials, serves and redials.

use crate::backoff::{backoff_delay, retry_after_link, REBUILD_ENDPOINT_EVERY};
use crate::link::{self, LinkError, Session};
use crate::serve::{serve, Exit};
use crate::state::{Phase, Remote, StateEvent, Status};
use crate::store::{self, Pairing};
use flowcode_remote_proto::{ClientMsg, ServerMsg};
use serde::Serialize;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

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

    /// Backoff sleep; the outer recovery select can interrupt this entire stage.
    pub(crate) async fn wait(&self, app: &AppHandle, host: Option<String>, error: String, attempt: u32, delay: Duration) {
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64) + delay.as_millis() as u64;
        self.log.push(format!("attempt failed ({error}); retry in {} s (failure {attempt})", delay.as_secs()));
        self.emit(app, StateEvent::new(Status::Offline).host(host).error(Some(error)).phase(Phase::Waiting, attempt, Some(at)));
        tokio::time::sleep(delay).await;
    }

    /// Stops the reconnect loop (if any) and drops its outbound queue.
    pub(crate) fn stop_task(&self) {
        let mut inner = self.lock();
        inner.generation += 1;
        inner.out = None;
        if let Some(conn) = inner.conn.take() {
            conn.close(0u32.into(), b"suspended");
        }
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
        let restart = self.restart.subscribe();
        let (remote, app) = (Arc::clone(self), app.clone());
        inner.task = Some(tauri::async_runtime::spawn(async move {
            reconnect_loop(&app, &remote, initial, restart, generation).await;
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
async fn reconnect_loop(app: &AppHandle, remote: &Arc<Remote>, mut initial: Option<Session>, mut restart: watch::Receiver<()>, generation: u64) {
    loop {
        if !until_restart(&mut restart, connection_run(app, remote, initial.take())).await {
            return;
        }
        // Cancelling serve drops its guard, including a blocked writer. Clear
        // published handles too: its normal cleanup is skipped on cancellation.
        let mut inner = remote.lock();
        // A task replaced concurrently may still finish its current poll before
        // abort takes effect. It must not clear the new task's connection.
        if inner.generation != generation {
            return;
        }
        inner.out = None;
        if let Some(conn) = inner.conn.take() {
            conn.close(0u32.into(), b"reconnecting");
        }
        remote.log.push("recovery requested: redialing immediately, backoff reset");
    }
}

/// The watch version covers events during writes and between connection stages.
/// Prefer recovery over a simultaneously completed failure/backoff.
async fn until_restart(restart: &mut watch::Receiver<()>, work: impl Future<Output = ()>) -> bool {
    tokio::select! {
        biased;
        Ok(()) = restart.changed() => true,
        () = work => false,
    }
}

async fn connection_run(app: &AppHandle, remote: &Arc<Remote>, mut initial: Option<Session>) {
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
            "remote://msgs",
            [ServerMsg::Ready {
                device_name: session.device_name.clone(),
                host_name: host_name.clone(),
                app_version: session.app_version.clone(),
                proto: session.proto,
                caps: session.caps.clone(),
            }],
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
                let (next_failures, delay) = retry_after_link(failures, lived, remote.visible.load(Ordering::SeqCst), remote.idle());
                failures = next_failures;
                if delay.is_zero() {
                    remote.log.push("stable foreground link lost: redialing immediately");
                } else {
                    remote.wait(app, Some(host_name), message, failures, delay).await;
                }
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Cancelled(Arc<AtomicBool>);
    impl Drop for Cancelled {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn recovery_interrupts_stalled_work_and_drops_its_connection_guard() {
        let (tx, mut rx) = watch::channel(());
        let cancelled = Arc::new(AtomicBool::new(false));
        let guard = Cancelled(Arc::clone(&cancelled));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let work = async move {
            let _guard = guard;
            started_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        };
        let signal = async move {
            started_rx.await.unwrap();
            tx.send_replace(());
        };
        let (restarted, ()) = tokio::join!(until_restart(&mut rx, work), signal);
        assert!(restarted);
        assert!(cancelled.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn recovery_between_stages_is_not_lost_or_replayed_on_the_next_attempt() {
        let (tx, mut rx) = watch::channel(());
        tx.send_replace(());
        tx.send_replace(()); // Coalesce a burst of network/resume events.
        assert!(until_restart(&mut rx, std::future::pending()).await);
        assert!(!until_restart(&mut rx, async {}).await);
        // A new loop after suspension starts with the latest version consumed.
        let mut new_loop = tx.subscribe();
        assert!(!until_restart(&mut new_loop, async {}).await);
    }
}
