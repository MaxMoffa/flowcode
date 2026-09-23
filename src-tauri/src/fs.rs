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

const ALREADY_EXISTS: &str = "Esiste già un file o una cartella con questo nome";

/// A name coming from the UI must name exactly one entry inside the target
/// directory - never a path that escapes it.
fn validate_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." || trimmed.contains(['/', '\\']) {
        return Err(format!("Nome non valido: \"{name}\""));
    }
    Ok(trimmed)
}

fn map_exists_error(e: std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::AlreadyExists => ALREADY_EXISTS.to_string(),
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

fn search_dir_recursive(dir: &Path, query: &str, show_hidden: bool, results: &mut Vec<FsEntry>) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.filter_map(|e| e.ok()) {
        if results.len() >= SEARCH_MAX_RESULTS {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && SEARCH_IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        if name.to_lowercase().contains(query) {
            results.push(FsEntry::new(&path, is_dir));
        }
        if is_dir {
            search_dir_recursive(&path, query, show_hidden, results);
        }
    }
}

/// Recursive name search from `path` downward - unlike `read_dir`, which
/// only ever lists one directory. Skips `SEARCH_IGNORE_DIRS` and (unless
/// `show_hidden`) dotfiles, and stops at `SEARCH_MAX_RESULTS` matches so a
/// broad query over a big tree can't run forever.
#[tauri::command]
pub async fn search_dir(path: String, query: String, show_hidden: Option<bool>) -> Result<Vec<FsEntry>, String> {
    blocking(move || {
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let mut results = Vec::new();
        search_dir_recursive(Path::new(&path), &query, show_hidden.unwrap_or(false), &mut results);
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

/// Per-OS app config directory (same root `overrides_path` and `plugins_dir`
/// write into) - exposed so Settings → Informazioni can open it directly in
/// the OS file manager. Created on demand: on a brand-new install nothing
/// may have written here yet, and opening a path that doesn't exist would
/// just fail silently.
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
    std::fs::write(path, contents).map_err(|e| e.to_string())
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
        return Err(ALREADY_EXISTS.to_string());
    }
    std::fs::rename(src, &dest).map_err(|e| e.to_string())?;
    Ok(FsEntry::new(&dest, dest.is_dir()))
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let dest_path = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
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

#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_entry(path: String, is_dir: bool) -> Result<(), String> {
    blocking(move || {
        let target = Path::new(&path);
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

#[cfg(test)]
mod tests {
    use super::*;

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
