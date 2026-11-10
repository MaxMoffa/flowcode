//! The "goal" of a chat: an objective the agent pursues across turns, set with
//! `/goal <objective>`. The ACP adapters don't report it, so Flowcode reads it
//! where the agent keeps it - Claude's session transcript, Codex's goals
//! database - and the views get it as a `_flowcode/goal` event.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

/// How much of the end of a transcript is scanned.
const TAIL: u64 = 4 << 20;
/// How long an optimistic state wins over what the agent's files say.
const PENDING_TTL: Duration = Duration::from_secs(20);
/// Longest objective Codex accepts.
const CODEX_MAX_OBJECTIVE: usize = 4000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Goal {
    pub objective: String,
    /// `active`, `paused`, `limited`, `blocked`, `complete` or `failed`.
    pub status: &'static str,
    /// When it was set, ms since the epoch.
    pub set_at: Option<u64>,
    pub iterations: Option<u64>,
    pub duration_ms: Option<u64>,
    pub tokens: Option<u64>,
    pub reason: Option<String>,
}

impl Goal {
    fn new(objective: String, status: &'static str) -> Goal {
        Goal { objective, status, set_at: None, iterations: None, duration_ms: None, tokens: None, reason: None }
    }

    /// Whether the goal can still change by itself.
    pub fn is_live(&self) -> bool {
        matches!(self.status, "active" | "paused" | "limited" | "blocked")
    }

    /// Same as far as a view shows it (duration and tokens aside).
    fn same_shown(&self, other: &Goal) -> bool {
        self.objective == other.objective && self.status == other.status && self.iterations == other.iterations && self.reason == other.reason
    }
}

/// The goal actions the agent's `_session/goal` accepts.
pub(crate) fn actions(agent: &str) -> &'static [&'static str] {
    match agent {
        "claude" => &["clear"],
        "codex" => &["pause", "resume", "clear"],
        _ => &[],
    }
}

pub(crate) fn supported(agent: &str) -> bool {
    !actions(agent).is_empty()
}

/// What a `/goal ...` prompt asks for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum PromptGoal {
    Set(String),
    Clear,
    Pause,
    Resume,
}

pub(crate) fn parse_prompt(agent: &str, text: &str) -> Option<PromptGoal> {
    if !supported(agent) {
        return None;
    }
    let rest = text.trim().strip_prefix("/goal")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let arg = rest.trim();
    if arg.is_empty() {
        return None;
    }
    match (agent, arg.to_lowercase().as_str()) {
        ("claude", "clear" | "stop" | "off" | "reset" | "none" | "cancel") => Some(PromptGoal::Clear),
        ("codex", "clear") => Some(PromptGoal::Clear),
        ("codex", "pause") => Some(PromptGoal::Pause),
        ("codex", "resume") => Some(PromptGoal::Resume),
        ("codex", _) if arg.chars().count() > CODEX_MAX_OBJECTIVE => None,
        _ => Some(PromptGoal::Set(arg.to_string())),
    }
}

/// The goal as the agent keeps it. Outer `None`: unknown (couldn't read);
/// `Some(None)`: no goal.
pub(crate) fn read(app: &AppHandle, agent: &str, session_id: &str, profile: Option<&str>, wsl_distro: Option<&str>) -> Option<Option<Goal>> {
    if !crate::context::plain_id(session_id) {
        return None;
    }
    let wsl = wsl_distro.filter(|d| !d.is_empty());
    match agent {
        "claude" => {
            let dir = match wsl {
                Some(distro) => {
                    let home = crate::util::wsl_home(distro)?;
                    crate::util::wsl_unc(distro, &format!("{home}/.claude"))
                }
                None => crate::profiles::dirs(app, profile)?.claude,
            };
            let path = crate::context::find_claude_transcript(&dir, session_id)?;
            claude_goal_from_tail(&read_tail(&path)?)
        }
        "codex" => {
            let dir = match wsl {
                Some(distro) => {
                    let home = crate::util::wsl_home(distro)?;
                    crate::util::wsl_unc(distro, &format!("{home}/.codex"))
                }
                None => crate::profiles::dirs(app, profile)?.codex,
            };
            codex_goal(&goals_db(&dir)?, session_id)
        }
        _ => None,
    }
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.take(TAIL).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    // A cut tail starts mid-line.
    Some(if start > 0 { text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default() } else { text })
}

