//! Phone-sized terminals: which connection sizes which pty.

use super::*;

impl Shared {
    // ---- phone-sized terminals ---------------------------------------------

    /// `conn` sizes `pty` for its screen; the most recent claimant wins.
    pub(super) fn claim_size(&self, pty_id: &str, conn: u64, cols: u16, rows: u16) {
        // A phone could name any id: a claim on a pty that isn't there would
        // just linger.
        if !self.app.state::<PtyState>().exists(pty_id) {
            return;
        }
        // A sane range: zero would panic the terminal, huge values waste memory.
        let (cols, rows) = (cols.clamp(10, 500), rows.clamp(3, 300));
        let before = {
            let mut sizing = lock(&self.sizing);
            let claims = sizing.entry(pty_id.to_string()).or_default();
            let before = claims.last().map(|c| (c.cols, c.rows));
            claims.retain(|c| c.conn != conn);
            claims.push(SizeClaim { conn, cols, rows });
            before
        };
        // A claim during the grace period cancels the deferred release; the
        // pty still has the size it was left with.
        let held = lock(&self.pending_release).remove(pty_id).map(|(_, size)| size);
        // Same size as before: resizing again would only make a TUI redraw.
        if before.or(held) == Some((cols, rows)) {
            return;
        }
        self.apply_size(pty_id, Some((cols, rows)));
    }

    /// `conn` stopped sizing `pty`: the previous claimant's size comes back,
    /// or the desktop's own when there is none.
    /// When no phone is left the desktop's size only comes back after
    /// `RELEASE_GRACE`, unless a phone claims the pty again before.
    pub(super) fn release_size(self: &Arc<Self>, pty_id: &str, conn: u64) {
        let (prev, next) = {
            let mut sizing = lock(&self.sizing);
            let Some(claims) = sizing.get_mut(pty_id) else { return };
            let before = claims.len();
            let prev = claims.last().map(|c| (c.cols, c.rows));
            claims.retain(|c| c.conn != conn);
            if claims.len() == before {
                return;
            }
            let next = claims.last().map(|c| (c.cols, c.rows));
            if claims.is_empty() {
                sizing.remove(pty_id);
            }
            (prev, next)
        };
        match (prev, next) {
            // Another phone keeps the size in force: nothing changes.
            (Some(p), Some(n)) if p == n => {}
            (_, Some(_)) => self.apply_size(pty_id, next),
            (None, None) => {}
            (Some(size), None) => {
                let id = self.release_seq.fetch_add(1, Ordering::Relaxed) + 1;
                lock(&self.pending_release).insert(pty_id.to_string(), (id, size));
                let shared = Arc::clone(self);
                let pty_id = pty_id.to_string();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(RELEASE_GRACE).await;
                    let due = {
                        let mut pending = lock(&shared.pending_release);
                        if pending.get(&pty_id).is_some_and(|(i, _)| *i == id) {
                            pending.remove(&pty_id);
                            true
                        } else {
                            false
                        }
                    };
                    if due && !lock(&shared.sizing).contains_key(&pty_id) {
                        shared.apply_size(&pty_id, None);
                    }
                });
            }
        }
    }

    pub(super) fn release_all_sizes(self: &Arc<Self>, conn: u64) {
        let ptys: Vec<String> =
            lock(&self.sizing).iter().filter(|(_, c)| c.iter().any(|c| c.conn == conn)).map(|(p, _)| p.clone()).collect();
        for pty in ptys {
            self.release_size(&pty, conn);
        }
    }

    /// Resizes the pty and tells the window showing it (it shrinks its
    /// terminal to match). `None` hands control back: the window refits and
    /// resizes the pty itself through its normal path.
    pub(super) fn apply_size(&self, pty_id: &str, size: Option<(u16, u16)>) {
        let pty = self.app.state::<PtyState>();
        if let Some((cols, rows)) = size {
            let _ = pty.resize(pty_id, cols, rows);
        }
        if let Some(owner) = pty.owner_of(pty_id) {
            self.emit_size_override(&owner, pty_id, size);
        }
    }

    pub(super) fn emit_size_override(&self, window: &str, pty_id: &str, size: Option<(u16, u16)>) {
        let payload = serde_json::json!({ "ptyId": pty_id, "cols": size.map(|s| s.0), "rows": size.map(|s| s.1) });
        let _ = self.app.emit_to(window, EVT_SIZE_OVERRIDE, payload);
    }

    /// The size the most recent phone claimed for `pty_id`, if any.
    pub(super) fn size_claim(&self, pty_id: &str) -> Option<(u16, u16)> {
        lock(&self.sizing).get(pty_id)?.last().map(|c| (c.cols, c.rows))
    }

    /// Tells the window now showing a phone-sized pty about the override when
    /// the tab moved there from another window (it would otherwise fit the
    /// terminal to its own size and resize the pty back under the phone).
    pub(super) fn sync_size_owners(&self, tabs: &[Tab]) {
        let mut moved: Vec<(String, String, (u16, u16))> = Vec::new();
        {
            let sizing = lock(&self.sizing);
            let mut owners = lock(&self.size_owners);
            owners.retain(|pty, _| sizing.contains_key(pty));
            for tab in tabs {
                let Some(claim) = sizing.get(&tab.pty_id).and_then(|c| c.last()) else { continue };
                let previous = owners.insert(tab.pty_id.clone(), tab.window.clone());
                if previous.is_some_and(|window| window != tab.window) {
                    moved.push((tab.window.clone(), tab.pty_id.clone(), (claim.cols, claim.rows)));
                }
            }
        }
        for (window, pty_id, size) in moved {
            self.emit_size_override(&window, &pty_id, Some(size));
        }
    }
}
