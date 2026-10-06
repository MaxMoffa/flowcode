//! Mistral Vibe (`vibe`, Mistral's terminal coding agent) - everything this
//! app reads off its own files. Vibe has no registry of running sessions and
//! no usage/limit endpoint: like Codex it only leaves a folder per session
//! under `~/.vibe/logs/session/` (`$VIBE_HOME` when set), holding the
//! transcript (`messages.jsonl`) and a `meta.json` rewritten after every
//! model step - session id, title, working directory and the session's token
//! counts and cost. That's enough for the Agents panel (live and saved
//! sessions) and for a spend summary in the shortcut's popover: Vibe is
//! billed per token on a Mistral API key, so "how much did I spend" is the
//! number that matters, not a rate-limit window.
//!
//! Everything here is best-effort, like the Codex readers in agents.rs: a
//! folder or file that doesn't parse the way expected is skipped, never
//! surfaced as an error.

use serde::Serialize;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The model Flowcode registers in Vibe's config (see `vibe_ensure_model`):
/// Mistral Large 4, which Vibe doesn't list on its own yet. Prices are
/// Mistral's public ones (USD per million tokens), so Vibe's own cost
/// counter - and so this app's spend summary - stays right.
const LARGE_4_ALIAS: &str = "mistral-large-4";
const LARGE_4_NAME: &str = "mistral-large-4";
const LARGE_4_DISPLAY: &str = "Mistral Large 4";
const LARGE_4_INPUT_PRICE: f64 = 0.68;
const LARGE_4_OUTPUT_PRICE: f64 = 2.09;
const LARGE_4_CACHED_PRICE: f64 = 0.07;
const LARGE_4_CONTEXT: i64 = 1_000_000;

/// Vibe's home folder: `$VIBE_HOME`, else `~/.vibe` - the same lookup as
/// Vibe's own `get_vibe_home`.
pub(crate) fn vibe_home() -> Option<PathBuf> {
    if let Some(home) = std::env::var_os("VIBE_HOME").filter(|v| !v.is_empty()) {
        return Some(PathBuf::from(home));
    }
    Some(crate::fs::user_home()?.join(".vibe"))
}

fn sessions_root(home: &Path) -> PathBuf {
    home.join("logs").join("session")
}

/// What this app needs out of one session's `meta.json`.
#[derive(Clone)]
struct SessionMeta {
    id: String,
    title: Option<String>,
    cwd: Option<String>,
    /// A sub-agent's session (it has a parent) - never listed on its own.
    child: bool,
    /// `meta.json`'s mtime (ms): when the session last wrote.
    updated_at: Option<u64>,
    cost: f64,
    tokens: u64,
    model: Option<String>,
    dir: PathBuf,
}

fn read_meta(dir: &Path) -> Option<SessionMeta> {
    let path = dir.join("meta.json");
    let updated_at = crate::fs::system_time_to_millis(std::fs::metadata(&path).and_then(|m| m.modified()));
    let raw = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parse_meta(&value, dir.to_path_buf(), updated_at)
}

fn parse_meta(value: &serde_json::Value, dir: PathBuf, updated_at: Option<u64>) -> Option<SessionMeta> {
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string);
    let id = text(value.get("session_id"))?;
    let stats = value.get("stats");
    let num = |key: &str| stats.and_then(|s| s.get(key)).and_then(|v| v.as_f64()).unwrap_or(0.0);
    let prompt = num("session_prompt_tokens");
    let completion = num("session_completion_tokens");
    // `session_cost` is a computed field Vibe writes alongside the counters;
    // worked out from the counters and the prices it recorded when missing
    // (an older Vibe). Cached input tokens are billed at their own price
    // when one is known, else as regular input - Vibe's own rule.
    let cost = stats
        .and_then(|s| s.get("session_cost"))
        .and_then(|v| v.as_f64())
        .unwrap_or_else(|| {
            let cached = num("session_cached_tokens").min(prompt);
            let input_price = num("input_price_per_million");
            let cached_price = stats
                .and_then(|s| s.get("cached_input_price_per_million"))
                .and_then(|v| v.as_f64())
                .unwrap_or(input_price);
            ((prompt - cached) * input_price + cached * cached_price + completion * num("output_price_per_million"))
                / 1_000_000.0
        });
    Some(SessionMeta {
        id,
        title: text(value.get("title")),
        cwd: text(value.get("environment").and_then(|e| e.get("working_directory")))
            .or_else(|| text(value.get("origin_directory"))),
        child: value.get("parent_session_id").is_some_and(|p| !p.is_null()),
        updated_at,
        cost: if cost.is_finite() { cost.max(0.0) } else { 0.0 },
        tokens: (prompt + completion).max(0.0) as u64,
        model: text(value.get("config").and_then(|c| c.get("active_model"))),
        dir,
    })
}