/// Reads the `goal_status` lines of a transcript tail in order. Outer `None`:
/// there are none.
fn claude_goal_from_tail(text: &str) -> Option<Option<Goal>> {
    let mut found = false;
    let mut state: Option<Goal> = None;
    for line in text.lines() {
        if !line.contains("goal_status") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(att) = v.get("attachment").filter(|a| a.get("type").and_then(Value::as_str) == Some("goal_status")) else { continue };
        found = true;
        let flag = |k: &str| att.get(k).and_then(Value::as_bool).unwrap_or(false);
        let num = |k: &str| att.get(k).and_then(Value::as_u64);
        let text_of = |k: &str| att.get(k).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
        let condition = text_of("condition");
        let (sentinel, met, failed) = (flag("sentinel"), flag("met"), flag("failed"));
        if sentinel {
            state = if met {
                None
            } else {
                let at = v.get("timestamp").and_then(Value::as_str).and_then(crate::agents::claude_history::parse_rfc3339_ms);
                let mut g = Goal::new(condition.unwrap_or_default(), "active");
                g.set_at = at;
                g.iterations = Some(0);
                Some(g)
            };
            continue;
        }
        let mut g = state.take().unwrap_or_else(|| Goal::new(String::new(), "active"));
        if let Some(c) = condition {
            if g.objective.is_empty() {
                g.objective = c;
            }
        }
        g.reason = text_of("reason");
        if met {
            g.status = "complete";
        } else if failed {
            g.status = "failed";
        } else {
            g.status = "active";
            g.iterations = Some(g.iterations.unwrap_or(0) + 1);
        }
        if g.status != "active" {
            g.iterations = num("iterations").or(g.iterations);
            g.duration_ms = num("durationMs");
            g.tokens = num("tokens");
        }
        state = Some(g);
    }
    found.then_some(state)
}

/// The newest `goals_<n>.sqlite` in a Codex home.
fn goals_db(dir: &Path) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(n) = name.strip_prefix("goals_").and_then(|r| r.strip_suffix(".sqlite")).and_then(|n| n.parse::<u64>().ok()) else { continue };
        if best.as_ref().is_none_or(|(b, _)| n > *b) {
            best = Some((n, entry.path()));
        }
    }
    best.map(|(_, p)| p)
}

fn codex_goal(db: &Path, thread_id: &str) -> Option<Option<Goal>> {
    if !db.is_file() {
        return None;
    }
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    let _ = conn.busy_timeout(Duration::from_secs(2));
    let mut stmt = conn
        .prepare("SELECT objective, status, tokens_used, time_used_seconds, created_at_ms FROM thread_goals WHERE thread_id = ?1")
        .ok()?;
    let mut rows = stmt.query([thread_id]).ok()?;
    let Some(row) = rows.next().ok()? else { return Some(None) };
    let objective: String = row.get(0).ok()?;
    let status: String = row.get(1).ok()?;
    let n = |i: usize| row.get::<_, Option<i64>>(i).ok().flatten().filter(|v| *v >= 0).map(|v| v as u64);
    let mut g = Goal::new(
        objective,
        match status.as_str() {
            "active" => "active",
            "paused" => "paused",
            "blocked" => "blocked",
            "usage_limited" | "budget_limited" => "limited",
            "complete" => "complete",
            _ => return None,
        },
    );
    g.tokens = n(2);
    g.duration_ms = n(3).map(|s| s * 1000);
    g.set_at = n(4);
    Some(Some(g))
}

/// What the user just asked for, until the agent's files catch up.
#[derive(Debug)]
struct Expect {
    objective: Option<String>,
    status: Option<&'static str>,
}

/// What a chat has told its views about the goal.
#[derive(Default)]
pub(crate) struct GoalTrack {
    last: Option<Goal>,
    pending: Option<(Expect, Instant)>,
}

impl GoalTrack {
    /// Whether the poll has a reason to look.
    pub fn wants_poll(&self) -> bool {
        self.pending.is_some() || self.last.as_ref().is_some_and(Goal::is_live)
    }

