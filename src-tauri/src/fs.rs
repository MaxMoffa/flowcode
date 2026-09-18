use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct FsEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub fn read_dir(path: String, show_hidden: Option<bool>) -> Result<Vec<FsEntry>, String> {
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
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    let path: Option<PathBuf> = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from));
    path.map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "could not resolve home directory".to_string())
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