/// Every session folder under `root` with its `meta.json` mtime, newest
/// first - one cheap stat each, so callers only open what they keep.
fn session_dirs(root: &Path) -> Vec<(PathBuf, Option<u64>)> {
    let Ok(entries) = std::fs::read_dir(root) else { return Vec::new() };
    let mut dirs: Vec<(PathBuf, Option<u64>)> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| {
            let mtime = std::fs::metadata(p.join("meta.json")).and_then(|m| m.modified());
            if mtime.is_err() {
                return None;
            }
            Some((p, crate::fs::system_time_to_millis(mtime)))
        })
        .collect();
    dirs.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));
    dirs
}

fn now_ms() -> u64 {
    crate::fs::system_time_to_millis(Ok(std::time::SystemTime::now())).unwrap_or(0)
}

/// What a session's transcript says about its current turn: `Some(true)`
/// while the model still has work queued (the last message is a tool result,
/// or a tool call whose result isn't in yet), `Some(false)` once it last
/// answered. Vibe saves after every model step, so this follows a long turn
/// step by step; only the wait for the very first answer of a turn isn't
/// visible. Reads the file's tail only - never a whole transcript.
fn turn_open(dir: &Path) -> Option<bool> {
    const TAIL: u64 = 256 * 1024;
    let mut file = std::fs::File::open(dir.join("messages.jsonl")).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL))).ok()?;
    let mut buf = Vec::new();
    file.take(TAIL).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let last = text.lines().rev().find(|l| !l.trim().is_empty())?;
    let message: serde_json::Value = serde_json::from_str(last).ok()?;
    let role = message.get("role")?.as_str()?;
    let pending_tools = message
        .get("tool_calls")
        .and_then(|c| c.as_array())
        .is_some_and(|c| !c.is_empty());
    Some(role == "tool" || role == "user" || (role == "assistant" && pending_tools))
}

fn same_dir(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim_end_matches(['\\', '/']).replace('\\', "/").to_lowercase();
    norm(a) == norm(b)
}

/// The session a `vibe` running in `cwd` is working on: the most recently
/// written top-level session in that folder. Id, title, "busy"/"idle".
pub(crate) fn live_session_in(cwd: &str, started_at: Option<u64>) -> Option<(String, Option<String>, &'static str)> {
    live_session_under(&sessions_root(&vibe_home()?), cwd, started_at)
}

pub(crate) fn live_session_under(
    root: &Path,
    cwd: &str,
    started_at: Option<u64>,
) -> Option<(String, Option<String>, &'static str)> {
    let meta = session_dirs(root)
        .into_iter()
        // A session last written before this process started belongs to an
        // earlier run, not this one (a fresh `vibe` writes nothing until its
        // first answer). A minute of slack covers clock rounding.
        .take_while(|(_, mtime)| match (mtime, started_at) {
            (Some(m), Some(s)) => *m + 60_000 >= s,
            _ => true,
        })
        .take(40)
        .filter_map(|(dir, _)| read_meta(&dir))
        .find(|m| !m.child && m.cwd.as_deref().is_some_and(|c| same_dir(c, cwd)))?;
    let status = match turn_open(&meta.dir) {
        Some(true) => "busy",
        _ => "idle",
    };
    Some((meta.id, meta.title, status))
}

