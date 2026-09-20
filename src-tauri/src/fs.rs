use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// Cheap existence check - used by App.tsx's `handleTitleChange` to verify a
/// candidate "we're back on a real shell prompt" path while a tab's
/// `nestedShell` is `"agent"` (Claude Code/Codex has, or just had, the
/// screen) before trusting it: a real post-exit shell prompt reports an
/// actual cwd, but the CLI's own console-title noise while it's running
/// isn't reliably distinguishable from that by shape alone (an executable
/// path, a resolved script path, ...) - this asks the filesystem instead of
/// guessing. `async` + `spawn_blocking` for the same reason as `read_dir`:
/// this can be asked about a WSL UNC path too.
#[tauri::command]
pub async fn is_directory(path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || Path::new(&path).is_dir())
        .await
        .unwrap_or(false)
}

/// `async` + `spawn_blocking`, same reasoning as `search_dir` below: a WSL
/// UNC path (`\\wsl.localhost\...`) can take a real, noticeable amount of
/// time to answer the first `read_dir` after the network redirector session
/// negotiates - on a plain sync command that stalls every other `#[tauri::
/// command]` queued on the same shared worker pool (typed keystrokes,
/// `pty_write`, included) until it returns, which reads as "the file
/// explorer is stuck and the whole app with it", not just a slow folder.
#[tauri::command]
pub async fn read_dir(path: String, show_hidden: Option<bool>) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let show_hidden = show_hidden.unwrap_or(false);
        let dir = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
        let mut entries: Vec<FsEntry> = dir
            .filter_map(|entry| entry.ok())
            .filter(|entry| show_hidden || !entry.file_name().to_string_lossy().starts_with('.'))
            .map(|entry| {
                let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
                FsEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: entry.path().to_string_lossy().to_string(),
                    is_dir,
                }
            })
            .collect();

        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });

        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Never worth descending into for a name search - huge, machine-generated,
/// and would otherwise dominate the (capped) result list with noise.
const SEARCH_IGNORE_DIRS: &[&str] = &["node_modules", ".git", "target", "dist", "build", ".next", ".venv", "__pycache__"];

fn search_dir_recursive(dir: &Path, query: &str, show_hidden: bool, results: &mut Vec<FsEntry>, max_results: usize) {
    let Ok(read) = std::fs::read_dir(dir) else { return };
    for entry in read.filter_map(|e| e.ok()) {
        if results.len() >= max_results {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !show_hidden && name.starts_with('.') {
            continue;
        }
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && SEARCH_IGNORE_DIRS.contains(&name.as_str()) {
            continue;
        }
        if name.to_lowercase().contains(query) {
            results.push(FsEntry {
                name: name.clone(),
                path: entry.path().to_string_lossy().to_string(),
                is_dir,
            });
        }
        if is_dir {
            search_dir_recursive(&entry.path(), query, show_hidden, results, max_results);
        }
    }
}

/// Recursive name search from `path` downward - unlike `read_dir`, which
/// only ever lists one directory. Skips `SEARCH_IGNORE_DIRS` and (unless
/// `show_hidden`) dotfiles, same as the plain listing, and stops at 300
/// matches so a broad query over a big tree can't hang the UI.
///
/// `async` + `spawn_blocking`, not a plain sync command: a walk that hasn't
/// hit either stop condition yet (few/no matches in a large tree - Windows'
/// NTFS metadata calls are noticeably slower than Linux here) can run for
/// seconds, and every `#[tauri::command]` shares one bounded worker pool -
/// a slow search left running there queues up everything else behind it,
/// typed keystrokes (`pty_write`) included, which reads as "the terminal
/// just froze". `spawn_blocking` moves the walk to Tokio's separate,
/// much larger blocking-thread pool instead.
#[tauri::command]
pub async fn search_dir(path: String, query: String, show_hidden: Option<bool>) -> Result<Vec<FsEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let show_hidden = show_hidden.unwrap_or(false);
        let query = query.trim().to_lowercase();
        if query.is_empty() {
            return Vec::new();
        }
        let mut results = Vec::new();
        search_dir_recursive(Path::new(&path), &query, show_hidden, &mut results, 300);
        results.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        results
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    let path: Option<PathBuf> = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from));
    path.map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "could not resolve home directory".to_string())
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
    Ok(dir.to_string_lossy().to_string())
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

#[tauri::command]
pub fn create_file_entry(dir: String, name: String) -> Result<FsEntry, String> {
    let path = Path::new(&dir).join(&name);
    if path.exists() {
        return Err("A file or folder with this name already exists".to_string());
    }
    std::fs::File::create(&path).map_err(|e| e.to_string())?;
    Ok(FsEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: false,
    })
}

#[tauri::command]
pub fn create_dir_entry(dir: String, name: String) -> Result<FsEntry, String> {
    let path = Path::new(&dir).join(&name);
    if path.exists() {
        return Err("A file or folder with this name already exists".to_string());
    }
    std::fs::create_dir(&path).map_err(|e| e.to_string())?;
    Ok(FsEntry {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir: true,
    })
}

#[tauri::command]
pub fn rename_entry(path: String, new_name: String) -> Result<FsEntry, String> {
    let src = Path::new(&path);
    let parent = src.parent().ok_or("cannot rename the root directory")?;
    let dest = parent.join(&new_name);
    if dest.exists() {
        return Err("A file or folder with this name already exists".to_string());
    }
    std::fs::rename(src, &dest).map_err(|e| e.to_string())?;
    Ok(FsEntry {
        name: new_name,
        path: dest.to_string_lossy().to_string(),
        is_dir: dest.is_dir(),
    })
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
pub fn duplicate_entry(path: String) -> Result<FsEntry, String> {
    let src = Path::new(&path);
    let parent = src.parent().ok_or("cannot duplicate the root directory")?;
    let is_dir = src.is_dir();
    let dest = if is_dir {
        let stem = src.file_name().and_then(|n| n.to_str()).unwrap_or("folder");
        unique_copy_path(parent, stem, None)
    } else {
        let stem = src.file_stem().and_then(|n| n.to_str()).unwrap_or("file");
        let ext = src.extension().and_then(|n| n.to_str());
        unique_copy_path(parent, stem, ext)
    };

    if is_dir {
        copy_dir_recursive(src, &dest).map_err(|e| e.to_string())?;
    } else {
        std::fs::copy(src, &dest).map_err(|e| e.to_string())?;
    }

    Ok(FsEntry {
        name: dest.file_name().unwrap_or_default().to_string_lossy().to_string(),
        path: dest.to_string_lossy().to_string(),
        is_dir,
    })
}

#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_entry(path: String, is_dir: bool) -> Result<(), String> {
    let target = Path::new(&path);
    if is_dir {
        std::fs::remove_dir_all(target).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(target).map_err(|e| e.to_string())
    }
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

fn system_time_to_millis(time: std::io::Result<std::time::SystemTime>) -> Option<u64> {
    time.ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

#[tauri::command]
pub fn get_file_info(path: String) -> Result<FileInfo, String> {
    let target = Path::new(&path);
    let meta = std::fs::metadata(target).map_err(|e| e.to_string())?;
    let name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
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