    /// The user asked for `p`: the goal to show right away (`Some(None)`: show no goal).
    pub fn optimistic(&mut self, p: &PromptGoal, now_ms: u64) -> Option<Option<Goal>> {
        let (goal, expect) = match p {
            PromptGoal::Set(obj) => {
                let mut g = Goal::new(obj.clone(), "active");
                g.set_at = Some(now_ms);
                (Some(g), Expect { objective: Some(obj.clone()), status: None })
            }
            PromptGoal::Clear => (None, Expect { objective: None, status: None }),
            PromptGoal::Pause | PromptGoal::Resume => {
                let status = if *p == PromptGoal::Pause { "paused" } else { "active" };
                let mut g = self.last.clone()?;
                g.status = status;
                let objective = g.objective.clone();
                (Some(g), Expect { objective: Some(objective), status: Some(status) })
            }
        };
        self.pending = Some((expect, Instant::now()));
        self.last = goal.clone();
        Some(goal)
    }

    /// The first read of a chat (a resumed session): a goal that already ended
    /// is history, not news - it is remembered without being shown, so neither
    /// the chip nor a "reached" marker reappears at every resume.
    pub fn prime(&mut self, read: Option<Option<Goal>>) -> Option<Option<Goal>> {
        if let Some(Some(goal)) = &read {
            if !goal.is_live() && self.last.is_none() && self.pending.is_none() {
                self.last = Some(goal.clone());
                return None;
            }
        }
        self.apply(read)
    }

