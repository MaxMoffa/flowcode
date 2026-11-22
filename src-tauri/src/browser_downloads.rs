//! Downloads of the in-app browser's native child webviews.
//!
//! wry's `on_download` is synchronous, so it cannot wait for the user's
//! answer. A requested download therefore starts at once, but into a private
//! folder (`<cache>/downloads-pending/<id>/<name>`); the user's answer (a bar
//! under the browser header) then moves the finished file to the Downloads
//! folder ("Scarica") or deletes it ("Annulla"). Nothing reaches Downloads
//! without consent. wry only reports "requested" and "finished" (no byte
//! counts), so progress is indeterminate and the size is known at the end.
//!
//! The list of items lives here (finished/failed ones are persisted, last 50);
//! the frontend (src/browser/BrowserDownloads.tsx) mirrors it through the
//! `browser-download` event and the `browser_download*` commands.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, EventTarget, Manager};

const KEEP: usize = 50;
const ASK_TTL: Duration = Duration::from_secs(120);

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub page_id: String,
    pub window: String,
    pub url: String,
    pub host: String,
    pub file_name: String,
    /// `asking` | `downloading` | `done` | `failed`; `cancelled` / `removed` are
    /// only ever emitted (the item is gone from the list).
    pub state: String,
    pub dangerous: bool,
    pub size: Option<u64>,
    /// Epoch milliseconds.
    pub started_at: u64,
    /// While `asking`: the file is already completely downloaded.
    #[serde(default)]
    pub finished: bool,
    /// Final path once `done`.
    #[serde(default)]
    pub path: Option<String>,
}

struct Entry {
    item: Item,
    /// Where the webview writes the file while it is pending.
    pending: PathBuf,
    /// The user said no / cancelled: delete the file when the webview is done with it.
    dropped: bool,
}

#[derive(Default)]
struct Store {
    loaded: bool,
    entries: Vec<Entry>,
}

static STORE: Mutex<Store> = Mutex::new(Store { loaded: false, entries: Vec::new() });
static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn emit(app: &AppHandle, window: &str, item: &Item) {
    let _ = app.emit_to(EventTarget::webview_window(window), "browser-download", item);
}

/// Emits the item with a terminal state so the frontend drops it.
fn emit_gone(app: &AppHandle, item: &Item, state: &str) {
    let mut gone = item.clone();
    gone.state = state.to_string();
    emit(app, &item.window, &gone);
}

fn pending_root(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("downloads-pending"))
}

fn store_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("browser-downloads.json"))
}

/// Startup: leftovers of a previous run are files nobody answered for.
pub fn purge_pending(app: &AppHandle) {
    if let Some(root) = pending_root(app) {
        let _ = std::fs::remove_dir_all(root);
    }
}

fn ensure_loaded(app: &AppHandle, store: &mut Store) {
    if store.loaded {
        return;
    }
    store.loaded = true;
    let Some(file) = store_file(app) else { return };
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let Ok(items) = serde_json::from_str::<Vec<Item>>(&text) else { return };
    for item in items.into_iter().filter(|i| i.state == "done" || i.state == "failed") {
        store.entries.push(Entry { item, pending: PathBuf::new(), dropped: false });
    }
}

fn persist(app: &AppHandle, store: &mut Store) {
    // Newest first; only finished/failed items, at most KEEP.
    let mut done: Vec<Item> =
        store.entries.iter().map(|e| e.item.clone()).filter(|i| i.state == "done" || i.state == "failed").collect();
    done.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    done.truncate(KEEP);
    let keep: Vec<String> = done.iter().map(|i| i.id.clone()).collect();
    store.entries.retain(|e| !(e.item.state == "done" || e.item.state == "failed") || keep.contains(&e.item.id));
    let Some(file) = store_file(app) else { return };
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&done) {
        let _ = std::fs::write(file, text);
    }
}

// ---------------------------------------------------------------- file names

/// A name safe to create: no path separators or control characters, no
/// characters Windows forbids, no trailing dot/space, no reserved device name.
/// Empty input falls back to `fallback`.
pub(crate) fn sanitize_file_name(raw: &str, fallback: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c })
        .collect();
    let mut name = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if name.chars().all(|c| c == '_' || c == '.' || c == ' ') {
        name.clear();
    }
    if name.is_empty() {
        return if fallback.is_empty() || fallback == raw { "download".into() } else { sanitize_file_name(fallback, "") };
    }
    if name.chars().count() > 120 {
        // Keep the extension when cutting.
        let (stem, ext) = split_ext(&name);
        let ext: String = ext.chars().take(16).collect();
        let keep = 120usize.saturating_sub(ext.chars().count());
        name = format!("{}{}", stem.chars().take(keep).collect::<String>(), ext);
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || ((stem.len() == 4) && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        name.insert(0, '_');
    }
    name
}

