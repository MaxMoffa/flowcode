use flowcode_shared::i18n::{is_italian, tr};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::blocking;

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

impl FsEntry {
    fn new(path: &Path, is_dir: bool) -> Self {
        FsEntry {
            name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            is_dir,
        }
    }
}

/// Folders first, then case-insensitive by name - the order every listing
/// (plain and search) is shown in.
fn sort_entries(entries: &mut [FsEntry]) {
    entries.sort_by_cached_key(|e| (!e.is_dir, e.name.to_lowercase()));
}

fn already_exists() -> String {
    tr("Esiste già un file o una cartella con questo nome", "A file or folder with this name already exists").to_string()
}

/// A name coming from the UI must name exactly one entry inside the target
/// directory - never a path that escapes it.
fn validate_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed.contains(['/', '\\']) {
        return Err(if is_italian() { format!("Nome non valido: \"{name}\"") } else { format!("Invalid name: \"{name}\"") });
    }
    Ok(trimmed)
}

fn map_exists_error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::AlreadyExists => already_exists(),
        _ => e.to_string(),
    }
}

/// `$HOME`, falling back to `%USERPROFILE%` (Windows has no `HOME` unless a
/// POSIX layer like Git Bash set one).
pub(crate) fn user_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

/// Cheap existence check - used by App.tsx's `handleTitleChange` to verify a
/// candidate "we're back on a real shell prompt" path while a tab has a
/// nested session (WSL, remote, Claude Code/Codex) before trusting it: that
/// session's own console-title noise isn't reliably distinguishable from a
/// real post-exit prompt by shape alone, so this asks the filesystem instead
/// of guessing.
///
/// Every command below that touches the filesystem is `async` (or
/// `#[tauri::command(async)]`): a plain sync command runs on the main thread,
/// and a WSL UNC path (`\\wsl.localhost\...`) or a big folder can take a
/// noticeable time to answer - long enough to freeze the whole window.
#[tauri::command]
pub async fn is_directory(path: String) -> bool {
    blocking(move || Ok(Path::new(&path).is_dir())).await.unwrap_or(false)
}

#[tauri::command]
pub async fn read_dir(path: String, show_hidden: Option<bool>) -> Result<Vec<FsEntry>, String> {
    blocking(move || {
        let show_hidden = show_hidden.unwrap_or(false);
        let mut entries: Vec<FsEntry> = std::fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .filter_map(|entry| entry.ok())
            .filter(|entry| show_hidden || !entry.file_name().to_string_lossy().starts_with('.'))
            .map(|entry| {
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                FsEntry::new(&entry.path(), is_dir)
            })
            .collect();
        sort_entries(&mut entries);
        Ok(entries)
    })
    .await
}

/// Never worth descending into for a name search - huge, machine-generated,
/// and would otherwise dominate the (capped) result list with noise.
const SEARCH_IGNORE_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", "build", ".next", ".venv", "__pycache__"];
const SEARCH_MAX_RESULTS: usize = 300;

/// A walk gives up after this long, however big the tree.
const SEARCH_DEADLINE: std::time::Duration = std::time::Duration::from_secs(3);
/// The newest search each window has asked for (by label; the frontend's
/// counter is per webview): an older walk of the same window sees it move on
/// and stops (one is started per keystroke). Other windows don't interfere.
static SEARCH_GENERATIONS: std::sync::Mutex<Option<std::collections::HashMap<String, u64>>> =
    std::sync::Mutex::new(None);

struct SearchWalk<'a> {
    query: &'a str,
    show_hidden: bool,
    label: String,
    generation: u64,
    deadline: std::time::Instant,
}

impl SearchWalk<'_> {
    fn stopped(&self) -> bool {
        let newer = SEARCH_GENERATIONS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|m| m.get(&self.label))
            .is_some_and(|&latest| latest > self.generation);
        newer || std::time::Instant::now() >= self.deadline
    }
}

