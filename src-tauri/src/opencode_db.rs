//! Read-only access to OpenCode's sqlite database (`opencode.db`): saved
//! sessions, the live session of a terminal tab, spend, context fill and
//! per-session usage. Nothing is ever written, and every reader is
//! best-effort: a missing database or table, or a column that drifted in a
//! newer OpenCode, logs and yields nothing - never an error for the caller.

use rusqlite::{types::ValueRef, Connection, OpenFlags, Row};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use crate::util::{lock, same_dir};

/// Opens the database read-only; `None` when it doesn't exist or can't be opened.
fn open(db: &Path) -> Option<Connection> {
    if !db.is_file() {
        return None;
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(db, flags) {
        Ok(conn) => {
            let _ = conn.busy_timeout(Duration::from_secs(2));
            Some(conn)
        }
        Err(e) => {
            eprintln!("opencode: could not open {}: {e}", db.display());
            None
        }
    }
}

/// Runs `query` on `db`, logging and returning `fallback` on any failure.
fn with_db<T>(db: &Path, fallback: T, query: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> T {
    let Some(conn) = open(db) else { return fallback };
    match query(&conn) {
        Ok(v) => v,
        Err(e) => {
            // A database without the tables yet (never used) is not worth a log line.
            if !e.to_string().contains("no such table") {
                eprintln!("opencode: query on {} failed: {e}", db.display());
            }
            fallback
        }
    }
}

/// A numeric column as f64 whatever its storage class (NULL and text: 0).
fn f(row: &Row, i: usize) -> f64 {
    match row.get_ref(i) {
        Ok(ValueRef::Integer(n)) => n as f64,
        Ok(ValueRef::Real(x)) if x.is_finite() => x,
        _ => 0.0,
    }
}

fn u(row: &Row, i: usize) -> u64 {
    f(row, i).max(0.0) as u64
}

fn opt_u(row: &Row, i: usize) -> Option<u64> {
    match row.get_ref(i) {
        Ok(ValueRef::Integer(n)) => Some(n.max(0) as u64),
        Ok(ValueRef::Real(x)) if x.is_finite() => Some(x.max(0.0) as u64),
        _ => None,
    }
}

fn text(row: &Row, i: usize) -> Option<String> {
    row.get::<_, Option<String>>(i).ok().flatten().filter(|s| !s.is_empty())
}

/// SQL: the session is working right now.
const BUSY: &str = "(time_busy IS NOT NULL AND (time_idle IS NULL OR time_busy > time_idle))";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

struct SessionRow {
    id: String,
    directory: String,
    title: Option<String>,
    updated_at: Option<u64>,
    busy: bool,
}

fn session_row(row: &Row) -> SessionRow {
    SessionRow {
        id: text(row, 0).unwrap_or_default(),
        directory: text(row, 1).unwrap_or_default(),
        title: text(row, 2),
        updated_at: opt_u(row, 3),
        busy: row.get::<_, i64>(4).unwrap_or(0) != 0,
    }
}

/// Top-level, non-archived sessions, newest first.
fn top_level_sessions(db: &Path, limit: usize) -> Vec<SessionRow> {
    with_db(db, Vec::new(), |conn| {
        let sql = format!(
            "SELECT id, directory, title, time_updated, {BUSY} FROM session_v2 \
             WHERE parent_id IS NULL AND time_archived IS NULL ORDER BY time_updated DESC LIMIT ?1"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map([limit as i64], |r| Ok(session_row(r)))?;
        Ok(rows.filter_map(Result::ok).filter(|s| !s.id.is_empty()).collect())
    })
}

/// Whether the session exists and has at least one user message - what
/// `opencode --session <id>` can resume.
pub(crate) fn session_saved(db: &Path, id: &str) -> bool {
    with_db(db, false, |conn| {
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM session_v2 s WHERE s.id = ?1 AND \
             EXISTS(SELECT 1 FROM session_message m WHERE m.session_id = s.id AND m.type = 'user'))",
            [id],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n != 0)
    })
}

/// The session an `opencode` using database `db` and running in `cwd` is
/// working on: the most recently written top-level session in that folder
/// (other than those in `skip`). Id, title, "busy"/"idle". Like
/// `vibe::live_session_in`: written no earlier than a minute before the
/// process started.
pub(crate) fn live_session_in(
    db: &Path,
    cwd: &str,
    started_at: Option<u64>,
    skip: &HashSet<String>,
) -> Option<(String, Option<String>, &'static str)> {
    let s = top_level_sessions(db, 40).into_iter().find(|s| {
        !skip.contains(&s.id)
            && started_at.is_none_or(|st| s.updated_at.is_none_or(|m| m + 60_000 >= st))
            && same_dir(&s.directory, cwd)
    })?;
    Some((s.id, s.title, if s.busy { "busy" } else { "idle" }))
}

/// One saved OpenCode session for the Agents panel - same shape as Vibe's.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct OpencodeSessionEntry {
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

const MAX_SESSIONS: usize = 8;

fn saved_sessions(db: &Path, profile: Option<&str>) -> Vec<OpencodeSessionEntry> {
    top_level_sessions(db, MAX_SESSIONS * 4)
        .into_iter()
        .filter(|s| crate::agents::is_safe_session_id(&s.id) && !s.directory.is_empty())
        .map(|s| OpencodeSessionEntry {
            cwd: s.directory,
            session_id: s.id,
            started_at: s.updated_at,
            wsl_distro: None,
            name: s.title,
            profile: profile.map(str::to_string),
        })
        .take(MAX_SESSIONS)
        .collect()
}

/// Saved OpenCode sessions across every profile's database, newest first.
/// Same arguments as `list_vibe_sessions` (`fresh` is unused: nothing is cached).
#[tauri::command]
pub async fn list_opencode_sessions(app: tauri::AppHandle, fresh: Option<bool>) -> Result<Vec<OpencodeSessionEntry>, String> {
    let _ = fresh;
    crate::blocking(move || {
        let mut sessions: Vec<OpencodeSessionEntry> = crate::profiles::all_dirs(&app)
            .into_iter()
            .flat_map(|(profile, dirs)| saved_sessions(&dirs.opencode_db, profile.as_deref()))
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.started_at));
        sessions.truncate(MAX_SESSIONS);
        Ok(sessions)
    })
    .await
}