/// Last path segment of a URL, percent-decoded, for when the webview gave no name.
fn name_from_url(url: &str) -> String {
    let Ok(u) = url.parse::<tauri::Url>() else { return String::new() };
    let seg = u.path_segments().and_then(|mut s| s.next_back()).unwrap_or("");
    percent_decode(seg)
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// (`stem`, `.ext`) with `.tar.gz`-style double extensions kept together.
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => {
            let (stem, ext) = name.split_at(i);
            if stem.to_ascii_lowercase().ends_with(".tar") && stem.len() > 4 {
                let j = stem.len() - 4;
                (&name[..j], &name[j..])
            } else {
                (stem, ext)
            }
        }
        _ => (name, ""),
    }
}

/// `dir/name`, or `dir/stem (1).ext`, `(2)`... the first one `exists` denies.
pub(crate) fn unique_path(dir: &Path, name: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(name);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = split_ext(name);
    for n in 1..10_000 {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !exists(&p) {
            return p;
        }
    }
    dir.join(format!("{stem} ({}){ext}", now_ms()))
}

fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

fn remove_pending(pending: &Path) {
    let _ = std::fs::remove_file(pending);
    if let Some(dir) = pending.parent() {
        // Only the per-download folder (`downloads-pending/<id>`), never deeper or higher.
        if dir.parent().and_then(|p| p.file_name()).is_some_and(|n| n == "downloads-pending") {
            let _ = std::fs::remove_dir(dir);
        }
    }
}

// ------------------------------------------------------------ wry callbacks

/// `Requested`: the webview is about to download `url`; redirect it to the pending folder.
pub fn on_requested(app: &AppHandle, window: &str, page_id: &str, url: &str, destination: &mut PathBuf) {
    let Some(root) = pending_root(app) else { return };
    let id = format!("dl{}-{}", now_ms(), COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
    let asked = destination.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let file_name = sanitize_file_name(&asked, &name_from_url(url));
    let dir = root.join(&id);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let pending = dir.join(&file_name);
    *destination = pending.clone();
    let host = url.parse::<tauri::Url>().ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let item = Item {
        id: id.clone(),
        page_id: page_id.to_string(),
        window: window.to_string(),
        url: url.to_string(),
        host,
        dangerous: crate::system::is_executable_name(&file_name),
        file_name,
        state: "asking".into(),
        size: None,
        started_at: now_ms(),
        finished: false,
        path: None,
    };
    {
        let mut st = lock(&STORE);
        ensure_loaded(app, &mut st);
        st.entries.push(Entry { item: item.clone(), pending, dropped: false });
    }
    emit(app, window, &item);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ASK_TTL).await;
        let still_asking = lock(&STORE).entries.iter().any(|e| e.item.id == id && e.item.state == "asking");
        if still_asking {
            let _ = answer(&app, &id, false, "expired");
        }
    });
}

/// `Finished`: the webview is done (or gave up) writing the pending file.
pub fn on_finished(app: &AppHandle, url: &str, path: Option<PathBuf>, success: bool) {
    let mut st = lock(&STORE);
    let idx = st.entries.iter().position(|e| {
        let active = e.item.state == "asking" && !e.item.finished || e.item.state == "downloading";
        (active || e.dropped) && !e.pending.as_os_str().is_empty() && (path.as_deref() == Some(e.pending.as_path()) || (path.is_none() && e.item.url == url))
    });
    let Some(i) = idx else { return };
    if st.entries[i].dropped {
        let e = st.entries.remove(i);
        drop(st);
        remove_pending(&e.pending);
        return;
    }
    if !success {
        let e = &mut st.entries[i];
        e.item.state = "failed".into();
        e.item.finished = true;
        let (item, pending) = (e.item.clone(), e.pending.clone());
        persist(app, &mut st);
        drop(st);
        remove_pending(&pending);
        emit(app, &item.window, &item);
        return;
    }
    let size = std::fs::metadata(&st.entries[i].pending).ok().map(|m| m.len());
    st.entries[i].item.size = size;
    st.entries[i].item.finished = true;
    if st.entries[i].item.state == "downloading" {
        // Accepted while it was still downloading.
        let id = st.entries[i].item.id.clone();
        drop(st);
        finalize(app, &id);
    } else {
        let item = st.entries[i].item.clone();
        drop(st);
        emit(app, &item.window, &item);
    }
}