fn search_dir_recursive(dir: &Path, walk: &SearchWalk, results: &mut Vec<FsEntry>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.filter_map(|e| e.ok()) {
        if results.len() >= SEARCH_MAX_RESULTS || walk.stopped() {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !walk.show_hidden && name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && SEARCH_IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        if name.to_lowercase().contains(walk.query) {
            results.push(FsEntry::new(&path, is_dir));
        }
        if is_dir {
            search_dir_recursive(&path, walk, results);
        }
    }
}

/// Recursive name search from `path` downward - unlike `read_dir`, which
/// only ever lists one directory. Skips `SEARCH_IGNORE_DIRS` and (unless
/// `show_hidden`) dotfiles, and stops at `SEARCH_MAX_RESULTS` matches so a
/// broad query over a big tree can't run forever. `generation` counts the
/// frontend's searches up: a walk stops once a newer one has been asked for,
/// and in any case after `SEARCH_DEADLINE`.
#[tauri::command]
pub async fn search_dir(
    path: String,
    query: String,
    show_hidden: Option<bool>,
    generation: u64,
    window: tauri::WebviewWindow,
) -> Result<Vec<FsEntry>, String> {
    let label = window.label().to_string();
    {
        let mut map = SEARCH_GENERATIONS.lock().unwrap_or_else(|e| e.into_inner());
        let latest = map.get_or_insert_with(Default::default).entry(label.clone()).or_insert(0);
        *latest = (*latest).max(generation);
    }
    blocking(move || {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        let walk = SearchWalk {
            query: &query,
            show_hidden: show_hidden.unwrap_or(false),
            label,
            generation,
            deadline: std::time::Instant::now() + SEARCH_DEADLINE,
        };
        search_dir_recursive(Path::new(&path), &walk, &mut results);
        sort_entries(&mut results);
        Ok(results)
    })
    .await
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    user_home()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "could not resolve home directory".to_string())
}

/// The installer's "Integrazioni" picks (plugin ids), if it left any - read
/// once and deleted, so a later launch never re-applies them over whatever
/// the user has changed since. `None` when there's no file: a Flowcode that
/// wasn't set up by the installer (dev builds, older installs).
#[tauri::command]
pub fn take_installer_features(app: AppHandle) -> Option<Vec<String>> {
    let path = app.path().app_config_dir().ok()?.join("installer-features.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(
        parsed["features"]
            .as_array()?
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
    )
}

/// Per-OS app config directory (same root `overrides_path` and `plugins_dir`
/// write into) - exposed so Settings → Informazioni can open it directly in
/// the OS file manager. Created on demand: on a brand-new install nothing
/// may have written here yet, and opening a path that doesn't exist would
/// just fail silently.
#[tauri::command]
pub fn config_dir(app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Bundled defaults live in `config/shortcuts.json` at the repo root. In dev
/// we read it straight off disk; in a packaged build it ships as a resource.
fn defaults_path(app: &AppHandle) -> Option<PathBuf> {
    let dev_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../config/shortcuts.json");
    if dev_path.exists() {
        return Some(dev_path);
    }
    app.path()
        .resolve("config/shortcuts.json", tauri::path::BaseDirectory::Resource)
        .ok()
}

/// User overrides are stored per-OS in the app config dir so they survive
/// updates and never require write access to the install directory.
fn overrides_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("shortcuts.json"))
}

