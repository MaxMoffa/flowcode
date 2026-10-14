//! More than one desktop: `pairing.json` holds the one in use, `computers.json`
//! the others. Switching swaps them and restarts the loop.

use crate::link;
use crate::state::{Remote, Status};
use crate::store::{self, Pairing};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Computer {
    id: String,
    host_name: String,
    active: bool,
}

impl Remote {
    pub(crate) fn others_path(&self) -> PathBuf {
        self.dir.join("computers.json")
    }

    fn others(&self) -> Result<Vec<Pairing>, String> {
        store::load_others(&self.others_path(), &self.codec)
    }

    /// Keeps `pairing` among the other computers (replacing an older entry
    /// for the same desktop).
    pub(crate) fn stash(&self, pairing: Pairing) -> Result<(), String> {
        let id = link::computer_id(&pairing.node);
        let mut list = self.others()?;
        list.retain(|p| link::computer_id(&p.node) != id);
        list.push(pairing);
        store::save_others(&self.others_path(), &list, &self.codec)
    }

    /// Drops the desktop `id` from the other computers.
    pub(crate) fn unstash(&self, id: &str) -> Result<(), String> {
        let mut list = self.others()?;
        let before = list.len();
        list.retain(|p| link::computer_id(&p.node) != id);
        if list.len() == before {
            return Ok(());
        }
        store::save_others(&self.others_path(), &list, &self.codec)
    }

    /// Makes `pairing` the active one and restarts the loop on it. The webview
    /// is told first (`remote://computer`) so it drops the old desktop's data.
    fn activate(self: &Arc<Self>, app: &AppHandle, pairing: Pairing) -> Result<(), String> {
        let id = link::computer_id(&pairing.node);
        store::save_pairing(&self.pairing_path(), &pairing, &self.codec)?;
        // After the save: a crash in between leaves a duplicate, never a loss.
        self.unstash(&id)?;
        self.stop_task();
        let _ = app.emit("remote://computer", ());
        self.set_state(app, Status::Connecting, Some(pairing.host_name.clone()), None);
        self.ensure_task(app);
        self.rearm_with(true);
        Ok(())
    }

    /// The active pairing is gone (unpaired, or refused by its desktop): the
    /// next saved computer takes its place. False when there is none.
    pub(crate) fn promote_next(self: &Arc<Self>, app: &AppHandle) -> bool {
        let next = match self.others() {
            Ok(list) => list.into_iter().next(),
            Err(e) => {
                self.log.push(e);
                None
            }
        };
        let Some(next) = next else { return false };
        self.log.push(format!("switching to {}", next.host_name));
        match self.activate(app, next) {
            Ok(()) => true,
            Err(e) => {
                self.log.push(format!("cannot switch computer: {e}"));
                false
            }
        }
    }
}

/// Every desktop this phone is paired with, the active one first.
// `(async)`: off the main thread, which the Android Keystore call needs free.
#[tauri::command(async)]
pub fn computers(remote: State<'_, Arc<Remote>>) -> Result<Vec<Computer>, String> {
    let mut out = Vec::new();
    let mut active_id = None;
    if let store::PairingLoad::Found(p) = store::load_pairing(&remote.pairing_path(), &remote.codec) {
        let id = link::computer_id(&p.node);
        active_id = Some(id.clone());
        out.push(Computer { id, host_name: p.host_name, active: true });
    }
    for p in remote.others()? {
        let id = link::computer_id(&p.node);
        if active_id.as_deref() != Some(id.as_str()) {
            out.push(Computer { id, host_name: p.host_name, active: false });
        }
    }
    Ok(out)
}

/// Switches to the saved desktop `id`; the one in use joins the others.
#[tauri::command(async)]
pub fn switch_computer(app: AppHandle, remote: State<'_, Arc<Remote>>, id: String) -> Result<(), String> {
    let remote = Arc::clone(&remote);
    if remote.pairing.load(Ordering::SeqCst) {
        return Err("a pairing is in progress".into());
    }
    let target = remote
        .others()?
        .into_iter()
        .find(|p| link::computer_id(&p.node) == id)
        .ok_or_else(|| "computer not found".to_string())?;
    match store::load_pairing(&remote.pairing_path(), &remote.codec) {
        store::PairingLoad::Found(current) => {
            if link::computer_id(&current.node) == id {
                return Ok(());
            }
            remote.stash(current)?;
        }
        // Unreadable for now: overwriting it would lose that computer.
        store::PairingLoad::Unreadable(e) => return Err(e),
        store::PairingLoad::Missing | store::PairingLoad::Corrupt(_) => {}
    }
    remote.log.push(format!("switching to {}", target.host_name));
    remote.activate(&app, target)
}