    /// A fresh read of the agent's state (`None`: unknown): what to emit, if anything.
    pub fn apply(&mut self, read: Option<Option<Goal>>) -> Option<Option<Goal>> {
        let read = read?;
        if let Some((expect, since)) = &self.pending {
            let agrees = read.as_ref().map(|g| &g.objective) == expect.objective.as_ref()
                && expect.status.is_none_or(|s| read.as_ref().is_some_and(|g| g.status == s));
            if agrees {
                self.pending = None;
            } else if since.elapsed() < PENDING_TTL {
                return None;
            } else {
                self.pending = None;
            }
        }
        let differs = match (&self.last, &read) {
            (None, None) => false,
            (Some(a), Some(b)) => !a.same_shown(b),
            _ => true,
        };
        if !differs {
            return None;
        }
        self.last = read.clone();
        Some(read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(ts: &str, side: bool, att: &str) -> String {
        format!(r#"{{"type":"attachment","isSidechain":{side},"timestamp":"{ts}","attachment":{att}}}"#)
    }
    fn set(ts: &str, cond: &str) -> String {
        line(ts, false, &format!(r#"{{"type":"goal_status","met":false,"sentinel":true,"condition":"{cond}"}}"#))
    }
    fn join(lines: &[String]) -> String {
        lines.join("\n")
    }

    #[test]
    fn prompts_parse() {
        assert_eq!(parse_prompt("claude", "/goal ship it"), Some(PromptGoal::Set("ship it".into())));
        assert_eq!(parse_prompt("claude", "  /goal   Stop \n"), Some(PromptGoal::Clear));
        assert_eq!(parse_prompt("claude", "/goal pause"), Some(PromptGoal::Set("pause".into())));
        assert_eq!(parse_prompt("claude", "/goal"), None);
        assert_eq!(parse_prompt("claude", "/goal   "), None);
        assert_eq!(parse_prompt("claude", "/goals x"), None);
        assert_eq!(parse_prompt("claude", "hello /goal x"), None);
        assert_eq!(parse_prompt("codex", "/goal PAUSE"), Some(PromptGoal::Pause));
        assert_eq!(parse_prompt("codex", "/goal resume"), Some(PromptGoal::Resume));
        assert_eq!(parse_prompt("codex", "/goal clear"), Some(PromptGoal::Clear));
        assert_eq!(parse_prompt("codex", "/goal stop"), Some(PromptGoal::Set("stop".into())));
        assert_eq!(parse_prompt("codex", &format!("/goal {}", "x".repeat(4001))), None);
        assert_eq!(parse_prompt("gemini", "/goal x"), None);
        assert!(actions("opencode").is_empty());
    }

    #[test]
    fn claude_set_and_iterations() {
        let unmet = line("2026-10-16T14:25:00.000Z", false, r#"{"type":"goal_status","met":false,"reason":"tests fail"}"#);
        let t = join(&[set("2026-10-16T14:24:29.404Z", "make it green"), unmet.clone(), unmet]);
        let g = claude_goal_from_tail(&t).unwrap().unwrap();
        assert_eq!((g.status, g.objective.as_str(), g.iterations), ("active", "make it green", Some(2)));
        assert_eq!(g.set_at, crate::agents::claude_history::parse_rfc3339_ms("2026-10-16T14:24:29.404Z"));
        assert!(g.set_at.is_some());
        assert_eq!(g.reason.as_deref(), Some("tests fail"));
    }

    #[test]
    fn claude_complete_failed_cleared() {
        let done = line("2026-10-16T15:00:00.000Z", false, r#"{"type":"goal_status","met":true,"reason":"ok","iterations":3,"durationMs":5000,"tokens":900}"#);
        let g = claude_goal_from_tail(&join(&[set("2026-10-16T14:24:29.404Z", "x"), done])).unwrap().unwrap();
        assert_eq!((g.status, g.iterations, g.duration_ms, g.tokens), ("complete", Some(3), Some(5000), Some(900)));
        assert_eq!(g.objective, "x");
        let failed = line("2026-10-16T15:00:00.000Z", false, r#"{"type":"goal_status","met":false,"failed":true,"reason":"impossible"}"#);
        let g = claude_goal_from_tail(&join(&[set("2026-10-16T14:24:29.404Z", "x"), failed])).unwrap().unwrap();
        assert_eq!(g.status, "failed");
        let cleared = line("2026-10-16T15:00:00.000Z", false, r#"{"type":"goal_status","met":true,"sentinel":true,"condition":"x"}"#);
        assert_eq!(claude_goal_from_tail(&join(&[set("2026-10-16T14:24:29.404Z", "x"), cleared])), Some(None));
    }

    #[test]
    fn claude_ignores_noise_and_sidechains() {
        assert_eq!(claude_goal_from_tail(""), None);
        assert_eq!(claude_goal_from_tail("{\"type\":\"user\"}\nnot json goal_status"), None);
        let side = line("2026-10-16T14:24:29.404Z", true, r#"{"type":"goal_status","met":false,"sentinel":true,"condition":"side"}"#);
        assert_eq!(claude_goal_from_tail(&side), None);
        let t = join(&[set("2026-10-16T14:24:29.404Z", "main"), side]);
        assert_eq!(claude_goal_from_tail(&t).unwrap().unwrap().objective, "main");
    }

    #[test]
    fn codex_reads_the_row() {
        let path = std::env::temp_dir().join(format!("goals-test-{}.sqlite", uuid::Uuid::new_v4()));
        let c = Connection::open(&path).unwrap();
        c.execute_batch(
            "CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY, goal_id TEXT, objective TEXT, status TEXT CHECK(status IN ('active','paused','blocked','usage_limited','budget_limited','complete')), token_budget INTEGER, tokens_used INTEGER, time_used_seconds INTEGER, created_at_ms INTEGER, updated_at_ms INTEGER);
             INSERT INTO thread_goals VALUES ('t1','g','do it','usage_limited',NULL,500,12,1000,2000);",
        )
        .unwrap();
        let g = codex_goal(&path, "t1").unwrap().unwrap();
        assert_eq!((g.status, g.tokens, g.duration_ms, g.set_at), ("limited", Some(500), Some(12_000), Some(1000)));
        assert_eq!(codex_goal(&path, "t2"), Some(None));
        assert_eq!(codex_goal(&std::env::temp_dir().join("goals-nope.sqlite"), "t1"), None);
        drop(c);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn track_optimism_and_diff() {
        let mut t = GoalTrack::default();
        assert_eq!(t.apply(Some(None)), None);
        let shown = t.optimistic(&PromptGoal::Set("a".into()), 5).unwrap().unwrap();
        assert_eq!(shown.set_at, Some(5));
        // The old state is ignored while pending.
        assert_eq!(t.apply(Some(None)), None);
        let mut real = Goal::new("a".into(), "active");
        real.iterations = Some(1);
        assert_eq!(t.apply(Some(Some(real.clone()))), Some(Some(real)));
        assert!(t.pending.is_none());
        assert_eq!(t.apply(None), None);
    }

    #[test]
    fn prime_keeps_an_old_ended_goal_quiet() {
        let mut t = GoalTrack::default();
        let done = Goal::new("old".into(), "complete");
        assert_eq!(t.prime(Some(Some(done.clone()))), None);
        // Nothing moved: still quiet.
        assert_eq!(t.apply(Some(Some(done))), None);
        // A live goal on resume is shown.
        let mut t = GoalTrack::default();
        let live = Goal::new("now".into(), "active");
        assert_eq!(t.prime(Some(Some(live.clone()))), Some(Some(live)));
    }
}