/// Moves an accepted, completely downloaded file to the Downloads folder.
fn finalize(app: &AppHandle, id: &str) {
    let (pending, name) = {
        let st = lock(&STORE);
        match st.entries.iter().find(|e| e.item.id == id) {
            Some(e) => (e.pending.clone(), e.item.file_name.clone()),
            None => return,
        }
    };
    let result = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())
        .and_then(|dir| {
            let _ = std::fs::create_dir_all(&dir);
            let to = unique_path(&dir, &name, |p| p.exists());
            move_file(&pending, &to).map(|_| to).map_err(|e| e.to_string())
        });
    let mut st = lock(&STORE);
    let Some(e) = st.entries.iter_mut().find(|e| e.item.id == id) else { return };
    match result {
        Ok(path) => {
            e.item.state = "done".into();
            e.item.size = std::fs::metadata(&path).ok().map(|m| m.len()).or(e.item.size);
            e.item.file_name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(name);
            e.item.path = Some(path.to_string_lossy().into_owned());
        }
        Err(_) => e.item.state = "failed".into(),
    }
    let item = e.item.clone();
    persist(app, &mut st);
    drop(st);
    remove_pending(&pending);
    emit(app, &item.window, &item);
}

/// The user's answer (or the expiry: `gone_state` is what the frontend is told on rejection).
fn answer(app: &AppHandle, id: &str, accept: bool, gone_state: &str) -> Result<(), String> {
    let mut st = lock(&STORE);
    let i = st
        .entries
        .iter()
        .position(|e| e.item.id == id && e.item.state == "asking")
        .ok_or("download is not waiting for an answer")?;
    if accept {
        st.entries[i].item.state = "downloading".into();
        let finished = st.entries[i].item.finished;
        let item = st.entries[i].item.clone();
        drop(st);
        if finished {
            finalize(app, id);
        } else {
            emit(app, &item.window, &item);
        }
        return Ok(());
    }
    if st.entries[i].item.finished {
        let e = st.entries.remove(i);
        drop(st);
        remove_pending(&e.pending);
        emit_gone(app, &e.item, gone_state);
    } else {
        st.entries[i].dropped = true;
        let item = st.entries[i].item.clone();
        drop(st);
        emit_gone(app, &item, gone_state);
    }
    Ok(())
}

// ----------------------------------------------------------------- commands

fn sorted(entries: &[Entry], window: &str) -> Vec<Item> {
    let mut v: Vec<Item> = entries
        .iter()
        .filter(|e| !e.dropped)
        .filter(|e| e.item.state == "done" || e.item.state == "failed" || e.item.window == window)
        .map(|e| e.item.clone())
        .collect();
    v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    v
}

#[tauri::command]
pub fn browser_downloads_list(app: AppHandle, window: tauri::Window) -> Vec<Item> {
    let mut st = lock(&STORE);
    ensure_loaded(&app, &mut st);
    sorted(&st.entries, window.label())
}

#[tauri::command]
pub fn browser_download_answer(app: AppHandle, id: String, accept: bool) -> Result<(), String> {
    answer(&app, &id, accept, "removed")
}

#[tauri::command]
pub fn browser_download_cancel(app: AppHandle, id: String) -> Result<(), String> {
    let mut st = lock(&STORE);
    let i = st
        .entries
        .iter()
        .position(|e| e.item.id == id && (e.item.state == "downloading" || e.item.state == "asking"))
        .ok_or("download is not in progress")?;
    if st.entries[i].item.finished {
        let e = st.entries.remove(i);
        drop(st);
        remove_pending(&e.pending);
        emit_gone(&app, &e.item, "cancelled");
    } else {
        st.entries[i].dropped = true;
        let item = st.entries[i].item.clone();
        drop(st);
        emit_gone(&app, &item, "cancelled");
    }
    Ok(())
}

fn done_item(id: &str) -> Result<Item, String> {
    lock(&STORE)
        .entries
        .iter()
        .find(|e| e.item.id == id && e.item.state == "done")
        .map(|e| e.item.clone())
        .ok_or_else(|| "download not found".to_string())
}

#[tauri::command]
pub fn browser_download_open(id: String) -> Result<(), String> {
    let item = done_item(&id)?;
    if item.dangerous {
        return Err("dangerous files are not opened".into());
    }
    // Re-checks the real path (extension, links, exec bit) before opening.
    crate::system::open_with_default_app(item.path.ok_or("no path")?)
}

fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if path.exists() {
            return std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", path.display()))
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
    }
    #[cfg(target_os = "macos")]
    {
        if path.exists() {
            return std::process::Command::new("open").arg("-R").arg(path).spawn().map(|_| ()).map_err(|e| e.to_string());
        }
    }
    let dir = if path.is_dir() { path } else { path.parent().ok_or("no folder")? };
    tauri_plugin_opener::open_path(dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_download_reveal(id: String) -> Result<(), String> {
    let item = done_item(&id)?;
    reveal_path(Path::new(&item.path.ok_or("no path")?))
}

/// "Apri cartella": the user's Downloads folder.
#[tauri::command]
pub fn browser_downloads_open_folder(app: AppHandle) -> Result<(), String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    reveal_path(&dir)
}

