//! The `#[tauri::command]`s of remote access.

use super::*;

#[tauri::command]
pub fn remote_status(state: tauri::State<'_, RemoteState>) -> RemoteStatus {
    state.0.status()
}

#[tauri::command]
pub async fn remote_set_enabled(state: tauri::State<'_, RemoteState>, enabled: bool) -> Result<RemoteStatus, String> {
    let shared = Arc::clone(&state.0);
    Ok(shared.set_enabled(enabled).await)
}

/// Lets (or stops) paired phones install desktop updates; connected phones
/// are told the new `allowed` right away.
#[tauri::command]
pub fn remote_set_allow_update(state: tauri::State<'_, RemoteState>, enabled: bool) -> RemoteStatus {
    lock(&state.0.config).allow_phone_update = enabled;
    state.0.save();
    state.0.update.send_modify(|_| {});
    state.0.status()
}

/// The update state the phone shows (built by the desktop frontend).
#[tauri::command]
pub fn remote_publish_update(state: tauri::State<'_, RemoteState>, update: serde_json::Value) -> Result<(), String> {
    if update.to_string().len() > MAX_UPDATE_JSON_BYTES {
        return Err(tr("Dati di aggiornamento troppo grandi", "Update data too large").to_string());
    }
    publish(&state.0.update, update);
    Ok(())
}

/// A pairing code and the QR link carrying it. A code generated less than
/// `PAIR_REUSE_MS` ago is returned again unless `force` (the "Regenerate"
/// button) asks for a new one.
#[tauri::command]
pub async fn remote_pair_start(state: tauri::State<'_, RemoteState>, force: Option<bool>) -> Result<PairStart, String> {
    let shared = Arc::clone(&state.0);
    let endpoint = lock(&shared.runtime).running.as_ref().map(|r| r.endpoint.clone());
    let Some(endpoint) = endpoint else {
        return Err(tr("Accesso remoto non attivo", "Remote access is not running").to_string());
    };
    // Decided before the awaits below: two calls racing each other (React
    // StrictMode runs effects twice) must end up with the same code.
    let (code, expires_at) = {
        let mut pairings = lock(&shared.pairings);
        let now = now_ms();
        match pairings.recent(now).filter(|_| !force.unwrap_or(false)) {
            Some(current) => current,
            None => pairings.start(random_hex(16)?, now),
        }
    };
    // Wait for the relay so the ticket tells the phone how to reach us from
    // another network; without it only the (usually unreachable) direct
    // addresses would be in the QR code.
    let _ = tokio::time::timeout(ONLINE_TIMEOUT, endpoint.online()).await;
    let node = EndpointTicket::new(endpoint.addr()).to_string();
    let ticket = PairingTicket { node, code: code.clone(), host: shared.host_name.clone() }.encode();
    Ok(PairStart { ticket, code, expires_at })
}

#[tauri::command]
pub fn remote_revoke(state: tauri::State<'_, RemoteState>, device_id: String) -> RemoteStatus {
    state.0.revoke(&device_id);
    state.0.status()
}

#[tauri::command]
pub fn remote_snapshot_reply(state: tauri::State<'_, RemoteState>, req_id: String, data: String, seq: u64) {
    if let Some(waiter) = lock(&state.0.waiters).remove(&req_id) {
        let _ = waiter.send((data, seq));
    }
}

/// The desktop's current usage readings, for the phone's usage screen.
#[tauri::command]
pub fn remote_publish_usage(state: tauri::State<'_, RemoteState>, items: Vec<UsageItem>) {
    publish(&state.0.usage, items);
}

/// The desktop settings the phone mirrors (built by the frontend's RemoteSettingsBridge).
#[tauri::command]
pub fn remote_publish_settings(state: tauri::State<'_, RemoteState>, settings: serde_json::Value) {
    publish(&state.0.settings, settings);
}

/// The account profiles the phone lists (built by the frontend's RemoteSettingsBridge).
#[tauri::command]
pub fn remote_publish_profiles(state: tauri::State<'_, RemoteState>, profiles: serde_json::Value, default_logged_in: Option<serde_json::Value>) {
    publish(&state.0.profiles, serde_json::json!({ "profiles": profiles, "defaultLoggedIn": default_logged_in }));
}

/// The `profiles` message for what the frontend published; none until it has.
pub(super) fn profiles_msg(published: &serde_json::Value) -> Option<ServerMsg> {
    let profiles = published.get("profiles").filter(|p| !p.is_null())?.clone();
    let default_logged_in = published.get("defaultLoggedIn").filter(|d| !d.is_null()).cloned();
    Some(ServerMsg::Profiles { profiles, default_logged_in })
}

/// The quick actions the phone may trigger.
#[tauri::command]
pub fn remote_publish_actions(state: tauri::State<'_, RemoteState>, actions: Vec<Action>) {
    publish(&state.0.actions, actions);
}

pub(super) const MAX_UPDATE_JSON_BYTES: usize = 64 * 1024;

/// The `Update` message for a published value: forced to an object, with
/// `allowed` set from the current consent.
pub(super) fn update_msg(update: &serde_json::Value, allowed: bool) -> Option<ServerMsg> {
    if update.is_null() {
        return None;
    }
    let mut update = match update {
        serde_json::Value::Object(_) => update.clone(),
        other => serde_json::json!({ "value": other }),
    };
    update["allowed"] = serde_json::Value::Bool(allowed);
    Some(ServerMsg::Update { update })
}

/// Stores `value` in the watch channel, waking the connections only if it
/// differs from what they already have.
pub(super) fn publish<T: PartialEq>(tx: &watch::Sender<T>, value: T) {
    tx.send_if_modified(|current| {
        let changed = *current != value;
        if changed {
            *current = value;
        }
        changed
    });
}

/// The user's answer to a pairing request shown on the desktop.
#[tauri::command]
pub fn remote_pair_decide(state: tauri::State<'_, RemoteState>, req_id: String, accept: bool) {
    if let Some(waiter) = lock(&state.0.pair_waiters).remove(&req_id) {
        let _ = waiter.send(accept);
    }
}

/// Invalidates the active pairing code (the QR dialog was closed).
#[tauri::command]
pub fn remote_pair_cancel(state: tauri::State<'_, RemoteState>) {
    lock(&state.0.pairings).active = None;
}

/// The size a phone currently claims for `pty_id`, so a window that has just
/// adopted the tab can re-apply the override.
#[tauri::command]
pub fn remote_size_claim(state: tauri::State<'_, RemoteState>, pty_id: String) -> Option<SizeInfo> {
    state.0.size_claim(&pty_id).map(|(cols, rows)| SizeInfo { cols, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_msg_forces_object_and_sets_allowed() {
        assert!(update_msg(&serde_json::Value::Null, true).is_none());
        let Some(ServerMsg::Update { update }) = update_msg(&serde_json::json!({ "state": "idle", "allowed": true }), false) else { panic!() };
        assert_eq!(update, serde_json::json!({ "state": "idle", "allowed": false }));
        let Some(ServerMsg::Update { update }) = update_msg(&serde_json::json!("x"), true) else { panic!() };
        assert_eq!(update["allowed"], serde_json::json!(true));
    }

}