#[tauri::command]
pub fn read_shortcuts_defaults(app: AppHandle) -> Result<String, String> {
    let path = defaults_path(&app).ok_or("bundled shortcuts.json not found")?;
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_shortcuts_overrides(app: AppHandle) -> Result<String, String> {
    let path = overrides_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => Ok(contents),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_shortcuts_overrides(app: AppHandle, contents: String) -> Result<(), String> {
    let path = overrides_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, contents.as_bytes()).map_err(|e| e.to_string())
}

/// Writes `bytes` to a sibling temp file and renames it over `path`, so a
/// crash or a full disk mid-write leaves the old contents instead of a
/// truncated file. `rename` replaces an existing file on Windows too. The
/// original's permissions are kept on Unix (the temp file would otherwise come
/// out with the default mode). A symlink is written through (its target is
/// replaced, the link stays), and the temp name is unique per call so
/// concurrent saves of one file can't share it.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let target;
    let path = if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        // A dangling link can't be resolved: write at the link's own path.
        match std::fs::canonicalize(path) {
            Ok(t) => {
                target = t;
                target.as_path()
            }
            Err(_) => path,
        }
    } else {
        path
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let unique = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_file_name(format!("{name}.tmp-{}-{unique}", std::process::id()));
    let result = (|| {
        std::fs::write(&tmp, bytes)?;
        #[cfg(unix)]
        if let Ok(meta) = std::fs::metadata(path) {
            let _ = std::fs::set_permissions(&tmp, meta.permissions());
        }
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[tauri::command(async)]
pub fn create_file_entry(dir: String, name: String) -> Result<FsEntry, String> {
    let path = Path::new(&dir).join(validate_name(&name)?);
    // `create_new` fails atomically if the name is taken - no exists()/create
    // race that could truncate a file created in between.
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(map_exists_error)?;
    Ok(FsEntry::new(&path, false))
}

#[tauri::command(async)]
pub fn create_dir_entry(dir: String, name: String) -> Result<FsEntry, String> {
    let path = Path::new(&dir).join(validate_name(&name)?);
    std::fs::create_dir(&path).map_err(map_exists_error)?;
    Ok(FsEntry::new(&path, true))
}

#[tauri::command(async)]
pub fn rename_entry(path: String, new_name: String) -> Result<FsEntry, String> {
    let src = Path::new(&path);
    let parent = src.parent().ok_or("cannot rename the root directory")?;
    let dest = parent.join(validate_name(&new_name)?);
    // A case-only rename ("readme.md" -> "README.md") points at the same
    // entry on a case-insensitive filesystem, where `exists()` would wrongly
    // refuse it.
    let case_only = dest.to_string_lossy().eq_ignore_ascii_case(&src.to_string_lossy());
    if !case_only && dest.exists() {
        return Err(already_exists());
    }
    std::fs::rename(src, &dest).map_err(|e| e.to_string())?;
    Ok(FsEntry::new(&dest, dest.is_dir()))
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dest.join(entry.file_name());
        // `file_type()` doesn't follow symlinks: resolve them with `metadata`
        // so a symlinked folder is copied as a folder, not handed to `fs::copy`.
        let file_type = entry.file_type()?;
        let is_dir = if file_type.is_symlink() { std::fs::metadata(entry.path())?.is_dir() } else { file_type.is_dir() };
        if is_dir {
            copy_dir_recursive(&entry.path(), &dest_path)?;
        } else {
            std::fs::copy(entry.path(), &dest_path)?;
        }
    }
    Ok(())
}

/// Picks "name copy.ext", then "name copy 2.ext", "name copy 3.ext", ... in `parent`.
fn unique_copy_path(parent: &Path, stem: &str, ext: Option<&str>) -> PathBuf {
    let suffixed = |label: String| match ext {
        Some(ext) => parent.join(format!("{label}.{ext}")),
        None => parent.join(label),
    };
    let mut candidate = suffixed(format!("{stem} copy"));
    let mut n = 2;
    while candidate.exists() {
        candidate = suffixed(format!("{stem} copy {n}"));
        n += 1;
    }
    candidate
}

#[tauri::command]
pub async fn duplicate_entry(path: String) -> Result<FsEntry, String> {
    blocking(move || {
        let src = Path::new(&path);
        let parent = src.parent().ok_or("cannot duplicate the root directory")?;
        if src.is_dir() {
            let stem = src.file_name().and_then(|n| n.to_str()).unwrap_or("folder");
            let dest = unique_copy_path(parent, stem, None);
            copy_dir_recursive(src, &dest).map_err(|e| e.to_string())?;
            Ok(FsEntry::new(&dest, true))
        } else {
            let stem = src.file_stem().and_then(|n| n.to_str()).unwrap_or("file");
            let ext = src.extension().and_then(|n| n.to_str());
            let dest = unique_copy_path(parent, stem, ext);
            std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
            Ok(FsEntry::new(&dest, false))
        }
    })
    .await
}

/// Largest file the editor opens: it holds the whole text in memory (and
/// ships it over IPC), so a multi-hundred-MB log would freeze it.
const EDITOR_MAX_BYTES: u64 = 20 * 1024 * 1024;
/// How much of a file `path_kind` reads to tell text from binary.
const TEXT_SNIFF_BYTES: usize = 8 * 1024;
/// Longest path a clicked chat/terminal link may name.
const LINK_PATH_MAX: usize = 4096;

#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<String, String> {
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > EDITOR_MAX_BYTES) {
        return Err(tr(
            "File troppo grande da aprire nell'editor (oltre 20 MB).",
            "File too large to open in the editor (over 20 MB).",
        )
        .to_string());
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    write_atomic(Path::new(&path), contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_entry(app: AppHandle, path: String, is_dir: bool) -> Result<(), String> {
    let config = app.path().app_config_dir().ok();
    blocking(move || {
        let target = Path::new(&path);
        // A recursive delete one mis-click away from wiping a drive, the home
        // folder or the app's own settings is never what the user meant.
        let same = |other: &Path| match (std::fs::canonicalize(target), std::fs::canonicalize(other)) {
            (Ok(a), Ok(b)) => a == b,
            _ => target == other,
        };
        let protected = target.parent().is_none()
            || user_home().is_some_and(|h| same(&h))
            || config.as_deref().is_some_and(same);
        if protected {
            return Err(tr(
                "Per sicurezza Flowcode non elimina questa cartella.",
                "For safety Flowcode won't delete this folder.",
            )
            .to_string());
        }
        let result = if is_dir { std::fs::remove_dir_all(target) } else { std::fs::remove_file(target) };
        result.map_err(|e| e.to_string())
    })
    .await
}

#[derive(Serialize)]
pub struct FileInfo {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// Immediate children count, directories only.
    entry_count: Option<u32>,
    /// Unix milliseconds, when the filesystem exposes it.
    modified: Option<u64>,
    created: Option<u64>,
    /// Octal string (e.g. "755"), Unix only.
    permissions_mode: Option<String>,
    readonly: bool,
}

pub(crate) fn system_time_to_millis(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

#[tauri::command(async)]
pub fn get_file_info(path: String) -> Result<FileInfo, String> {
    let target = Path::new(&path);
    let meta = std::fs::metadata(target).map_err(|e| e.to_string())?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());
    let is_dir = meta.is_dir();

    let entry_count = if is_dir {
        std::fs::read_dir(target).ok().map(|rd| rd.count() as u32)
    } else {
        None
    };

    #[cfg(unix)]
    let permissions_mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(format!("{:o}", meta.permissions().mode() & 0o777))
    };
    #[cfg(not(unix))]
    let permissions_mode: Option<String> = None;

    Ok(FileInfo {
        name,
        path,
        is_dir,
        size: meta.len(),
        entry_count,
        modified: system_time_to_millis(meta.modified()),
        created: system_time_to_millis(meta.created()),
        permissions_mode,
        readonly: meta.permissions().readonly(),
    })
}

/// What a file path written in the chat or printed in a terminal points at -
/// see `path_kind`.
#[derive(Serialize, Debug, PartialEq)]
pub struct PathTarget {
    /// Absolute and lexically normalized (`.`/`..` folded; not canonicalized,
    /// so no `\\?\` prefix and symlinks kept as written).
    path: String,
    /// `"file"` or `"dir"`.
    kind: &'static str,
    /// A file the built-in editor can open: at most `EDITOR_MAX_BYTES`, and
    /// its first `TEXT_SNIFF_BYTES` look like UTF-8 text (`looks_like_text`).
    text: bool,
}

/// Whether the first bytes of a file are what `read_to_string` will accept:
/// no NUL byte and valid UTF-8 (a BOM is valid UTF-8 too). `truncated` = the
/// file goes on past `head`, so a multi-byte sequence cut at its end is fine.
fn looks_like_text(head: &[u8], truncated: bool) -> bool {
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        // `error_len() == None`: the bytes stop mid-sequence rather than being invalid.
        Err(e) => truncated && e.error_len().is_none(),
    }
}

/// `.` and `..` folded away without touching the disk (a `..` never climbs
/// above the root/prefix).
fn normalize_lexically(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(out.components().next_back(), Some(Component::Normal(_))) {
                    out.pop();
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path` as an absolute path: `~` expanded, a relative one joined onto
/// `cwd` (which must itself be absolute). `None` for an empty or oversized
/// path, a NUL byte, or a relative path with no usable cwd.
fn resolve_link_path(path: &str, cwd: Option<&str>) -> Option<PathBuf> {
    if path.is_empty() || path.len() > LINK_PATH_MAX || path.contains('\0') {
        return None;
    }
    let p = if path == "~" {
        user_home()?
    } else if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        user_home()?.join(rest)
    } else {
        PathBuf::from(path)
    };
    let full = if p.is_absolute() {
        p
    } else {
        let base = Path::new(cwd.map(str::trim).filter(|c| !c.contains('\0'))?);
        if !base.is_absolute() {
            return None;
        }
        let joined = base.join(p);
        // `D:x` (drive-relative) replaces the cwd outright when joined: a
        // "relative" link must stay on the cwd's own drive/share.
        if path_prefix(&joined) != path_prefix(base) {
            return None;
        }
        joined
    };
    Some(normalize_lexically(&full))
}

/// The `C:` / `\\server\share` part of a path, `None` without one (any path
/// off Windows).
fn path_prefix(path: &Path) -> Option<std::path::PrefixComponent<'_>> {
    match path.components().next() {
        Some(std::path::Component::Prefix(p)) => Some(p),
        _ => None,
    }
}

/// `\\wsl.localhost\<distro>` and `\\wsl$\<distro>`: the only UNC shares
/// Flowcode touches by itself (served locally by WSL, no network login).
fn is_wsl_server(server: &std::ffi::OsStr) -> bool {
    server.eq_ignore_ascii_case("wsl.localhost") || server.eq_ignore_ascii_case("wsl$")
}

/// Whether merely stat'ing/opening `path` stays on this machine: a plain
/// drive path or a WSL share. Any other UNC path makes Windows authenticate
/// to that server (leaking the user's NTLM hash - `\\host@SSL@443\x` even
/// over HTTPS/WebDAV), and `\\.\` / `\\?\GLOBALROOT` reach devices and named
/// pipes. `verbatim` lets `\\?\C:\` / `\\?\UNC\wsl.localhost\` through: what
/// `canonicalize` and junction targets look like, never what a link written
/// in text should be.
pub(crate) fn is_local_path(path: &Path, verbatim: bool) -> bool {
    use std::path::Prefix;
    let Some(prefix) = path_prefix(path) else { return true };
    match prefix.kind() {
        Prefix::Disk(_) => true,
        Prefix::UNC(server, _) => is_wsl_server(server),
        Prefix::VerbatimDisk(_) => verbatim,
        Prefix::VerbatimUNC(server, _) => verbatim && is_wsl_server(server),
        Prefix::DeviceNS(_) | Prefix::Verbatim(_) => false,
    }
}

/// How many links `links_stay_local` follows in all (a chain, or links
/// found inside other links' targets) before giving up and refusing: a
/// planted maze of links must not turn one hover into millions of stats.
const LINK_HOPS: u8 = 16;

pub(crate) fn links_stay_local(path: &Path) -> bool {
    let mut hops = LINK_HOPS;
    links_stay_local_within(path, &mut hops)
}

fn links_stay_local_within(path: &Path, hops: &mut u8) -> bool {
    use std::path::Component;
    if !is_local_path(path, true) {
        return false;
    }
    let mut cur = PathBuf::new();
    for c in path.components() {
        cur.push(c.as_os_str());
        if !matches!(c, Component::Normal(_)) {
            continue;
        }
        let meta = match std::fs::symlink_metadata(&cur) {
            Ok(m) => m,
            // Nothing further exists: whatever stat comes next fails anyway.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
            Err(_) => return false,
        };
        if meta.file_type().is_symlink() {
            if *hops == 0 {
                return false;
            }
            *hops -= 1;
            let Ok(target) = std::fs::read_link(&cur) else { return false };
            let target = match cur.parent() {
                Some(parent) if !target.is_absolute() => parent.join(target),
                _ => target,
            };
            if !links_stay_local_within(&normalize_lexically(&target), hops) {
                return false;
            }
        }
    }
    true
}

fn stat_link_path(path: &str, cwd: Option<&str>) -> Option<PathTarget> {
    use std::io::Read;
    let full = resolve_link_path(path, cwd)?;
    if !is_local_path(&full, false) || !links_stay_local(&full) {
        return None;
    }
    // A plain stat (plus an 8 KB read of a file): no globbing, nothing run.
    let meta = std::fs::metadata(&full).ok()?;
    let (kind, text) = if meta.is_dir() {
        ("dir", false)
    } else if meta.is_file() {
        let text = meta.len() <= EDITOR_MAX_BYTES
            && std::fs::File::open(&full).is_ok_and(|f| {
                let mut head = Vec::with_capacity(TEXT_SNIFF_BYTES);
                f.take(TEXT_SNIFF_BYTES as u64).read_to_end(&mut head).is_ok()
                    && looks_like_text(&head, meta.len() > head.len() as u64)
            });
        ("file", text)
    } else {
        return None;
    };
    Some(PathTarget { path: full.to_string_lossy().into_owned(), kind, text })
}

/// What a path the chat or a terminal shows points at, so it can be offered
/// as a link: `None` when it doesn't exist (or is neither a file nor a
/// folder). A relative path resolves against `cwd`.
#[tauri::command]
pub async fn path_kind(path: String, cwd: Option<String>) -> Option<PathTarget> {
    blocking(move || Ok(stat_link_path(&path, cwd.as_deref()))).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_sniff() {
        assert!(looks_like_text(b"", false), "empty file");
        assert!(looks_like_text(b"fn main() {}\n", false));
        assert!(looks_like_text("caff\u{e8} \u{1f600}".as_bytes(), false));
        assert!(looks_like_text(b"\xEF\xBB\xBFwith bom", false), "BOM");
        assert!(!looks_like_text(b"abc\0def", false), "NUL");
        assert!(!looks_like_text(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR", true), "PNG header");
        assert!(!looks_like_text(b"caff\xe8 latin-1", false), "invalid UTF-8");
        assert!(!looks_like_text(b"caff\xe8 latin-1", true), "invalid UTF-8 in a longer file");
        // U+1F600 is F0 9F 98 80: cut after two bytes at the sniff boundary.
        assert!(looks_like_text(b"ok \xF0\x9F", true), "sequence cut at the boundary");
        assert!(!looks_like_text(b"ok \xF0\x9F", false), "file really ends mid-sequence");
    }

    #[test]
    fn link_path_resolution() {
        assert_eq!(resolve_link_path("", None), None);
        assert_eq!(resolve_link_path("a\0b", Some(if cfg!(windows) { "C:\\x" } else { "/x" })), None);
        assert_eq!(resolve_link_path("src/a.ts", None), None, "relative without cwd");
        assert_eq!(resolve_link_path("src/a.ts", Some("relative/cwd")), None);
        assert_eq!(resolve_link_path(&"a".repeat(LINK_PATH_MAX + 1), None), None);
        if cfg!(windows) {
            assert_eq!(resolve_link_path("src/./b/../a.ts", Some("C:\\proj")), Some(PathBuf::from("C:\\proj\\src\\a.ts")));
            assert_eq!(resolve_link_path("..\\..\\..\\x", Some("C:\\proj")), Some(PathBuf::from("C:\\x")));
            assert_eq!(resolve_link_path("D:/a/b.txt", Some("C:\\proj")), Some(PathBuf::from("D:\\a\\b.txt")));
        } else {
            assert_eq!(resolve_link_path("src/./b/../a.ts", Some("/proj")), Some(PathBuf::from("/proj/src/a.ts")));
            assert_eq!(resolve_link_path("../../../x", Some("/proj")), Some(PathBuf::from("/x")));
            assert_eq!(resolve_link_path("/a/b.txt", Some("/proj")), Some(PathBuf::from("/a/b.txt")));
        }
        assert!(resolve_link_path("~/x", None).is_some_and(|p| p.is_absolute()));
    }

    #[test]
    fn stat_link_path_kinds() {
        let dir = std::env::temp_dir().join(format!("flowcode-path-kind-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "hello").unwrap();
        std::fs::write(dir.join("b.png"), b"\x89PNG\r\n\x1a\n\0\0").unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let a = stat_link_path("a.txt", Some(&cwd)).unwrap();
        assert_eq!((a.kind, a.text), ("file", true));
        assert!(Path::new(&a.path).is_absolute());
        let b = stat_link_path("./b.png", Some(&cwd)).unwrap();
        assert_eq!((b.kind, b.text), ("file", false));
        let d = stat_link_path(".", Some(&cwd)).unwrap();
        assert_eq!((d.kind, d.text), ("dir", false));
        assert_eq!(stat_link_path("missing.txt", Some(&cwd)), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn link_paths_stay_off_the_network_and_devices() {
        let cwd = Some("C:\\proj");
        // Refused before any stat: these would reach a server or a device.
        for bad in [
            "\\\\attacker\\share\\a.txt",
            "\\\\host@SSL@443\\x\\a",
            "\\\\host@80\\x\\a",
            "\\\\.\\pipe\\x",
            "\\\\.\\C:\\x",
            "\\\\?\\C:\\Windows\\win.ini",
            "\\\\?\\UNC\\attacker\\share\\a",
            "\\\\?\\GLOBALROOT\\Device\\x",
            "//attacker/share/a.txt",
        ] {
            assert_eq!(stat_link_path(bad, cwd), None, "{bad:?}");
            let full = resolve_link_path(bad, cwd);
            assert!(full.is_none_or(|f| !is_local_path(&f, false)), "{bad:?}");
        }
        // Drive-relative: would silently jump off the cwd's drive.
        assert_eq!(resolve_link_path("D:x\\a.txt", cwd), None);
        assert_eq!(resolve_link_path("a.txt", Some("\\\\attacker\\share")).map(|f| is_local_path(&f, false)), Some(false));
        // WSL shares (any case) and plain drives are fine.
        for ok in ["C:\\x", "\\\\wsl.localhost\\Ubuntu\\home", "\\\\WSL$\\Ubuntu\\home", "\\\\Wsl.LocalHost\\U\\x"] {
            assert!(is_local_path(Path::new(ok), false), "{ok:?}");
        }
        // Verbatim forms only when asked for (canonical paths, junction targets).
        assert!(is_local_path(Path::new("\\\\?\\C:\\x"), true));
        assert!(is_local_path(Path::new("\\\\?\\UNC\\wsl.localhost\\Ubuntu\\x"), true));
        assert!(!is_local_path(Path::new("\\\\?\\UNC\\attacker\\s\\x"), true));
        assert!(!is_local_path(Path::new("\\\\.\\pipe\\x"), true));
    }

    #[test]
    fn links_to_remote_targets_are_refused() {
        let dir = std::env::temp_dir().join(format!("flowcode-link-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("real")).unwrap();
        std::fs::write(dir.join("real").join("a.txt"), "hi").unwrap();
        assert!(links_stay_local(&dir.join("real").join("a.txt")));
        assert!(links_stay_local(&dir.join("missing").join("x")));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("real"), dir.join("ok")).unwrap();
            std::os::unix::fs::symlink("ok", dir.join("chain")).unwrap();
            std::os::unix::fs::symlink("loop", dir.join("loop")).unwrap();
            assert!(links_stay_local(&dir.join("ok").join("a.txt")));
            assert!(links_stay_local(&dir.join("chain").join("a.txt")));
            assert!(!links_stay_local(&dir.join("loop").join("x")), "a loop runs out of hops");
        }
        #[cfg(windows)]
        {
            // Symlinks need a privilege (or developer mode); a junction doesn't.
            let junction = |link: &Path, target: &str| {
                std::process::Command::new("cmd")
                    .args(["/C", "mklink", "/J"])
                    .arg(link)
                    .arg(target)
                    .output()
                    .is_ok_and(|o| o.status.success())
            };
            if junction(&dir.join("ok"), &dir.join("real").to_string_lossy()) {
                assert!(links_stay_local(&dir.join("ok").join("a.txt")));
                let cwd = dir.to_string_lossy().into_owned();
                assert!(stat_link_path("ok\\a.txt", Some(&cwd)).is_some());
            }
            // A junction can't point at a share, but a directory symlink can.
            let remote = dir.join("remote");
            if std::os::windows::fs::symlink_dir("\\\\attacker.invalid\\share", &remote).is_ok() {
                assert!(!links_stay_local(&remote.join("a.txt")));
                let cwd = dir.to_string_lossy().into_owned();
                assert_eq!(stat_link_path("remote\\a.txt", Some(&cwd)), None);
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validate_name_rejects_paths() {
        assert!(validate_name("ok.txt").is_ok());
        assert_eq!(validate_name("  spaced.md ").unwrap(), "spaced.md");
        for bad in ["", "  ", ".", "..", "a/b", "a\\b", "../x"] {
            assert!(validate_name(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn sort_puts_dirs_first_case_insensitive() {
        let mut entries = vec![
            FsEntry::new(Path::new("b.txt"), false),
            FsEntry::new(Path::new("Zdir"), true),
            FsEntry::new(Path::new("A.txt"), false),
            FsEntry::new(Path::new("adir"), true),
        ];
        sort_entries(&mut entries);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["adir", "Zdir", "A.txt", "b.txt"]);
    }
}
