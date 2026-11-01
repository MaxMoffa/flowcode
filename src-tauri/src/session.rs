//! The saved session (`session.json`) across every open window.
//!
//! Each window owns its own tabs, so each one reports its own part
//! (`session_put`) and this store writes the whole file - one writer, instead
//! of several windows racing to overwrite each other's copy. Closing a window
//! while others stay open drops its part (like closing a browser window);
//! closing the last one keeps it, so the next launch reopens it.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};
use flowcode_shared::i18n::tr;

#[derive(Default)]
pub struct SessionStore {
    inner: Mutex<Inner>,
    /// Set right before the app exits on purpose (an update): windows being
    /// torn down then must keep their part of the session.
    quitting: AtomicBool,
    flush_gen: AtomicU64,
}

#[derive(Default)]
struct Inner {
    /// Window label -> that window's snapshot, in the order windows first
    /// reported (the main window always first - see `write`).
    windows: Vec<(String, Value)>,
    /// Window label -> latest `flush_all` round persisted successfully.
    acks: HashMap<String, u64>,
    /// Unsaved editor buffers, even when session restore is disabled. A
    /// missing entry means this frontend has not reported its editor state.
    dirty_editors: HashMap<String, bool>,
    /// Hash of what `session.json` was last written with - an unchanged
    /// snapshot (the periodic save with nothing new) skips the disk.
    last_written: Option<u64>,
}

impl SessionStore {
    pub fn set_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    /// A window was destroyed: its part goes, unless it was the last one open
    /// (the app is quitting with it) or the app is exiting for an update.
    pub fn forget_window(&self, app: &AppHandle, label: &str) {
        let others_open = app.webview_windows().keys().any(|l| l != label);
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.forget_live_window(label);
        if self.quitting.load(Ordering::SeqCst) || !others_open {
            return;
        }
        let before = inner.windows.len();
        inner.windows.retain(|(l, _)| l != label);
        if inner.windows.len() != before {
            let Inner { windows, last_written, .. } = &mut *inner;
            let _ = write(app, Some(windows), last_written);
        }
    }
}

impl Inner {
    fn forget_live_window(&mut self, label: &str) {
        self.acks.remove(label);
        self.dirty_editors.remove(label);
    }
}

