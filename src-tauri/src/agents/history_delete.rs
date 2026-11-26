//! Permanent deletion of saved agent chats (History panel) and locating a
//! chat's file on disk ("reveal in file manager").
//!
//! The caller only names a chat (agent, id, profile, WSL distro); every path
//! is rebuilt here from the profile's folders and a validated id, never taken
//! from the caller. A failing chat never stops the others in a batch.

use super::{find_codex_rollout, forget_codex_rollout, is_safe_session_id, wsl_codex_sessions_root};
use crate::profiles::ProfileDirs;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub cli: String,
    pub session_id: String,
    pub profile: Option<String>,
    pub wsl_distro: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteFailure {
    pub session_id: String,
    pub error: String,
}

#[derive(Serialize)]
pub struct DeleteReport {
    /// Session ids that were deleted.
    pub deleted: Vec<String>,
    pub failed: Vec<DeleteFailure>,
}

fn not_found() -> String {
    "not found".to_string()
}

/// Errors unless `path` lies under `home` (paths are built by joining, so this
/// is a guard against a bug, not against `..`: ids are validated).
fn within(path: &Path, home: &Path) -> Result<(), String> {
    if path.starts_with(home) {
        Ok(())
    } else {
        Err("path outside the agent folder".into())
    }
}

/// The root of a Codex `sessions` folder: the profile's, or the default WSL
/// distro's when `wsl` names it.
fn codex_root(dirs: &ProfileDirs, wsl: Option<&str>) -> Result<PathBuf, String> {
    match wsl {
        None => Ok(dirs.codex.join("sessions")),
        Some(distro) => match wsl_codex_sessions_root() {
            Some((d, root)) if d == distro => Ok(root),
            _ => Err("WSL distro not available".into()),
        },
    }
}

fn vibe_root(dirs: &ProfileDirs, wsl: Option<&str>) -> Result<PathBuf, String> {
    match wsl {
        None => Ok(crate::vibe::sessions_root(&dirs.vibe)),
        Some(distro) => match crate::vibe::wsl_sessions_root() {
            Some((d, root)) if d == distro => Ok(root),
            _ => Err("WSL distro not available".into()),
        },
    }
}

// --- Claude ---------------------------------------------------------------

/// `<claude>/projects/<folder>/<id>.jsonl` and its `<folder>`.
fn claude_transcript(claude: &Path, id: &str) -> Result<(PathBuf, PathBuf), String> {
    let projects = claude.join("projects");
    for entry in std::fs::read_dir(&projects).map_err(|_| not_found())?.flatten() {
        let file = entry.path().join(format!("{id}.jsonl"));
        if file.is_file() {
            within(&file, claude)?;
            return Ok((file, entry.path()));
        }
    }
    Err(not_found())
}