/// One saved Vibe session for the Agents panel's "saved" list - resumed with
/// `vibe --resume <sessionId>` in its folder.
#[derive(Serialize, Clone)]
pub struct VibeSessionEntry {
    cwd: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    /// When it last wrote (ms).
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
    /// Saved by Vibe inside this WSL distro - `cwd` is then a Linux path.
    #[serde(rename = "wslDistro")]
    wsl_distro: Option<String>,
    /// The title Vibe generated for it (or the one the user gave it).
    name: Option<String>,
}

const MAX_VIBE_SESSIONS: usize = 8;

fn scan_saved_sessions(root: &Path, wsl_distro: Option<&str>) -> Vec<VibeSessionEntry> {
    session_dirs(root)
        .into_iter()
        .take(MAX_VIBE_SESSIONS * 4)
        .filter_map(|(dir, _)| read_meta(&dir))
        .filter(|m| !m.child)
        .filter_map(|m| {
            Some(VibeSessionEntry {
                cwd: m.cwd?,
                session_id: m.id,
                started_at: m.updated_at,
                wsl_distro: wsl_distro.map(str::to_string),
                name: m.title,
            })
        })
        .take(MAX_VIBE_SESSIONS)
        .collect()
}

/// `~/.vibe/logs/session` of the default WSL distro, through its
/// `\\wsl.localhost` share - where Vibe keeps its sessions when it's used
/// from WSL. The distro's home is asked once per run.
#[cfg(target_os = "windows")]
fn wsl_sessions_root() -> Option<(String, PathBuf)> {
    static HOME: std::sync::OnceLock<Option<(String, String)>> = std::sync::OnceLock::new();
    let (distro, home) = HOME
        .get_or_init(|| {
            let distro = crate::system::wsl_default_distro()?;
            let home = crate::system::wsl_home_dir(distro.clone(), None)?;
            Some((distro, home))
        })
        .clone()?;
    let unc = format!(r"\\wsl.localhost\{distro}{}", home.replace('/', r"\"));
    Some((distro, sessions_root(&PathBuf::from(unc).join(".vibe"))))
}

#[cfg(not(target_os = "windows"))]
fn wsl_sessions_root() -> Option<(String, PathBuf)> {
    None
}

/// How long a scan of the WSL sessions folder is reused - every file access
/// crosses into the distro's file share, and the panel polls every few
/// seconds.
const WSL_SCAN_TTL: std::time::Duration = std::time::Duration::from_secs(20);

/// Saved Vibe sessions (Windows' own and the default WSL distro's), newest
/// first. Async + blocking pool: it opens files on every panel poll.
#[tauri::command]
pub async fn list_vibe_sessions(fresh: Option<bool>) -> Result<Vec<VibeSessionEntry>, String> {
    crate::blocking(move || {
        static WSL_CACHE: Mutex<Option<(std::time::Instant, Vec<VibeSessionEntry>)>> = Mutex::new(None);
        let mut sessions = vibe_home()
            .map(|home| scan_saved_sessions(&sessions_root(&home), None))
            .unwrap_or_default();
        let wsl = {
            let mut cache = WSL_CACHE.lock().unwrap();
            match cache.as_ref() {
                Some((at, cached)) if at.elapsed() < WSL_SCAN_TTL && fresh != Some(true) => cached.clone(),
                _ => {
                    let scanned = wsl_sessions_root()
                        .map(|(distro, root)| scan_saved_sessions(&root, Some(&distro)))
                        .unwrap_or_default();
                    *cache = Some((std::time::Instant::now(), scanned.clone()));
                    scanned
                }
            }
        };
        sessions.extend(wsl);
        sessions.sort_by_key(|s| std::cmp::Reverse(s.started_at));
        sessions.truncate(MAX_VIBE_SESSIONS);
        Ok(sessions)
    })
    .await
}

use crate::spend::SpendPeriod;

#[derive(Serialize)]
pub struct VibeUsage {
    /// A Mistral API key is configured (`MISTRAL_API_KEY` in the environment
    /// or in `~/.vibe/.env`, where `vibe --setup` saves it).
    #[serde(rename = "hasApiKey")]
    has_api_key: bool,
    /// Since local midnight.
    today: SpendPeriod,
    /// The last 7 and 30 days, today included.
    week: SpendPeriod,
    month: SpendPeriod,
    /// The model of the most recent session (Vibe's alias for it).
    #[serde(rename = "lastModel")]
    last_model: Option<String>,
}

/// Whether Vibe has a Mistral API key to work with.
pub(crate) fn has_api_key() -> bool {
    if std::env::var_os("MISTRAL_API_KEY").is_some_and(|v| !v.is_empty()) {
        return true;
    }
    let Some(env) = vibe_home().and_then(|h| std::fs::read_to_string(h.join(".env")).ok()) else {
        return false;
    };
    env_file_has_key(&env, "MISTRAL_API_KEY")
}

fn env_file_has_key(env: &str, key: &str) -> bool {
    env.lines().any(|line| {
        let line = line.trim().trim_start_matches("export ").trim();
        line.split_once('=').is_some_and(|(k, v)| {
            k.trim() == key && !v.trim().trim_matches(|c| c == '"' || c == '\'').is_empty()
        })
    })
}

/// Today's UTC midnight (ms) - only the fallback: the backend has no
/// timezone data, so the frontend passes its own local midnight in (see
/// `vibe_usage_stats`).
fn utc_midnight(now: u64) -> u64 {
    now - now % 86_400_000
}

/// The spend summary shown in the Vibe shortcut's popover: cost, tokens and
/// sessions today and over the last 7 / 30 days, summed from the sessions'
/// own `meta.json` (a session counts in the period it last wrote in).
/// `today_start` is the frontend's local midnight (ms) - the backend has no
/// timezone data of its own.
#[tauri::command]
pub async fn vibe_usage_stats(today_start: Option<u64>) -> Result<VibeUsage, String> {
    crate::blocking(move || {
        let now = now_ms();
        let today = today_start.filter(|t| *t <= now).unwrap_or_else(|| utc_midnight(now));
        let metas: Vec<SessionMeta> = vibe_home()
            .map(|home| {
                session_dirs(&sessions_root(&home))
                    .into_iter()
                    .take_while(|(_, mtime)| mtime.is_none_or(|m| now.saturating_sub(m) < 31 * 86_400_000))
                    .filter_map(|(dir, _)| read_meta(&dir))
                    .collect()
            })
            .unwrap_or_default();
        Ok(summarize(&metas, now, today, has_api_key()))
    })
    .await
}

fn summarize(metas: &[SessionMeta], now: u64, today_start: u64, has_api_key: bool) -> VibeUsage {
    let mut usage = VibeUsage {
        has_api_key,
        today: SpendPeriod::default(),
        week: SpendPeriod::default(),
        month: SpendPeriod::default(),
        last_model: metas.iter().find_map(|m| m.model.clone()),
    };
    let add = |p: &mut SpendPeriod, m: &SessionMeta| {
        p.cost += m.cost;
        p.tokens += m.tokens;
        p.sessions += 1;
    };
    // Sub-agent sessions are billed too - they're counted in the spend, just
    // never listed as sessions of their own.
    for m in metas {
        let Some(at) = m.updated_at else { continue };
        let age = now.saturating_sub(at);
        if age < 30 * 86_400_000 {
            add(&mut usage.month, m);
            if m.child {
                usage.month.sessions -= 1;
            }
        }
        if age < 7 * 86_400_000 {
            add(&mut usage.week, m);
            if m.child {
                usage.week.sessions -= 1;
            }
        }
        if at >= today_start {
            add(&mut usage.today, m);
            if m.child {
                usage.today.sessions -= 1;
            }
        }
    }
    usage
}

/// Makes Mistral Large 4 available in Vibe: adds it to `~/.vibe/config.toml`
/// (`[[models]]`, with its context window and prices) when it isn't there
/// yet, and makes it the active model when the user hasn't pinned one of
/// their own - a model they picked in Vibe (`/model`) is never overridden.
/// Edited with `toml_edit`, so the rest of the file - comments, order,
/// everything Vibe or the user wrote - stays exactly as it was. Returns
/// whether the file changed.
#[tauri::command]
pub async fn vibe_ensure_model() -> Result<bool, String> {
    crate::blocking(|| {
        let home = vibe_home().ok_or("no home folder")?;
        let path = home.join("config.toml");
        let current = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.to_string()),
        };
        let Some(updated) = with_large_4(&current)? else { return Ok(false) };
        std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
        std::fs::write(&path, updated).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
}

/// `config` with Mistral Large 4 registered (and active, if no model is
/// pinned) - `None` when there's nothing to change. Refuses a file it can't
/// parse rather than risk rewriting it.
fn with_large_4(config: &str) -> Result<Option<String>, String> {
    use toml_edit::{value, ArrayOfTables, DocumentMut, Item, Table};

    let mut doc: DocumentMut = config.parse().map_err(|e: toml_edit::TomlError| e.to_string())?;
    let mut changed = false;

    let known = match doc.get("models") {
        None => false,
        Some(Item::ArrayOfTables(models)) => models.iter().any(|m| {
            let alias = m.get("alias").and_then(|v| v.as_str());
            let name = m.get("name").and_then(|v| v.as_str());
            alias.or(name) == Some(LARGE_4_ALIAS)
        }),
        // `[models.<alias>]` - the alias-map form Vibe also reads.
        Some(Item::Table(models)) => models.contains_key(LARGE_4_ALIAS),
        // An inline array or anything else: not a shape to edit by hand.
        Some(_) => return Ok(None),
    };

    if !known {
        let mut entry = Table::new();
        entry["name"] = value(LARGE_4_NAME);
        entry["provider"] = value("mistral");
        entry["alias"] = value(LARGE_4_ALIAS);
        entry["display_name"] = value(LARGE_4_DISPLAY);
        entry["input_price"] = value(LARGE_4_INPUT_PRICE);
        entry["output_price"] = value(LARGE_4_OUTPUT_PRICE);
        entry["cached_input_price"] = value(LARGE_4_CACHED_PRICE);
        entry["supports_images"] = value(true);
        entry["max_context_length"] = value(LARGE_4_CONTEXT);
        match doc.get_mut("models") {
            Some(Item::ArrayOfTables(models)) => models.push(entry),
            Some(Item::Table(models)) => {
                entry.remove("alias");
                models.insert(LARGE_4_ALIAS, Item::Table(entry));
            }
            _ => {
                let mut models = ArrayOfTables::new();
                models.push(entry);
                doc.insert("models", Item::ArrayOfTables(models));
            }
        }
        changed = true;
    }

    let pinned = doc.get("active_model").and_then(|v| v.as_str()).is_some_and(|s| !s.is_empty());
    if !pinned {
        doc["active_model"] = value(LARGE_4_ALIAS);
        changed = true;
    }

    Ok(changed.then(|| doc.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registers_large_4_in_an_empty_config() {
        let out = with_large_4("").unwrap().unwrap();
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["active_model"].as_str(), Some("mistral-large-4"));
        let models = doc["models"].as_array_of_tables().unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models.get(0).unwrap()["name"].as_str(), Some("mistral-large-4"));
    }

    #[test]
    fn keeps_the_users_model_and_file() {
        let config = "# mine\nactive_model = \"mistral-medium-3.5\"\n\n[[models]]\nname = \"x\"\nprovider = \"mistral\"\nalias = \"x\"\n";
        let out = with_large_4(config).unwrap().unwrap();
        assert!(out.starts_with("# mine\nactive_model = \"mistral-medium-3.5\""));
        let doc: toml_edit::DocumentMut = out.parse().unwrap();
        assert_eq!(doc["models"].as_array_of_tables().unwrap().len(), 2);
        // Already there and pinned: nothing more to do.
        assert!(with_large_4(&out).unwrap().is_none());
    }

    #[test]
    fn reads_the_alias_map_form() {
        let config = "active_model = \"mistral-large-4\"\n[models.mistral-large-4]\nname = \"mistral-large-4\"\nprovider = \"mistral\"\n";
        assert!(with_large_4(config).unwrap().is_none());
    }

    #[test]
    fn refuses_an_unparsable_config() {
        assert!(with_large_4("active_model = ").is_err());
    }

    #[test]
    fn reads_a_session_meta() {
        let value = serde_json::json!({
            "session_id": "abc123",
            "parent_session_id": null,
            "title": "Fix the parser",
            "environment": { "working_directory": "C:\\work\\p" },
            "config": { "active_model": "mistral-large-4" },
            "stats": {
                "session_prompt_tokens": 1_000_000,
                "session_completion_tokens": 500_000,
                "session_cached_tokens": 0,
                "input_price_per_million": 0.68,
                "output_price_per_million": 2.09
            }
        });
        let meta = parse_meta(&value, PathBuf::from("x"), Some(5)).unwrap();
        assert_eq!(meta.id, "abc123");
        assert_eq!(meta.tokens, 1_500_000);
        assert!((meta.cost - (0.68 + 2.09 / 2.0)).abs() < 1e-9);
        assert!(!meta.child);
        assert_eq!(meta.cwd.as_deref(), Some("C:\\work\\p"));
    }

    #[test]
    fn sums_spend_per_period() {
        let day = 86_400_000;
        let now = 100 * day + 12 * 3_600_000;
        let meta = |at: u64, cost: f64, child: bool| SessionMeta {
            id: "s".into(),
            title: None,
            cwd: None,
            child,
            updated_at: Some(at),
            cost,
            tokens: 10,
            model: Some("mistral-large-4".into()),
            dir: PathBuf::new(),
        };
        let metas = vec![meta(now - 1000, 1.0, false), meta(now - 1000, 0.5, true), meta(now - 3 * day, 2.0, false), meta(now - 20 * day, 4.0, false)];
        let usage = summarize(&metas, now, utc_midnight(now), true);
        assert!((usage.today.cost - 1.5).abs() < 1e-9);
        assert_eq!(usage.today.sessions, 1);
        assert!((usage.week.cost - 3.5).abs() < 1e-9);
        assert!((usage.month.cost - 7.5).abs() < 1e-9);
        assert_eq!(usage.month.sessions, 3);
        assert_eq!(usage.month.tokens, 40);
    }

    #[test]
    fn finds_the_api_key_in_vibes_env_file() {
        assert!(env_file_has_key("MISTRAL_API_KEY=abc\n", "MISTRAL_API_KEY"));
        assert!(env_file_has_key("export MISTRAL_API_KEY=\"abc\"", "MISTRAL_API_KEY"));
        assert!(!env_file_has_key("MISTRAL_API_KEY=\n", "MISTRAL_API_KEY"));
        assert!(!env_file_has_key("OTHER=1", "MISTRAL_API_KEY"));
    }

    #[test]
    fn tells_a_running_turn_from_a_finished_one() {
        let dir = std::env::temp_dir().join(format!("vibe-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |lines: &str| std::fs::write(dir.join("messages.jsonl"), lines).unwrap();
        write("{\"role\":\"user\",\"content\":\"hi\"}\n{\"role\":\"assistant\",\"content\":\"\",\"tool_calls\":[{\"id\":\"1\"}]}\n{\"role\":\"tool\",\"content\":\"ok\"}\n");
        assert_eq!(turn_open(&dir), Some(true));
        write("{\"role\":\"user\",\"content\":\"hi\"}\n{\"role\":\"assistant\",\"content\":\"done\"}\n");
        assert_eq!(turn_open(&dir), Some(false));
        let _ = std::fs::remove_dir_all(dir);
    }
}
