//! Custom chat names set from the History panel ("Rename").
//!
//! The names are Flowcode's own: a small JSON map `"<cli>:<sessionId>"` ->
//! title in the app data folder. The agents' transcripts are never touched, so
//! the override works for every agent and can be dropped by clearing the name.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MAX_LEN: usize = 200;

/// Serializes read-modify-write of the file (two quick renames must not lose one).
static LOCK: Mutex<()> = Mutex::new(());

fn store_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("history-titles.json"))
}

fn read_map(file: &PathBuf) -> HashMap<String, String> {
    std::fs::read_to_string(file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// The id of a chat: non-empty, bounded, no control characters.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_LEN && !id.chars().any(|c| c.is_control())
}

/// The trimmed title, or an error when it is too long or holds control characters or newlines.
fn clean_title(title: &str) -> Result<String, String> {
    let title = title.trim();
    if title.chars().count() > MAX_LEN {
        return Err("title too long".into());
    }
    if title.chars().any(|c| c.is_control()) {
        return Err("title has control characters".into());
    }
    Ok(title.to_string())
}

fn set_title(map: &mut HashMap<String, String>, cli: &str, session_id: &str, title: &str) -> Result<(), String> {
    if !valid_id(cli) || !valid_id(session_id) {
        return Err("invalid session".into());
    }
    let title = clean_title(title)?;
    let key = format!("{cli}:{session_id}");
    // An empty title clears the custom name: the agent's own title shows again.
    if title.is_empty() {
        map.remove(&key);
    } else {
        map.insert(key, title);
    }
    Ok(())
}

/// All custom names, keyed `cli:sessionId`.
#[tauri::command]
pub async fn history_titles(app: AppHandle) -> Result<HashMap<String, String>, String> {
    let file = store_file(&app)?;
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    Ok(read_map(&file))
}

/// Sets the custom name of a chat; an empty title removes it.
#[tauri::command]
pub async fn history_rename(app: AppHandle, cli: String, session_id: String, title: String) -> Result<(), String> {
    let file = store_file(&app)?;
    let _guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut map = read_map(&file);
    set_title(&mut map, &cli, &session_id, &title)?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    std::fs::write(file, text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sets_trims_and_clears() {
        let mut map = HashMap::new();
        set_title(&mut map, "claude", "abc", "  My chat ").unwrap();
        assert_eq!(map.get("claude:abc").map(String::as_str), Some("My chat"));
        set_title(&mut map, "claude", "abc", "   ").unwrap();
        assert!(map.is_empty());
    }

    #[test]
    fn rejects_bad_input() {
        let mut map = HashMap::new();
        assert!(set_title(&mut map, "claude", "", "x").is_err());
        assert!(set_title(&mut map, "claude", "a\nb", "x").is_err());
        assert!(set_title(&mut map, "claude", "abc", "two\nlines").is_err());
        assert!(set_title(&mut map, "claude", "abc", &"x".repeat(201)).is_err());
        assert!(map.is_empty());
    }
}