fn claude_delete(claude: &Path, id: &str) -> Result<(), String> {
    let (file, folder) = claude_transcript(claude, id)?;
    std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    for dir in [folder.join(id), claude.join("file-history").join(id)] {
        within(&dir, claude)?;
        if dir.is_dir() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// --- Codex ----------------------------------------------------------------

/// Rewrites a `session_index.jsonl` without the lines whose `id` is `id`
/// (other lines stay byte-identical). Nothing happens when the file is missing
/// or has no such line.
fn rewrite_codex_index(index: &Path, id: &str) -> Result<(), String> {
    let Ok(raw) = std::fs::read_to_string(index) else { return Ok(()) };
    let is_target = |line: &str| serde_json::from_str::<serde_json::Value>(line).ok().is_some_and(|v| v.get("id").and_then(|i| i.as_str()) == Some(id));
    let kept: String = raw.split_inclusive('\n').filter(|line| !is_target(line.trim())).collect();
    if kept.len() == raw.len() {
        return Ok(());
    }
    let tmp = index.with_extension(format!("jsonl.tmp-{}", uuid::Uuid::new_v4()));
    std::fs::write(&tmp, kept).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, index).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn codex_delete(root: &Path, id: &str) -> Result<(), String> {
    let file = find_codex_rollout(root, id).ok_or_else(not_found)?;
    within(&file, root)?;
    std::fs::remove_file(&file).map_err(|e| e.to_string())?;
    forget_codex_rollout(root, id);
    if let Some(home) = root.parent() {
        rewrite_codex_index(&home.join("session_index.jsonl"), id)?;
    }
    Ok(())
}

// --- Dispatch -------------------------------------------------------------

fn locate(dirs: &ProfileDirs, cli: &str, id: &str, wsl: Option<&str>) -> Result<PathBuf, String> {
    if !is_safe_session_id(id) {
        return Err("invalid session id".into());
    }
    match cli {
        "claude" => {
            if wsl.is_some() {
                return Err("not supported in WSL".into());
            }
            claude_transcript(&dirs.claude, id).map(|(file, _)| file)
        }
        "codex" => find_codex_rollout(&codex_root(dirs, wsl)?, id).ok_or_else(not_found),
        "vibe" => crate::vibe::find_session_dir(&vibe_root(dirs, wsl)?, id).ok_or_else(not_found),
        "opencode" => {
            if wsl.is_some() {
                return Err("not supported in WSL".into());
            }
            Ok(dirs.opencode_db.clone())
        }
        "cline" => {
            if wsl.is_some() {
                return Err("not supported in WSL".into());
            }
            let dir = dirs.cline.join("data").join("sessions").join(id);
            Ok(if dir.is_dir() { dir } else { crate::cline_db::db_path(&dirs.cline) })
        }
        _ => Err("unsupported agent".into()),
    }
}

fn delete(dirs: &ProfileDirs, cli: &str, id: &str, wsl: Option<&str>) -> Result<(), String> {
    if !is_safe_session_id(id) {
        return Err("invalid session id".into());
    }
    let no_wsl = || if wsl.is_some() { Err("not supported in WSL".to_string()) } else { Ok(()) };
    match cli {
        "claude" => {
            no_wsl()?;
            claude_delete(&dirs.claude, id)
        }
        "codex" => codex_delete(&codex_root(dirs, wsl)?, id),
        "vibe" => {
            let root = vibe_root(dirs, wsl)?;
            let dir = crate::vibe::find_session_dir(&root, id).ok_or_else(not_found)?;
            within(&dir, &root)?;
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
        }
        "opencode" => {
            no_wsl()?;
            crate::opencode_db::delete_session(&dirs.opencode_db, id).map(drop)
        }
        "cline" => {
            no_wsl()?;
            crate::cline_db::delete_session(&dirs.cline, id).map(drop)
        }
        _ => Err("unsupported agent".into()),
    }
}

fn profile_dirs(app: &tauri::AppHandle, profile: Option<&str>) -> Result<ProfileDirs, String> {
    crate::profiles::dirs(app, profile).ok_or_else(|| "unknown profile".to_string())
}

/// Where a saved chat lives on disk: its file or folder, or (OpenCode, and
/// Cline without a folder) the database. For "reveal in file manager".
#[tauri::command]
pub async fn history_session_path(app: tauri::AppHandle, cli: String, session_id: String, profile: Option<String>, wsl_distro: Option<String>) -> Result<String, String> {
    crate::blocking(move || {
        let dirs = profile_dirs(&app, profile.as_deref())?;
        locate(&dirs, &cli, &session_id, wsl_distro.as_deref()).map(|p| p.to_string_lossy().into_owned())
    })
    .await
}

/// Permanently deletes saved chats. Each item is independent: failures are
/// reported per session id and the rest still go through.
#[tauri::command]
pub async fn history_delete_sessions(app: tauri::AppHandle, items: Vec<HistoryItem>) -> Result<DeleteReport, String> {
    crate::blocking(move || {
        let mut report = DeleteReport { deleted: Vec::new(), failed: Vec::new() };
        for item in items {
            let result = profile_dirs(&app, item.profile.as_deref()).and_then(|dirs| delete(&dirs, &item.cli, &item.session_id, item.wsl_distro.as_deref()));
            match result {
                Ok(()) => report.deleted.push(item.session_id),
                Err(error) => report.failed.push(DeleteFailure { session_id: item.session_id, error }),
            }
        }
        Ok(report)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("history-delete-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_delete_removes_transcript_sibling_and_file_history() {
        let claude = temp_dir();
        let folder = claude.join("projects").join("C--p");
        std::fs::create_dir_all(folder.join("abc")).unwrap();
        std::fs::create_dir_all(claude.join("file-history").join("abc")).unwrap();
        std::fs::write(folder.join("abc.jsonl"), "{}").unwrap();
        std::fs::write(folder.join("keep.jsonl"), "{}").unwrap();
        std::fs::write(folder.join("abc").join("x.txt"), "x").unwrap();
        assert_eq!(claude_transcript(&claude, "abc").unwrap().0, folder.join("abc.jsonl"));
        claude_delete(&claude, "abc").unwrap();
        assert!(!folder.join("abc.jsonl").exists() && !folder.join("abc").exists());
        assert!(!claude.join("file-history").join("abc").exists());
        assert!(folder.join("keep.jsonl").exists());
        assert_eq!(claude_delete(&claude, "abc"), Err("not found".to_string()));
        let _ = std::fs::remove_dir_all(claude);
    }

    #[test]
    fn codex_index_rewrite_drops_only_the_matching_line() {
        let dir = temp_dir();
        let index = dir.join("session_index.jsonl");
        let a = r#"{"id":"aaa","thread_name":"A"}"#;
        let b = r#"{"id":"bbb",  "thread_name":"B"}"#;
        std::fs::write(&index, format!("{a}\n{b}\n{a}\nnot json\n")).unwrap();
        rewrite_codex_index(&index, "aaa").unwrap();
        assert_eq!(std::fs::read_to_string(&index).unwrap(), format!("{b}\nnot json\n"));
        rewrite_codex_index(&index, "zzz").unwrap();
        assert_eq!(std::fs::read_to_string(&index).unwrap(), format!("{b}\nnot json\n"));
        rewrite_codex_index(&dir.join("missing.jsonl"), "aaa").unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_delete_removes_rollout_and_index_line() {
        let home = temp_dir();
        let day = home.join("sessions").join("2026").join("11").join("26");
        std::fs::create_dir_all(&day).unwrap();
        let file = day.join("rollout-2026-11-26T10-00-00-abc123.jsonl");
        std::fs::write(&file, "{}").unwrap();
        std::fs::write(home.join("session_index.jsonl"), "{\"id\":\"abc123\"}\n{\"id\":\"other\"}\n").unwrap();
        let root = home.join("sessions");
        assert_eq!(find_codex_rollout(&root, "abc123"), Some(file.clone()));
        codex_delete(&root, "abc123").unwrap();
        assert!(!file.exists());
        assert_eq!(std::fs::read_to_string(home.join("session_index.jsonl")).unwrap(), "{\"id\":\"other\"}\n");
        assert_eq!(codex_delete(&root, "abc123"), Err("not found".to_string()));
        let _ = std::fs::remove_dir_all(home);
    }

    #[test]
    fn unsafe_ids_are_rejected() {
        let dir = temp_dir();
        let dirs = ProfileDirs {
            claude: dir.clone(),
            codex: dir.clone(),
            vibe: dir.clone(),
            gemini: dir.clone(),
            opencode_config: dir.clone(),
            opencode_db: dir.join("o.db"),
            cline: dir.clone(),
        };
        for id in ["../x", "a/b", "", "x;y"] {
            assert_eq!(delete(&dirs, "claude", id, None), Err("invalid session id".to_string()));
            assert_eq!(locate(&dirs, "claude", id, None), Err("invalid session id".to_string()));
        }
        assert_eq!(delete(&dirs, "gemini", "abc", None), Err("unsupported agent".to_string()));
        assert_eq!(delete(&dirs, "claude", "abc", Some("Ubuntu")), Err("not supported in WSL".to_string()));
        let _ = std::fs::remove_dir_all(dir);
    }
}
