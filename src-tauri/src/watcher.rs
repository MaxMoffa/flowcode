//! Live folder watching for the file explorer: each window watches the one
//! folder its explorer is showing, and is told (`fs-changed`) when entries
//! are created, removed or renamed in it, so the listing follows the disk
//! without the user hitting refresh.

use fs_watch::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

/// How a window's folder is being followed. Dropping it stops the watching.
enum Watch {
    /// The OS's own change notifications.
    Native(#[allow(dead_code)] RecommendedWatcher),
    /// A thread reading the folder's modified time (see `poll`); the flag
    /// tells it to stop.
    Poll(Arc<AtomicBool>),
}

impl Drop for Watch {
    fn drop(&mut self) {
        if let Watch::Poll(stop) = self {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// One watch per window label.
#[derive(Default)]
pub struct DirWatchers(Mutex<HashMap<String, Watch>>);

impl DirWatchers {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Watch>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// A closed window's watcher goes with it.
    pub fn forget(&self, label: &str) {
        self.lock().remove(label);
    }
}

/// Only changes that alter the *listing* matter - content writes and
/// access/metadata events would just make the explorer reload for nothing.
fn changes_listing(kind: &EventKind) -> bool {
    use fs_watch::event::ModifyKind;
    matches!(kind, EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_)))
}

/// A WSL distro's files (`\\wsl$\Ubuntu\...`, `\\wsl.localhost\...`) are served
/// to Windows over a 9P share, which doesn't deliver change notifications
/// for what happens on the Linux side. The folder's modified time does move
/// on every create/delete/rename in it though, and reading it is a single
/// cheap call - so it is checked once a second instead.
fn is_network_path(path: &str) -> bool {
    path.starts_with("\\\\") || path.starts_with("//")
}

fn poll(app: AppHandle, label: String, path: String) -> Result<Watch, String> {
    let modified = |p: &str| std::fs::metadata(p).and_then(|m| m.modified());
    let mut last = modified(&path).map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    std::thread::spawn(move || {
        while !flag.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_secs(1));
            match modified(&path) {
                Ok(now) if now != last => {
                    last = now;
                    let _ = app.emit_to(label.as_str(), "fs-changed", path.as_str());
                }
                _ => {}
            }
        }
    });
    Ok(Watch::Poll(stop))
}

fn start(app: AppHandle, label: String, path: &str) -> Result<Watch, String> {
    if is_network_path(path) {
        return poll(app, label, path.to_string());
    }
    let watched = path.to_string();
    let mut watcher = fs_watch::recommended_watcher(move |res: fs_watch::Result<fs_watch::Event>| {
        if let Ok(event) = res {
            if changes_listing(&event.kind) {
                let _ = app.emit_to(label.as_str(), "fs-changed", watched.as_str());
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher.watch(Path::new(path), RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    Ok(Watch::Native(watcher))
}

/// Starts watching `path` for this window, replacing whatever it watched
/// before. Errors when the folder can't be watched (a network/WSL share, a
/// path that's gone) - the explorer then falls back to polling.
#[tauri::command]
pub fn watch_dir(app: AppHandle, window: WebviewWindow, state: State<'_, DirWatchers>, path: String) -> Result<(), String> {
    let label = window.label().to_string();
    state.forget(&label);
    let watcher = start(app, label.clone(), &path)?;
    state.lock().insert(label, watcher);
    Ok(())
}

#[tauri::command]
pub fn unwatch_dir(window: WebviewWindow, state: State<'_, DirWatchers>) {
    state.forget(window.label());
}