// ---------------------------------------------------------------------------
// Spend
// ---------------------------------------------------------------------------

/// One assistant message's cost.
pub(crate) struct CostCall {
    pub at: u64,
    pub cost: Option<f64>,
    pub tokens: u64,
    pub model: String,
    pub session: String,
}

/// Assistant messages written at or after `since` (ms), sub-agent sessions included.
pub(crate) fn cost_calls(db: &Path, since: u64) -> Vec<CostCall> {
    with_db(db, Vec::new(), |conn| {
        let mut stmt = conn.prepare(
            "SELECT session_id, time_created, json_extract(data,'$.cost'), \
             json_extract(data,'$.tokens.input'), json_extract(data,'$.tokens.output'), \
             json_extract(data,'$.tokens.reasoning'), json_extract(data,'$.tokens.cache.read'), \
             json_extract(data,'$.tokens.cache.write'), json_extract(data,'$.model.id') \
             FROM session_message WHERE type = 'assistant' AND time_created >= ?1",
        )?;
        let rows = stmt.query_map([since as i64], |r| {
            let has_cost = matches!(r.get_ref(2), Ok(ValueRef::Integer(_) | ValueRef::Real(_)));
            Ok(CostCall {
                session: text(r, 0).unwrap_or_default(),
                at: u(r, 1),
                tokens: u(r, 3) + u(r, 4) + u(r, 5) + u(r, 6) + u(r, 7),
                cost: has_cost.then(|| f(r, 2).max(0.0)),
                model: text(r, 8).unwrap_or_else(|| "unknown".into()),
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    })
}

// ---------------------------------------------------------------------------
// Context window and usage of one session
// ---------------------------------------------------------------------------

pub(crate) struct ContextRead {
    pub used: u64,
    pub model: Option<String>,
    pub provider: Option<String>,
}

/// Tokens the latest model call of a session had in its context (input,
/// cache read and write, output - as for Claude) and its model.
pub(crate) fn latest_context(db: &Path, session: &str) -> Option<ContextRead> {
    with_db(db, None, |conn| {
        let mut stmt = conn.prepare(
            "SELECT json_extract(data,'$.tokens.input'), json_extract(data,'$.tokens.output'), \
             json_extract(data,'$.tokens.cache.read'), json_extract(data,'$.tokens.cache.write'), \
             json_extract(data,'$.model.id'), json_extract(data,'$.model.providerID') \
             FROM session_message WHERE session_id = ?1 AND type = 'assistant' \
             AND json_extract(data,'$.tokens') IS NOT NULL ORDER BY time_created DESC, id DESC LIMIT 1",
        )?;
        let mut rows = stmt.query([session])?;
        let Some(r) = rows.next()? else { return Ok(None) };
        Ok(Some(ContextRead { used: u(r, 0) + u(r, 1) + u(r, 2) + u(r, 3), model: text(r, 4), provider: text(r, 5) }))
    })
}

/// Context window of `provider/model` from the models.dev catalog OpenCode
/// caches in its own `kv` table (`models-dev:v2:catalog`, body keyed
/// provider -> models -> model -> limit.context). Answers (misses too) are
/// remembered a while: the catalog is megabytes of JSON.
pub(crate) fn context_limit(db: &Path, provider: &str, model: &str) -> Option<u64> {
    type Cache = HashMap<(PathBuf, String, String), (Instant, Option<u64>)>;
    static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);
    const TTL: Duration = Duration::from_secs(600);
    let ok = |s: &str| !s.is_empty() && s.len() < 200 && !s.contains(['"', '\\']);
    if !ok(provider) || !ok(model) {
        return None;
    }
    let key = (db.to_path_buf(), provider.to_string(), model.to_string());
    if let Some((at, v)) = lock(&CACHE).get(&key) {
        if at.elapsed() < TTL {
            return *v;
        }
    }
    let path = format!("$.\"{provider}\".models.\"{model}\".limit.context");
    let found = with_db(db, None, |conn| {
        // The body is stored as a JSON string (OpenCode decodes it with `fromJsonString`); an object works too.
        let mut stmt = conn.prepare(
            "SELECT CASE json_type(value,'$.body') WHEN 'text' THEN json_extract(json_extract(value,'$.body'), ?1) \
             ELSE json_extract(value, '$.body' || substr(?1, 2)) END FROM kv WHERE key = 'models-dev:v2:catalog'",
        )?;
        let mut rows = stmt.query([&path])?;
        Ok(match rows.next()? {
            Some(r) => opt_u(r, 0).filter(|w| *w > 0),
            None => None,
        })
    });
    crate::util::insert_bounded(&mut lock(&CACHE), key, (Instant::now(), found));
    found
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

/// Cost and tokens of a session and its sub-agent sessions; per-call context sizes of the session itself.
pub(crate) fn session_usage(db: &Path, session: &str, max_turns: usize) -> Option<UsageRead> {
    with_db(db, None, |conn| {
        let (count, mut usage) = conn.query_row(
            "WITH RECURSIVE t(id) AS (SELECT ?1 UNION ALL SELECT s.id FROM session_v2 s JOIN t ON s.parent_id = t.id) \
             SELECT COUNT(*), SUM(cost), SUM(tokens_input), SUM(tokens_output + COALESCE(tokens_reasoning,0)), \
             SUM(tokens_cache_read), SUM(tokens_cache_write) FROM session_v2 WHERE id IN (SELECT id FROM t)",
            [session],
            |r| {
                Ok((
                    u(r, 0),
                    UsageRead {
                        cost: f(r, 1).max(0.0),
                        input: u(r, 2),
                        output: u(r, 3),
                        cache_read: u(r, 4),
                        cache_write: u(r, 5),
                        model: None,
                        turns: Vec::new(),
                    },
                ))
            },
        )?;
        if count == 0 {
            return Ok(None);
        }
        usage.model = conn
            .query_row("SELECT json_extract(model,'$.id') FROM session_v2 WHERE id = ?1", [session], |r| Ok(text(r, 0)))
            .unwrap_or(None);
        let mut stmt = conn.prepare(
            "SELECT json_extract(data,'$.tokens.input') + json_extract(data,'$.tokens.output') \
             + COALESCE(json_extract(data,'$.tokens.cache.read'),0) + COALESCE(json_extract(data,'$.tokens.cache.write'),0) \
             FROM session_message WHERE session_id = ?1 AND type = 'assistant' \
             AND json_extract(data,'$.tokens') IS NOT NULL ORDER BY time_created DESC, id DESC LIMIT ?2",
        )?;
        let turns = stmt.query_map(rusqlite::params![session, max_turns as i64], |r| Ok(u(r, 0)))?;
        let mut turns: Vec<u64> = turns.filter_map(Result::ok).collect();
        turns.reverse();
        usage.turns = turns;
        Ok(Some(usage))
    })
}

// ---------------------------------------------------------------------------
// Config (MCP servers) - JSON with comments
// ---------------------------------------------------------------------------

/// `opencode.jsonc` text as plain JSON: comments and trailing commas removed (strings untouched).
pub(crate) fn strip_jsonc(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let (mut i, mut in_str) = (0, false);
    while i < chars.len() {
        let c = chars[i];
        if in_str {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_str = false;
            }
        } else if c == '"' {
            in_str = true;
            out.push(c);
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            while i < chars.len() && chars[i] != '\n' {
                i += 1;
            }
            continue;
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            i += 2;
            while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
            continue;
        } else if c == ',' {
            let next = chars[i + 1..].iter().find(|c| !c.is_whitespace());
            if !matches!(next, Some('}') | Some(']')) {
                out.push(c);
            }
        } else {
            out.push(c);
        }
        i += 1;
    }
    out
}

/// `<dir>/opencode.json` or `opencode.jsonc`, parsed.
pub(crate) fn read_config(dir: &Path) -> Option<serde_json::Value> {
    ["opencode.json", "opencode.jsonc"].iter().find_map(|name| {
        let raw = std::fs::read_to_string(dir.join(name)).ok()?;
        serde_json::from_str(&strip_jsonc(&raw)).ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::util::now_ms;

    fn temp_db() -> (PathBuf, Connection) {
        let path = std::env::temp_dir().join(format!("opencode-test-{}.db", uuid::Uuid::new_v4()));
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session_v2 (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, slug TEXT,
               cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
               model TEXT, agent TEXT, time_created INTEGER, time_updated INTEGER, time_busy INTEGER, time_idle INTEGER, time_archived INTEGER);
             CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
             CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .unwrap();
        (path, conn)
    }

    #[allow(clippy::too_many_arguments)]
    fn session(c: &Connection, id: &str, parent: Option<&str>, dir: &str, updated: i64, busy: Option<i64>, idle: Option<i64>, archived: Option<i64>, cost: f64) {
        c.execute(
            "INSERT INTO session_v2 (id,parent_id,directory,title,cost,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write,model,time_created,time_updated,time_busy,time_idle,time_archived)
             VALUES (?1,?2,?3,?4,?5,100,50,10,1000,200,'{\"id\":\"claude-x\",\"providerID\":\"anthropic\"}',?6,?6,?7,?8,?9)",
            rusqlite::params![id, parent, dir, format!("t-{id}"), cost, updated, busy, idle, archived],
        )
        .unwrap();
    }

    fn message(c: &Connection, id: &str, session: &str, kind: &str, at: i64, data: &str) {
        c.execute(
            "INSERT INTO session_message (id,session_id,type,seq,time_created,time_updated,data) VALUES (?1,?2,?3,0,?4,?4,?5)",
            rusqlite::params![id, session, kind, at, data],
        )
        .unwrap();
    }

    #[test]
    fn missing_database_or_tables_give_nothing() {
        let nowhere = std::env::temp_dir().join("opencode-nope.db");
        assert!(saved_sessions(&nowhere, None).is_empty());
        assert!(!session_saved(&nowhere, "ses_1"));
        assert!(latest_context(&nowhere, "x").is_none());
        let p = std::env::temp_dir().join(format!("opencode-empty-{}.db", uuid::Uuid::new_v4()));
        Connection::open(&p).unwrap().execute_batch("CREATE TABLE other (a)").unwrap();
        assert!(saved_sessions(&p, None).is_empty());
        assert!(cost_calls(&p, 0).is_empty());
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn lists_top_level_unarchived_sessions_newest_first() {
        let (path, c) = temp_db();
        session(&c, "ses_a", None, "C:\\p\\a", 1000, None, None, None, 0.0);
        session(&c, "ses_b", None, "C:\\p\\b", 3000, Some(3000), None, None, 0.0);
        session(&c, "ses_kid", Some("ses_b"), "C:\\p\\b", 4000, None, None, None, 0.0);
        session(&c, "ses_old", None, "C:\\p\\c", 5000, None, None, Some(5000), 0.0);
        let list = saved_sessions(&path, Some("work"));
        assert_eq!(list.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(), vec!["ses_b", "ses_a"]);
        assert_eq!(list[0].name.as_deref(), Some("t-ses_b"));
        assert_eq!(list[0].profile.as_deref(), Some("work"));
        assert_eq!(list[0].started_at, Some(3000));
        let json = serde_json::to_value(&list[0]).unwrap();
        assert!(json.get("sessionId").is_some() && json.get("startedAt").is_some() && json.get("wslDistro").is_some());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn saved_needs_a_user_message() {
        let (path, c) = temp_db();
        session(&c, "ses_a", None, "/x", 1000, None, None, None, 0.0);
        session(&c, "ses_b", None, "/x", 1000, None, None, None, 0.0);
        message(&c, "msg_1", "ses_b", "user", 1, "{}");
        assert!(!session_saved(&path, "ses_a"));
        assert!(session_saved(&path, "ses_b"));
        assert!(!session_saved(&path, "ses_none"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn live_session_matches_folder_start_and_busy() {
        let (path, c) = temp_db();
        let now = now_ms() as i64;
        session(&c, "ses_busy", None, "/work/app", now, Some(now), Some(now - 500), None, 0.0);
        session(&c, "ses_idle", None, "/work/other", now, Some(now - 10), Some(now), None, 0.0);
        session(&c, "ses_child", Some("ses_busy"), "/work/app", now + 5, None, None, None, 0.0);
        let none = HashSet::new();
        let live = live_session_in(&path, "/work/app", Some(now as u64 - 1000), &none).unwrap();
        assert_eq!((live.0.as_str(), live.2), ("ses_busy", "busy"));
        assert_eq!(live_session_in(&path, "/work/other", None, &none).unwrap().2, "idle");
        // Written long before the process started: an earlier run's.
        assert!(live_session_in(&path, "/work/app", Some(now as u64 + 3_600_000), &none).is_none());
        assert!(live_session_in(&path, "/work/app", None, &HashSet::from(["ses_busy".to_string()])).is_none());
        assert!(live_session_in(&path, "/elsewhere", None, &none).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn spend_context_and_usage() {
        let (path, c) = temp_db();
        session(&c, "ses_a", None, "/x", 1000, None, None, None, 1.5);
        session(&c, "ses_kid", Some("ses_a"), "/x", 1000, None, None, None, 0.5);
        let asst = |cost: &str, input: u64| {
            format!(r#"{{"model":{{"id":"claude-x","providerID":"anthropic"}},{cost}"tokens":{{"input":{input},"output":10,"reasoning":0,"cache":{{"read":100,"write":5}}}},"time":{{"created":1}}}}"#)
        };
        message(&c, "msg_1", "ses_a", "assistant", 100, &asst(r#""cost":0.25,"#, 1000));
        message(&c, "msg_2", "ses_a", "assistant", 200, &asst("", 2000));
        message(&c, "msg_3", "ses_kid", "assistant", 300, &asst(r#""cost":0.5,"#, 10));
        message(&c, "msg_4", "ses_a", "user", 400, "{}");
        let calls = cost_calls(&path, 150);
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().any(|c| c.session == "ses_a" && c.cost.is_none() && c.tokens == 2115));
        assert!(calls.iter().any(|c| c.session == "ses_kid" && c.cost == Some(0.5)));
        let ctx = latest_context(&path, "ses_a").unwrap();
        assert_eq!((ctx.used, ctx.model.as_deref(), ctx.provider.as_deref()), (2115, Some("claude-x"), Some("anthropic")));
        let usage = session_usage(&path, "ses_a", 40).unwrap();
        assert!((usage.cost - 2.0).abs() < 1e-9);
        assert_eq!((usage.input, usage.output, usage.cache_read, usage.cache_write), (200, 120, 2000, 400));
        assert_eq!(usage.turns, vec![1115, 2115]);
        assert_eq!(usage.model.as_deref(), Some("claude-x"));
        assert!(session_usage(&path, "ses_none", 40).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn context_limit_from_cached_catalog() {
        let body = r#"{"anthropic":{"id":"anthropic","models":{"claude-x":{"limit":{"context":200000}},"claude-y.1":{"limit":{"context":1000000}}}}}"#;
        let as_text = serde_json::json!({ "updatedAt": 1, "body": body }).to_string();
        let (empty, _c) = temp_db();
        assert_eq!(context_limit(&empty, "anthropic", "claude-x"), None);
        let (path, c) = temp_db();
        c.execute("INSERT INTO kv (key,value) VALUES ('models-dev:v2:catalog', ?1)", [&as_text]).unwrap();
        assert_eq!(context_limit(&path, "anthropic", "claude-x"), Some(200_000));
        assert_eq!(context_limit(&path, "anthropic", "claude-y.1"), Some(1_000_000));
        assert_eq!(context_limit(&path, "anthropic", "nope"), None);
        assert_eq!(context_limit(&path, "a\"b", "x"), None);
        let as_object = serde_json::json!({ "body": serde_json::from_str::<serde_json::Value>(body).unwrap() }).to_string();
        let (path2, c2) = temp_db();
        c2.execute("INSERT INTO kv (key,value) VALUES ('models-dev:v2:catalog', ?1)", [&as_object]).unwrap();
        assert_eq!(context_limit(&path2, "anthropic", "claude-x"), Some(200_000));
        for p in [empty, path, path2] {
            let _ = std::fs::remove_file(p);
        }
    }

    #[test]
    fn jsonc_is_stripped() {
        let src = "{\n // c\n \"a\": \"x//y,}\", /* b */ \"m\": {\"k\": [1,2,],},\n}";
        let v: serde_json::Value = serde_json::from_str(&strip_jsonc(src)).unwrap();
        assert_eq!(v["a"], "x//y,}");
        assert_eq!(v["m"]["k"], serde_json::json!([1, 2]));
    }
}