/// Drops a finished or failed item from the list; the downloaded file stays.
#[tauri::command]
pub fn browser_download_remove(app: AppHandle, id: String) -> Result<(), String> {
    let mut st = lock(&STORE);
    let i = st
        .entries
        .iter()
        .position(|e| e.item.id == id && (e.item.state == "done" || e.item.state == "failed"))
        .ok_or("download not found")?;
    let e = st.entries.remove(i);
    persist(&app, &mut st);
    drop(st);
    emit_gone(&app, &e.item, "removed");
    Ok(())
}

/// Empties the list of everything that is not active; downloaded files stay.
#[tauri::command]
pub fn browser_downloads_clear(app: AppHandle) {
    let mut st = lock(&STORE);
    ensure_loaded(&app, &mut st);
    let mut gone = Vec::new();
    st.entries.retain(|e| {
        let finished = e.item.state == "done" || e.item.state == "failed";
        if finished {
            gone.push(e.item.clone());
        }
        !finished
    });
    persist(&app, &mut st);
    drop(st);
    for item in gone {
        emit_gone(&app, &item, "removed");
    }
}

/// Asks the item's page to download its URL again (an `<a download>` click).
#[tauri::command]
pub fn browser_download_retry(app: AppHandle, id: String) -> Result<(), String> {
    let item = lock(&STORE)
        .entries
        .iter()
        .find(|e| e.item.id == id && e.item.state == "failed")
        .map(|e| e.item.clone())
        .ok_or("download not found")?;
    // Only a web address is clicked again: never a javascript:/data: link run in the page.
    let lower = item.url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("this download can't be retried".into());
    }
    let url = serde_json::to_string(&item.url).map_err(|e| e.to_string())?;
    let js = format!(
        "(()=>{{const a=document.createElement('a');a.href={url};a.download='';a.style.display='none';document.body.appendChild(a);a.click();a.remove();}})()"
    );
    crate::browser_view::eval_in_page(&app, &item.window, &item.page_id, &js)
        .map_err(|_| "the page this file came from is closed".to_string())?;
    browser_download_remove(app, id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_names() {
        assert_eq!(sanitize_file_name("a/b\\c.zip", ""), "a_b_c.zip");
        assert_eq!(sanitize_file_name("..\\..\\evil.exe", ""), ".._.._evil.exe");
        assert_eq!(sanitize_file_name("rep\u{0}ort\n.pdf", ""), "rep_ort_.pdf");
        assert_eq!(sanitize_file_name("name.", ""), "name");
        assert_eq!(sanitize_file_name("   ", "from-url.zip"), "from-url.zip");
        assert_eq!(sanitize_file_name("", ""), "download");
        assert_eq!(sanitize_file_name("???", ""), "download");
        assert_eq!(sanitize_file_name("CON.txt", ""), "_CON.txt");
        assert_eq!(sanitize_file_name("com1", ""), "_com1");
        assert_eq!(sanitize_file_name("a:b.txt", ""), "a_b.txt");
        let long = format!("{}.tar.gz", "x".repeat(300));
        let out = sanitize_file_name(&long, "");
        assert!(out.chars().count() <= 120 && out.ends_with(".gz"));
    }

    #[test]
    fn url_names_decode() {
        assert_eq!(name_from_url("https://a.example/x/my%20file.zip?q=1"), "my file.zip");
        assert_eq!(name_from_url("https://a.example/"), "");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz%41"), "%zzA");
    }

    #[test]
    fn unique_names() {
        let dir = Path::new("d");
        let taken = |names: &'static [&'static str]| move |p: &Path| names.iter().any(|n| p == dir.join(n));
        assert_eq!(unique_path(dir, "a.zip", taken(&[])), dir.join("a.zip"));
        assert_eq!(unique_path(dir, "a.zip", taken(&["a.zip"])), dir.join("a (1).zip"));
        assert_eq!(unique_path(dir, "a.zip", taken(&["a.zip", "a (1).zip"])), dir.join("a (2).zip"));
        assert_eq!(unique_path(dir, "a.tar.gz", taken(&["a.tar.gz"])), dir.join("a (1).tar.gz"));
        assert_eq!(unique_path(dir, "noext", taken(&["noext"])), dir.join("noext (1)"));
        assert_eq!(unique_path(dir, ".hidden", taken(&[".hidden"])), dir.join(".hidden (1)"));
    }

    #[test]
    fn dangerous_names() {
        assert!(crate::system::is_executable_name("setup.exe"));
        assert!(crate::system::is_executable_name("run.BAT"));
        assert!(!crate::system::is_executable_name("report.pdf"));
        assert!(!crate::system::is_executable_name("pics.zip"));
    }
}
