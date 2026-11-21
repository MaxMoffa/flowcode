//! Read-only access to Cline's local state (`<CLINE_DIR>/data`): the sqlite
//! `db/sessions.db` (saved sessions, the live session of a terminal tab,
//! spend) and each session's `sessions/<id>/<id>.messages.json` (context fill,
//! per-call sizes). Nothing is ever written, and every reader is best-effort:
//! a missing file or table, or a column that drifted in a newer Cline, logs and
//! yields nothing - never an error for the caller.
//!
//! Sub-agent rows (`is_subagent = 1`) are never listed; their cost reaches
//! the totals through the parent's `aggregateUsage`.

use rusqlite::{types::ValueRef, Connection, OpenFlags, Row};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::util::same_dir;

/// `<home>/data/db/sessions.db`
pub(crate) fn db_path(home: &Path) -> PathBuf {
    home.join("data").join("db").join("sessions.db")
}

fn messages_path(home: &Path, id: &str) -> PathBuf {
    home.join("data").join("sessions").join(id).join(format!("{id}.messages.json"))
}

fn open(home: &Path) -> Option<Connection> {
    let db = db_path(home);
    if !db.is_file() {
        return None;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(&db, flags) {
        Ok(conn) => {
            let _ = conn.busy_timeout(Duration::from_secs(2));
            Some(conn)
        }
        Err(e) => {
            eprintln!("cline: could not open {}: {e}", db.display());
            None
        }
    }
}

fn with_db<T>(home: &Path, fallback: T, query: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    let Some(conn) = open(home) else { return fallback };
    match query(&conn) {
        Ok(v) => v,
        Err(e) => {
            if !e.to_string().contains("no such table") {
                eprintln!("cline: query on {} failed: {e}", db_path(home).display());
            }
            fallback
        }
    }
}

fn text(row: &Row, i: usize) -> Option<String> {
    row.get::<_, Option<String>>(i).ok().flatten().filter(|s| !s.is_empty())
}

fn opt_u(row: &Row, i: usize) -> Option<u64> {
    match row.get_ref(i) {
        Ok(ValueRef::Integer(n)) => Some(n.max(0) as u64),
        Ok(ValueRef::Real(x)) if x.is_finite() => Some(x.max(0.0) as u64),
        _ => None,
    }
}

/// SQL: an ISO timestamp column as epoch milliseconds.
fn ms(col: &str) -> String {
    format!("CAST((julianday({col}) - 2440587.5) * 86400000 AS INTEGER)")
}

/// `<user_input mode="act">TEXT</user_input>` -> `TEXT`; one line, trimmed.
fn clean_title(raw: &str) -> Option<String> {
    let mut s = raw.trim();
    if s.starts_with("<user_input") {
        if let Some(open_end) = s.find('>') {
            s = &s[open_end + 1..];
            s = s.strip_suffix("</user_input>").unwrap_or(s);
        }
    }
    let one: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let one: String = one.chars().take(120).collect();
    Some(one).filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

struct SessionRow {
    id: String,
    cwd: String,
    title: Option<String>,
    /// Last write (ms).
    at: Option<u64>,
    busy: bool,
}

const COLS: &str = "session_id, COALESCE(NULLIF(workspace_root,''), cwd), metadata_json, prompt, status";

fn session_row(row: &Row, at_col: usize) -> SessionRow {
    let meta = text(row, 2).and_then(|m| serde_json::from_str::<serde_json::Value>(&m).ok());
    let title = meta
        .as_ref()
        .and_then(|m| m.get("title"))
        .and_then(|t| t.as_str())
        .and_then(clean_title)
        .or_else(|| text(row, 3).and_then(|p| clean_title(&p)));
    SessionRow {
        id: text(row, 0).unwrap_or_default(),
        cwd: text(row, 1).unwrap_or_default(),
        title,
        at: opt_u(row, at_col),
        busy: text(row, 4).as_deref() == Some("running"),
    }
}

/// Top-level sessions that have a prompt, most recently written first.
fn top_level_sessions(home: &Path, limit: usize) -> Vec<SessionRow> {
    with_db(home, Vec::new(), |conn| {
        let at = ms("COALESCE(updated_at, started_at)");
        let sql = format!(
            "SELECT {COLS}, {at} FROM sessions WHERE COALESCE(is_subagent,0) = 0 \
             AND prompt IS NOT NULL AND prompt != '' ORDER BY COALESCE(updated_at, started_at) DESC LIMIT ?1"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([limit as i64], |r| Ok(session_row(r, 5)))?;
        Ok(rows.filter_map(Result::ok).filter(|s| !s.id.is_empty()).collect())
    })
}

fn read_messages(home: &Path, id: &str) -> Option<serde_json::Value> {
    const MAX: u64 = 128 * 1024 * 1024;
    let path = messages_path(home, id);
    if std::fs::metadata(&path).ok()?.len() > MAX {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn assistants(doc: &serde_json::Value) -> impl Iterator<Item = &serde_json::Value> {
    doc.get("messages")
        .and_then(|m| m.as_array())
        .into_iter()
        .flatten()
        .filter(|m| m.get("role").and_then(|r| r.as_str()) == Some("assistant"))
}

fn n(v: Option<&serde_json::Value>) -> u64 {
    v.and_then(|v| v.as_f64()).filter(|x| x.is_finite()).map_or(0, |x| x.max(0.0) as u64)
}

/// Tokens in play on one assistant message: input + cache read + cache write.
fn context_of(m: &serde_json::Value) -> Option<u64> {
    let metrics = m.get("metrics")?;
    Some(n(metrics.get("inputTokens")) + n(metrics.get("cacheReadTokens")) + n(metrics.get("cacheWriteTokens")))
}

/// Whether the session has at least one assistant message (a turn to resume).
pub(crate) fn session_saved(home: &Path, id: &str) -> bool {
    read_messages(home, id).is_some_and(|doc| assistants(&doc).next().is_some())
}

/// The session a `cline` process (`pid`, running in `cwd`, started at
/// `started_at` ms) is working on: the newest top-level session written by
/// that pid, else the newest one in that folder written no earlier than a
/// minute before the process started. Not any in `skip`.
pub(crate) fn live_session_in(
    home: &Path,
    pid: u32,
    cwd: &str,
    started_at: Option<u64>,
    skip: &HashSet<String>,
) -> Option<(String, Option<String>, &'static str)> {
    let by_pid: Vec<String> = with_db(home, Vec::new(), |conn| {
        let mut stmt = conn.prepare(
            "SELECT session_id FROM sessions WHERE pid = ?1 AND COALESCE(is_subagent,0) = 0 \
             ORDER BY COALESCE(updated_at, started_at) DESC LIMIT 10",
        )?;
        let ids = stmt.query_map([pid as i64], |r| Ok(text(r, 0)))?;
        Ok(ids.filter_map(Result::ok).flatten().collect())
    });
    let all = top_level_sessions(home, 40);
    let found = by_pid
        .iter()
        .find(|id| !skip.contains(*id))
        .and_then(|id| all.iter().find(|s| s.id == *id))
        .or_else(|| {
            all.iter().find(|s| {
                !skip.contains(&s.id)
                    && started_at.is_none_or(|st| s.at.is_none_or(|m| m + 60_000 >= st))
                    && same_dir(&s.cwd, cwd)
            })
        })?;
    Some((found.id.clone(), found.title.clone(), if found.busy { "busy" } else { "idle" }))
}

/// One saved Cline session for the Agents panel - same shape as Vibe's.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ClineSessionEntry {
    cwd: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    /// When it last wrote (ms).
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
    /// Always `None`: sessions inside WSL are not read.
    #[serde(rename = "wslDistro")]
    wsl_distro: Option<String>,
    name: Option<String>,
    profile: Option<String>,
}

/// Same budget as Claude/Codex: the frontend filters per project afterwards.
const MAX_SESSIONS: usize = 200;

fn saved_sessions(home: &Path, profile: Option<&str>) -> Vec<ClineSessionEntry> {
    top_level_sessions(home, MAX_SESSIONS * 2)
        .into_iter()
        .filter(|s| crate::agents::is_safe_session_id(&s.id) && !s.cwd.is_empty())
        .map(|s| ClineSessionEntry {
            cwd: s.cwd,
            session_id: s.id,
            started_at: s.at,
            wsl_distro: None,
            name: s.title,
            profile: profile.map(str::to_string),
        })
        .take(MAX_SESSIONS)
        .collect()
}

/// Saved Cline sessions across every profile, newest first. Same arguments as
/// `list_vibe_sessions` (`fresh` is unused: nothing is cached).
#[tauri::command]
pub async fn list_cline_sessions(app: tauri::AppHandle, fresh: Option<bool>) -> Result<Vec<ClineSessionEntry>, String> {
    let _ = fresh;
    crate::blocking(move || {
        let mut sessions: Vec<ClineSessionEntry> = crate::profiles::all_dirs(&app)
            .into_iter()
            .flat_map(|(profile, dirs)| saved_sessions(&dirs.cline, profile.as_deref()))
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.started_at));
        sessions.truncate(MAX_SESSIONS);
        Ok(sessions)
    })
    .await
}

// ---------------------------------------------------------------------------
// Spend and usage
// ---------------------------------------------------------------------------

/// Cost and tokens of a session as Cline recorded them: `aggregateUsage`
/// (sub-agents included), else `usage`, else the bare `totalCost`.
struct Recorded {
    cost: f64,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
}

fn recorded(meta: &serde_json::Value) -> Recorded {
    let usage = ["aggregateUsage", "usage"].iter().find_map(|k| meta.get(*k).filter(|u| u.is_object()));
    let cost = usage
        .and_then(|u| u.get("totalCost"))
        .or_else(|| meta.get("totalCost"))
        .and_then(|c| c.as_f64())
        .filter(|c| c.is_finite())
        .unwrap_or(0.0)
        .max(0.0);
    let g = |k: &str| n(usage.and_then(|u| u.get(k)));
    Recorded { cost, input: g("inputTokens"), output: g("outputTokens"), cache_read: g("cacheReadTokens"), cache_write: g("cacheWriteTokens") }
}

/// One top-level session's cost, placed at its last write.
pub(crate) struct CostCall {
    pub at: u64,
    pub cost: f64,
    pub tokens: u64,
    pub model: String,
    pub session: String,
}

/// Top-level sessions written at or after `since` (ms).
pub(crate) fn cost_calls(home: &Path, since: u64) -> Vec<CostCall> {
    with_db(home, Vec::new(), |conn| {
        let at = ms("COALESCE(updated_at, started_at)");
        let sql = format!(
            "SELECT session_id, {at}, metadata_json, model FROM sessions \
             WHERE COALESCE(is_subagent,0) = 0 AND {at} >= ?1"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([since as i64], |r| {
            let meta = text(r, 2).and_then(|m| serde_json::from_str::<serde_json::Value>(&m).ok());
            let rec = meta.as_ref().map(recorded);
            Ok(CostCall {
                session: text(r, 0).unwrap_or_default(),
                at: opt_u(r, 1).unwrap_or(0),
                cost: rec.as_ref().map_or(0.0, |x| x.cost),
                tokens: rec.as_ref().map_or(0, |x| x.input + x.output),
                model: text(r, 3).unwrap_or_else(|| "unknown".into()),
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    })
}

pub(crate) struct ContextRead {
    pub used: u64,
    pub model: Option<String>,
}

/// Context the last assistant message had (see `context_of`) and its model.
pub(crate) fn latest_context(home: &Path, id: &str) -> Option<ContextRead> {
    let doc = read_messages(home, id)?;
    let last = assistants(&doc).filter(|m| m.get("metrics").is_some()).last()?;
    Some(ContextRead {
        used: context_of(last)?,
        model: last.get("modelInfo").and_then(|m| m.get("id")).and_then(|i| i.as_str()).map(str::to_string),
    })
}

pub(crate) struct UsageRead {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
    pub model: Option<String>,
    /// Context size of each of the last model calls, oldest first.
    pub turns: Vec<u64>,
}

/// Cost and tokens of a session (sub-agents included) and the per-call context sizes of the session itself.
pub(crate) fn session_usage(home: &Path, id: &str, max_turns: usize) -> Option<UsageRead> {
    let (meta, model) = with_db(home, None, |conn| {
        conn.query_row("SELECT metadata_json, model FROM sessions WHERE session_id = ?1", [id], |r| {
            Ok(Some((text(r, 0).and_then(|m| serde_json::from_str::<serde_json::Value>(&m).ok()), text(r, 1))))
        })
    })?;
    let rec = recorded(&meta.unwrap_or(serde_json::Value::Null));
    let mut turns: Vec<u64> = read_messages(home, id)
        .map(|doc| {
            assistants(&doc)
                .filter_map(|m| Some(context_of(m)? + n(m.get("metrics")?.get("outputTokens"))))
                .collect()
        })
        .unwrap_or_default();
    let skip = turns.len().saturating_sub(max_turns);
    turns.drain(..skip);
    Some(UsageRead { input: rec.input, output: rec.output, cache_read: rec.cache_read, cache_write: rec.cache_write, cost: rec.cost, model, turns })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::now_ms;

    fn temp_home() -> (PathBuf, Connection) {
        let home = std::env::temp_dir().join(format!("cline-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(home.join("data").join("db")).unwrap();
        let conn = Connection::open(db_path(&home)).unwrap();
        conn.execute_batch(
            "CREATE TABLE sessions (session_id TEXT PRIMARY KEY, source TEXT, pid INTEGER, started_at TEXT, ended_at TEXT,
               status TEXT, provider TEXT, model TEXT, cwd TEXT, workspace_root TEXT, parent_session_id TEXT,
               is_subagent INTEGER, prompt TEXT, metadata_json TEXT, updated_at TEXT);",
        )
        .unwrap();
        (home, conn)
    }

    fn iso(ms: u64) -> String {
        let secs = (ms / 1000) as i64;
        let days = secs.div_euclid(86400);
        let rem = secs.rem_euclid(86400);
        // civil from days (Howard Hinnant)
        let z = days + 719468;
        let era = z.div_euclid(146097);
        let doe = z.rem_euclid(146097);
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = doy - (153 * mp + 2) / 5 + 1;
        let m = if mp < 10 { mp + 3 } else { mp - 9 };
        let y = yoe + era * 400 + i64::from(m <= 2);
        format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
    }

    #[allow(clippy::too_many_arguments)]
    fn session(c: &Connection, id: &str, pid: i64, cwd: &str, sub: i64, status: &str, prompt: &str, meta: &str, at: u64) {
        c.execute(
            "INSERT INTO sessions (session_id, pid, started_at, status, model, cwd, is_subagent, prompt, metadata_json, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'm1', ?5, ?6, ?7, ?8, ?3)",
            rusqlite::params![id, pid, iso(at), status, cwd, sub, prompt, meta],
        )
        .unwrap();
    }

    fn messages(home: &Path, id: &str, body: &str) {
        let dir = home.join("data").join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}.messages.json")), body).unwrap();
    }

    #[test]
    fn missing_database_gives_nothing() {
        let home = std::env::temp_dir().join(format!("cline-none-{}", uuid::Uuid::new_v4()));
        assert!(top_level_sessions(&home, 5).is_empty());
        assert!(!session_saved(&home, "x"));
        assert!(live_session_in(&home, 1, "C:/x", None, &HashSet::new()).is_none());
        assert!(cost_calls(&home, 0).is_empty());
        assert!(session_usage(&home, "x", 5).is_none());
    }

    #[test]
    fn lists_top_level_with_clean_titles() {
        let (home, c) = temp_home();
        let now = now_ms();
        session(&c, "a", 1, "C:\\p", 0, "idle", "<user_input mode=\"act\">Fix  the\nbug</user_input>", "{}", now - 5000);
        session(&c, "b", 1, "C:\\p", 0, "completed", "x", r#"{"title":"Named"}"#, now - 1000);
        session(&c, "a__agent_1", 1, "C:\\p", 1, "completed", "sub", "{}", now);
        session(&c, "empty", 1, "C:\\p", 0, "idle", "", "{}", now);
        let list = saved_sessions(&home, Some("work"));
        let ids: Vec<_> = list.iter().map(|s| s.session_id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(list[0].name.as_deref(), Some("Named"));
        assert_eq!(list[1].name.as_deref(), Some("Fix the bug"));
        assert_eq!(list[1].profile.as_deref(), Some("work"));
        assert!(list[0].started_at.unwrap().abs_diff(now - 1000) < 2000);
    }

    #[test]
    fn saved_needs_an_assistant_message() {
        let (home, _c) = temp_home();
        messages(&home, "u", r#"{"messages":[{"role":"user","content":[]}]}"#);
        messages(&home, "a", r#"{"messages":[{"role":"user"},{"role":"assistant"}]}"#);
        assert!(!session_saved(&home, "u"));
        assert!(session_saved(&home, "a"));
        assert!(!session_saved(&home, "none"));
    }

    #[test]
    fn live_session_by_pid_then_folder() {
        let (home, c) = temp_home();
        let now = now_ms();
        session(&c, "old", 7, "C:\\p", 0, "idle", "x", "{}", now - 3_600_000);
        session(&c, "run", 7, "C:\\p", 0, "running", "x", "{}", now - 1000);
        session(&c, "other", 8, "C:\\q", 0, "idle", "x", "{}", now - 500);
        session(&c, "run__agent_1", 7, "C:\\p", 1, "running", "x", "{}", now);
        let skip = HashSet::new();
        let live = live_session_in(&home, 7, "C:/elsewhere", None, &skip).unwrap();
        assert_eq!((live.0.as_str(), live.2), ("run", "busy"));
        // Unknown pid: falls back to folder + start time.
        assert_eq!(live_session_in(&home, 99, "c:/q/", Some(now - 60_000), &skip).unwrap().0, "other");
        assert!(live_session_in(&home, 99, "C:/q", Some(now + 3_600_000), &skip).is_none());
        let skip: HashSet<String> = ["run".to_string()].into();
        assert_eq!(live_session_in(&home, 7, "C:/p", None, &skip).unwrap().0, "old");
    }

    #[test]
    fn spend_context_and_usage() {
        let (home, c) = temp_home();
        let now = now_ms();
        let meta = r#"{"totalCost":0.5,"usage":{"inputTokens":10,"outputTokens":5,"totalCost":0.5},"aggregateUsage":{"inputTokens":100,"outputTokens":50,"cacheReadTokens":7,"cacheWriteTokens":3,"totalCost":1.25}}"#;
        session(&c, "s", 1, "C:\\p", 0, "idle", "x", meta, now - 1000);
        session(&c, "s__agent_1", 1, "C:\\p", 1, "completed", "x", meta, now - 1000);
        session(&c, "old", 1, "C:\\p", 0, "idle", "x", r#"{"totalCost":9}"#, now - 40 * 86_400_000);
        let calls = cost_calls(&home, now - 31 * 86_400_000);
        assert_eq!(calls.len(), 1);
        assert_eq!((calls[0].cost, calls[0].tokens, calls[0].session.as_str()), (1.25, 150, "s"));
        // Bare totalCost fallback.
        assert_eq!(recorded(&serde_json::json!({"totalCost": 0.02})).cost, 0.02);

        messages(
            &home,
            "s",
            r#"{"messages":[{"role":"user"},
              {"role":"assistant","modelInfo":{"id":"claude-x"},"metrics":{"inputTokens":10,"outputTokens":2,"cacheReadTokens":5,"cacheWriteTokens":1}},
              {"role":"assistant","modelInfo":{"id":"claude-y"},"metrics":{"inputTokens":20,"outputTokens":4,"cacheReadTokens":30,"cacheWriteTokens":0}}]}"#,
        );
        let ctx = latest_context(&home, "s").unwrap();
        assert_eq!((ctx.used, ctx.model.as_deref()), (50, Some("claude-y")));
        let usage = session_usage(&home, "s", 1).unwrap();
        assert_eq!((usage.cost, usage.input, usage.cache_read, usage.cache_write), (1.25, 100, 7, 3));
        assert_eq!((usage.turns.as_slice(), usage.model.as_deref()), (&[54u64][..], Some("m1")));
        assert!(session_usage(&home, "missing", 5).is_none());
    }
}
