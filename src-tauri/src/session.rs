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
    /// Window label -> latest `flush_all` round it has answered.
    acks: HashMap<String, u64>,
}

impl SessionStore {
    pub fn set_quitting(&self) {
        self.quitting.store(true, Ordering::SeqCst);
    }

    /// A window was destroyed: its part goes, unless it was the last one open
    /// (the app is quitting with it) or the app is exiting for an update.
    pub fn forget_window(&self, app: &AppHandle, label: &str) {
        let others_open = app.webview_windows().keys().any(|l| l != label);
        if self.quitting.load(Ordering::SeqCst) || !others_open {
            return;
        }
        let mut inner = self.inner.lock().unwrap();
        inner.acks.remove(label);
        let before = inner.windows.len();
        inner.windows.retain(|(l, _)| l != label);
        if inner.windows.len() != before {
            let _ = write(app, Some(&inner.windows));
        }
    }
}

fn write(app: &AppHandle, windows: Option<&[(String, Value)]>) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let contents = match windows {
        Some(windows) if !windows.is_empty() => {
            let mut ordered: Vec<&Value> = windows.iter().filter(|(l, _)| l == "main").map(|(_, v)| v).collect();
            ordered.extend(windows.iter().filter(|(l, _)| l != "main").map(|(_, v)| v));
            serde_json::json!({ "version": 2, "windows": ordered }).to_string()
        }
        _ => "{}".to_string(),
    };
    std::fs::write(dir.join("session.json"), contents).map_err(|e| e.to_string())
}

/// Stores the calling window's part of the session and rewrites the file.
/// `snapshot: None` means session restore is switched off: the whole file is
/// cleared instead. `flush_gen` answers a `session:flush` request.
#[tauri::command]
pub fn session_put(
    app: AppHandle,
    window: tauri::WebviewWindow,
    store: State<'_, SessionStore>,
    snapshot: Option<Value>,
    flush_gen: Option<u64>,
) -> Result<(), String> {
    let label = window.label().to_string();
    let mut inner = store.inner.lock().unwrap();
    if let Some(generation) = flush_gen {
        inner.acks.insert(label.clone(), generation);
    }
    match snapshot {
        None => {
            inner.windows.clear();
            write(&app, None)
        }
        Some(snapshot) => {
            match inner.windows.iter_mut().find(|(l, _)| *l == label) {
                Some(entry) => entry.1 = snapshot,
                None => inner.windows.push((label, snapshot)),
            }
            write(&app, Some(&inner.windows))
        }
    }
}

/// Asks every window to report its latest state now (`session:flush`) and
/// waits - briefly - for all of them to answer. Used right before the app
/// exits for an update, so the relaunched version restores everything as it
/// was a moment ago rather than as of the last periodic save.
pub async fn flush_all(app: &AppHandle) {
    let store = app.state::<SessionStore>();
    let generation = store.flush_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let labels: Vec<String> = app.webview_windows().keys().cloned().collect();
    let _ = app.emit("session:flush", generation);
    let app = app.clone();
    let _ = crate::blocking(move || {
        let store = app.state::<SessionStore>();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let done = {
                let inner = store.inner.lock().unwrap();
                labels.iter().all(|l| inner.acks.get(l).is_some_and(|g| *g >= generation))
            };
            if done {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    })
    .await;
}