/// Acknowledgements describe a durable write, rather than merely receipt of
/// the IPC request. Keep the write injected so failure ordering can be tested
/// without a native app or a real user config directory.
fn put_snapshot(
    inner: &mut Inner,
    label: &str,
    snapshot: Option<Value>,
    flush_gen: Option<u64>,
    dirty_editors: Option<bool>,
    persist: impl FnOnce(Option<&[(String, Value)]>, &mut Option<u64>) -> Result<(), String>,
) -> Result<(), String> {
    match dirty_editors {
        Some(dirty) => { inner.dirty_editors.insert(label.to_string(), dirty); }
        None => { inner.dirty_editors.remove(label); }
    }
    let enabled = snapshot.is_some();
    match snapshot {
        None => inner.windows.clear(),
        Some(snapshot) => match inner.windows.iter_mut().find(|(l, _)| l == label) {
            Some(entry) => entry.1 = snapshot,
            None => inner.windows.push((label.to_string(), snapshot)),
        },
    }
    persist(enabled.then_some(inner.windows.as_slice()), &mut inner.last_written)?;
    if let Some(generation) = flush_gen {
        inner.acks.entry(label.to_string()).and_modify(|latest| *latest = (*latest).max(generation)).or_insert(generation);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum FlushStatus {
    Pending,
    UnknownEditors,
    DirtyEditors,
    Ready,
}

fn flush_status(inner: &Inner, live: &[String], generation: u64) -> FlushStatus {
    if live.iter().any(|label| !inner.acks.get(label).is_some_and(|ack| *ack >= generation)) {
        return FlushStatus::Pending;
    }
    if live.iter().any(|label| !inner.dirty_editors.contains_key(label)) {
        return FlushStatus::UnknownEditors;
    }
    if live.iter().any(|label| inner.dirty_editors.get(label) == Some(&true)) {
        return FlushStatus::DirtyEditors;
    }
    FlushStatus::Ready
}

fn write(app: &AppHandle, windows: Option<&[(String, Value)]>, last_written: &mut Option<u64>) -> Result<(), String> {
    let contents = match windows {
        Some(windows) if !windows.is_empty() => {
            let mut ordered: Vec<&Value> = windows.iter().filter(|(l, _)| l == "main").map(|(_, v)| v).collect();
            ordered.extend(windows.iter().filter(|(l, _)| l != "main").map(|(_, v)| v));
            serde_json::json!({ "version": 2, "windows": ordered }).to_string()
        }
        _ => "{}".to_string(),
    };
    let hash = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        contents.hash(&mut hasher);
        hasher.finish()
    };
    if *last_written == Some(hash) {
        return Ok(());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    write_private(&dir.join("session.json"), contents.as_bytes()).map_err(|e| e.to_string())?;
    *last_written = Some(hash);
    Ok(())
}

/// Atomic like `fs::write_atomic`, but the file is created owner-only on Unix:
/// it holds terminal scrollback, which can contain anything the user typed or
/// printed.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let tmp = path.with_file_name(format!("{name}.tmp-{}", std::process::id()));
        let result = (|| {
            let mut file = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
            file.write_all(bytes)?;
            std::fs::rename(&tmp, path)
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result
    }
    #[cfg(not(unix))]
    crate::fs::write_atomic(path, bytes)
}

/// Stores the calling window's part of the session and rewrites the file.
/// `snapshot: None` means session restore is switched off: the whole file is
/// cleared instead. `flush_gen` answers a `session:flush` request.
///
/// `(async)`: serializing every window's snapshot and writing the file must
/// not run on the event-loop thread.
#[tauri::command(async)]
pub fn session_put(
    app: AppHandle,
    window: tauri::WebviewWindow,
    store: State<'_, SessionStore>,
    snapshot: Option<Value>,
    flush_gen: Option<u64>,
    dirty_editors: Option<bool>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mut inner = store.inner.lock().unwrap_or_else(|e| e.into_inner());
    // A queued IPC request must not reinsert a window after Destroyed has
    // removed it from the saved session and live editor bookkeeping.
    if app.get_webview_window(&label).is_none() {
        return Err("window_closed".into());
    }
    put_snapshot(&mut inner, &label, snapshot, flush_gen, dirty_editors, |windows, last_written| write(&app, windows, last_written))
}

/// Asks every window to report its latest state now (`session:flush`) and
/// waits - briefly - for all of them to answer. Used right before the app
/// exits for an update, so the relaunched version restores everything as it
/// was a moment ago rather than as of the last periodic save.
pub async fn flush_all(app: &AppHandle) -> Result<(), String> {
    let store = app.state::<SessionStore>();
    let generation = store.flush_gen.fetch_add(1, Ordering::SeqCst) + 1;
    app.emit("session:flush", generation).map_err(|e| format!("{}: {e}", tr("Impossibile richiedere il salvataggio delle finestre.", "Couldn't request the windows' session state.")))?;
    let app = app.clone();
    crate::blocking(move || {
        let store = app.state::<SessionStore>();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            // New windows must answer too; a window closed during the flush
            // no longer needs an acknowledgement.
            let live: Vec<String> = app.webview_windows().keys().cloned().collect();
            let status = {
                let inner = store.inner.lock().unwrap_or_else(|e| e.into_inner());
                flush_status(&inner, &live, generation)
            };
            match status {
                FlushStatus::Ready => return Ok(()),
                FlushStatus::DirtyEditors => return Err(tr("Salva o chiudi i file modificati in tutte le finestre prima di aggiornare.", "Save or close the edited files in every window before updating.").to_string()),
                FlushStatus::UnknownEditors => return Err(tr("Una finestra non è pronta per l'aggiornamento. Attendi che finisca di caricarsi e riprova.", "A window isn't ready to update. Wait for it to finish loading and try again.").to_string()),
                FlushStatus::Pending => {}
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(tr("Impossibile salvare tutte le finestre: aggiornamento annullato. Riprova tra poco.", "Couldn't save every window: update cancelled. Try again shortly.").to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flush_requires_fresh_successful_writes_from_every_live_window() {
        let mut inner = Inner::default();
        let live = vec!["main".into(), "other".into()];
        put_snapshot(&mut inner, "main", Some(serde_json::json!({ "tabs": [] })), Some(2), Some(false), |_, _| Ok(())).unwrap();
        assert_eq!(flush_status(&inner, &live, 2), FlushStatus::Pending);
        put_snapshot(&mut inner, "other", None, Some(1), Some(false), |_, _| Ok(())).unwrap();
        assert_eq!(flush_status(&inner, &live, 2), FlushStatus::Pending);
        put_snapshot(&mut inner, "other", None, Some(2), Some(false), |_, _| Ok(())).unwrap();
        assert_eq!(flush_status(&inner, &live, 2), FlushStatus::Ready);
        assert_eq!(flush_status(&inner, &["main".into(), "new-window".into()], 2), FlushStatus::Pending);
        assert_eq!(flush_status(&inner, &["main".into()], 2), FlushStatus::Ready);
    }

    #[test]
    fn a_failed_write_never_acknowledges_the_flush() {
        let mut inner = Inner::default();
        inner.acks.insert("main".into(), 1);
        let result = put_snapshot(&mut inner, "main", None, Some(2), Some(true), |_, _| Err("disk full".into()));
        assert_eq!(result, Err("disk full".into()));
        assert_eq!(inner.acks.get("main"), Some(&1));
        assert_eq!(inner.dirty_editors.get("main"), Some(&true));
        assert_eq!(flush_status(&inner, &["main".into()], 2), FlushStatus::Pending);
    }

    #[test]
    fn disabled_restore_still_reports_dirty_editors_and_missing_state_blocks_update() {
        let mut inner = Inner::default();
        let live = vec!["main".into()];
        put_snapshot(&mut inner, "main", None, Some(1), Some(true), |windows, _| {
            assert!(windows.is_none());
            Ok(())
        }).unwrap();
        assert_eq!(flush_status(&inner, &live, 1), FlushStatus::DirtyEditors);
        put_snapshot(&mut inner, "main", None, Some(2), None, |_, _| Ok(())).unwrap();
        assert_eq!(flush_status(&inner, &live, 2), FlushStatus::UnknownEditors);
        put_snapshot(&mut inner, "main", None, Some(3), Some(false), |_, _| Ok(())).unwrap();
        assert_eq!(flush_status(&inner, &live, 3), FlushStatus::Ready);
    }

    #[test]
    fn old_rounds_do_not_rewind_acknowledgements_and_closed_windows_forget_live_state() {
        let mut inner = Inner::default();
        let snapshot = serde_json::json!({ "tabs": [] });
        put_snapshot(&mut inner, "main", Some(snapshot.clone()), Some(3), Some(true), |_, _| Ok(())).unwrap();
        put_snapshot(&mut inner, "main", Some(snapshot), Some(2), Some(true), |_, _| Ok(())).unwrap();
        assert_eq!(inner.acks.get("main"), Some(&3));
        inner.forget_live_window("main");
        assert!(!inner.acks.contains_key("main"));
        assert!(!inner.dirty_editors.contains_key("main"));
        assert_eq!(inner.windows.len(), 1, "the last window's saved snapshot survives closing");
    }
}
