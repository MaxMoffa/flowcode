//! How full the context window of one agent session is, for the usage
//! popover. Both CLIs log it in the session transcript: Claude Code on every
//! assistant message's `usage`, Codex on its `token_count` events (which also
//! carry the model's window). Only the tail of the file is read - a
//! transcript can reach hundreds of megabytes and the latest figure is
//! always near the end.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::util::{has_bytes as has, json_u64 as num, lock};

#[derive(Serialize, Debug, PartialEq, Clone)]
pub struct AgentContext {
    /// Tokens the last model call had in its context (plus what it wrote).
    pub used: u64,
    pub window: u64,
    /// Claude Code doesn't log its window, so it's inferred - see
    /// `claude_window`.
    #[serde(rename = "windowEstimated")]
    pub window_estimated: bool,
    pub model: Option<String>,
}

const CHUNK: u64 = 256 * 1024;
/// A single tool result can fill megabytes of a transcript, so the last
/// assistant message may sit well back from the end.
const MAX_SCAN: u64 = 16 * 1024 * 1024;

const CLAUDE_DEFAULT_WINDOW: u64 = 200_000;
const CLAUDE_LONG_WINDOW: u64 = 1_000_000;

/// The context a Claude Code transcript line reports: a main-thread
/// assistant message's input, cached and output tokens, and its model.
/// Sub-agent (sidechain) messages have contexts of their own and Claude
/// Code's synthetic messages (`<synthetic>`) aren't model calls.
fn parse_claude_context(line: &serde_json::Value) -> Option<(u64, String)> {
    if line.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return None;
    }
    if line.get("isSidechain").and_then(|s| s.as_bool()) == Some(true) {
        return None;
    }
    let message = line.get("message")?;
    let usage = message.get("usage")?;
    let model = message.get("model").and_then(|m| m.as_str())?;
    if model.is_empty() || model.starts_with('<') {
        return None;
    }
    let used = num(usage.get("input_tokens"))
        + num(usage.get("cache_read_input_tokens"))
        + num(usage.get("cache_creation_input_tokens"))
        + num(usage.get("output_tokens"));
    Some((used, model.to_string()))
}

/// Claude Code never logs the window, so: 1M when the model id or the
/// user's configured model says so (`opus[1m]`), or when the session has
/// already outgrown 200K (which only a 1M window allows); 200K otherwise.
fn claude_window(model: &str, configured: Option<&str>, used: u64) -> u64 {
    let long = |m: &str| m.to_lowercase().contains("[1m]");
    if long(model) || configured.is_some_and(long) || used > CLAUDE_DEFAULT_WINDOW {
        CLAUDE_LONG_WINDOW
    } else {
        CLAUDE_DEFAULT_WINDOW
    }
}

/// A Codex rollout line's context: `(used, window)` of a `token_count`
/// event - the last call's total, not the session's running one. Events
/// without `info` (rate-limit updates) have none.
fn parse_codex_token_count(line: &serde_json::Value) -> Option<(u64, Option<u64>)> {
    let payload = line.get("payload")?;
    if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
        return None;
    }
    let info = payload.get("info")?;
    let last = info.get("last_token_usage")?;
    let used = last
        .get("total_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or_else(|| num(last.get("input_tokens")) + num(last.get("output_tokens")));
    let window = info.get("model_context_window").and_then(|v| v.as_u64()).filter(|w| *w > 0);
    Some((used, window))
}

/// The model a Codex `turn_context` line sets.
fn parse_codex_model(line: &serde_json::Value) -> Option<String> {
    if line.get("type").and_then(|t| t.as_str()) != Some("turn_context") {
        return None;
    }
    line.get("payload")?.get("model")?.as_str().map(str::to_string)
}

fn claude_context(path: &Path, configured_model: Option<&str>) -> Option<AgentContext> {
    let (used, model) = crate::agents::scan_lines_backwards(path, CHUNK, MAX_SCAN, |line| {
        // Cheap pre-check so the (often huge) tool-result lines aren't parsed.
        if !has(line, br#""usage""#) || !has(line, br#""assistant""#) {
            return None;
        }
        parse_claude_context(&serde_json::from_slice(line).ok()?)
    })?;
    Some(AgentContext {
        used,
        window: claude_window(&model, configured_model, used),
        window_estimated: true,
        model: Some(model),
    })
}

fn codex_context(path: &Path) -> Option<AgentContext> {
    let mut count: Option<(u64, Option<u64>)> = None;
    let mut model: Option<String> = None;
    crate::agents::scan_lines_backwards(path, CHUNK, MAX_SCAN, |line| {
        if count.is_none() && has(line, br#""token_count""#) {
            count = serde_json::from_slice(line).ok().and_then(|v| parse_codex_token_count(&v));
        } else if model.is_none() && has(line, br#""turn_context""#) {
            model = serde_json::from_slice(line).ok().and_then(|v| parse_codex_model(&v));
        }
        // The model is set once per turn, so it can sit before the last count
        // - keep going until both are known.
        (count.is_some() && model.is_some()).then_some(())
    });
    let (used, window) = count?;
    Some(AgentContext { used, window: window?, window_estimated: false, model })
}

fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `<claude dir>/projects/<encoded cwd>/<id>.jsonl`, found by looking in every
/// project folder rather than re-deriving how Claude Code encodes the cwd.
fn find_claude_transcript(claude_dir: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    std::fs::read_dir(claude_dir.join("projects"))
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

/// The user's configured Claude model (`settings.json` `model`), where a
/// `[1m]` suffix marks the 1M window.
fn claude_configured_model(claude_dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(claude_dir.join("settings.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("model")?.as_str().map(str::to_string)
}

/// A session's file, once found, doesn't move - and finding a Codex one walks
/// the date folders - so it's remembered, keyed by CLI, profile and id.
type PathCache = HashMap<(String, Option<String>, String), PathBuf>;
static PATHS: LazyLock<Mutex<PathCache>> = LazyLock::new(Default::default);

/// The last answer per file, with the file's length when it was read: while
/// the popover polls an idle session nothing is appended, and re-scanning
/// (up to MAX_SCAN backwards) would find the same line again.
type ResultCache = HashMap<PathBuf, (u64, Option<AgentContext>)>;
static RESULTS: LazyLock<Mutex<ResultCache>> = LazyLock::new(Default::default);

/// The message for a transcript that exists but has no usable model call yet.
fn no_usage_error(path: &Path) -> String {
    format!("no model call with usage found in {}", path.display())
}

/// How full the context window of a `cli` (`"claude"` or `"codex"`) session
/// is, read from its transcript. `Err` says why it can't be read: the CLI is
/// unknown, the id isn't a plain one, the transcript can't be found or has no
/// model call yet. `profile` picks the account profile whose folders are read.
#[tauri::command]
pub async fn agent_context(
    app: tauri::AppHandle,
    cli: String,
    session_id: String,
    profile: Option<String>,
) -> Result<Option<AgentContext>, String> {
    crate::blocking(move || read_context(&app, &cli, &session_id, profile)).await
}

/// The body of `agent_context`, synchronous so the remote-access server
/// (remote.rs) can show the same figure per tab; it does file I/O, so call
/// it from a blocking task.
pub(crate) fn read_context(
    app: &tauri::AppHandle,
    cli: &str,
    session_id: &str,
    profile: Option<String>,
) -> Result<Option<AgentContext>, String> {
    // The id ends up in a path.
    if !plain_id(session_id) {
        return Err("invalid session id".into());
    }
    let Some(dirs) = crate::profiles::dirs(app, profile.as_deref()) else {
        return Err(format!("unknown profile {profile:?}"));
    };
    let key = (cli.to_string(), profile, session_id.to_string());
    let cached = lock(&PATHS).get(&key).cloned().filter(|p| p.is_file());
    let path = match cached {
        Some(p) => p,
        None => {
            let found = match cli {
                "claude" => find_claude_transcript(&dirs.claude, session_id),
                "codex" => crate::agents::find_codex_rollout(&dirs.codex.join("sessions"), session_id),
                _ => return Err(format!("unsupported cli {cli}")),
            };
            let Some(found) = found else {
                let searched = if cli == "claude" { dirs.claude.clone() } else { dirs.codex.join("sessions") };
                return Err(format!(
                    "no transcript for {cli} session {session_id} under {}",
                    searched.display()
                ));
            };
            lock(&PATHS).insert(key, found.clone());
            found
        }
    };
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if let Some((at, ctx)) = lock(&RESULTS).get(&path) {
        if *at == len {
            return ctx.clone().map(Some).ok_or_else(|| no_usage_error(&path));
        }
    }
    let ctx = match cli {
        "claude" => claude_context(&path, claude_configured_model(&dirs.claude).as_deref()),
        _ => codex_context(&path),
    };
    lock(&RESULTS).insert(path.clone(), (len, ctx.clone()));
    ctx.map(Some).ok_or_else(|| no_usage_error(&path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn claude_context_sums_input_cache_and_output() {
        let line = json(
            r#"{"type":"assistant","message":{"model":"claude-opus-4-6","usage":{"input_tokens":6,"cache_read_input_tokens":80000,"cache_creation_input_tokens":4000,"output_tokens":994}}}"#,
        );
        assert_eq!(parse_claude_context(&line), Some((85_000, "claude-opus-4-6".to_string())));
    }

    #[test]
    fn claude_context_skips_sidechain_synthetic_and_other_lines() {
        let usage = r#""usage":{"input_tokens":5,"output_tokens":1}"#;
        let side = json(&format!(r#"{{"type":"assistant","isSidechain":true,"message":{{"model":"claude-opus-4-6",{usage}}}}}"#));
        let synthetic = json(&format!(r#"{{"type":"assistant","message":{{"model":"<synthetic>",{usage}}}}}"#));
        let user = json(&format!(r#"{{"type":"user","message":{{"model":"claude-opus-4-6",{usage}}}}}"#));
        let no_usage = json(r#"{"type":"assistant","message":{"model":"claude-opus-4-6"}}"#);
        for line in [side, synthetic, user, no_usage] {
            assert_eq!(parse_claude_context(&line), None);
        }
    }

    #[test]
    fn claude_window_is_long_only_when_indicated() {
        assert_eq!(claude_window("claude-opus-4-6", None, 85_000), 200_000);
        assert_eq!(claude_window("claude-opus-4-6", Some("opus"), 85_000), 200_000);
        assert_eq!(claude_window("claude-opus-4-6", Some("opus[1m]"), 85_000), 1_000_000);
        assert_eq!(claude_window("claude-opus-4-6[1m]", None, 10), 1_000_000);
        assert_eq!(claude_window("claude-opus-4-6", None, 250_000), 1_000_000);
    }

    #[test]
    fn codex_token_count_reads_last_call_and_window() {
        let line = json(
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":900000},"last_token_usage":{"input_tokens":84000,"output_tokens":1000,"total_tokens":85000},"model_context_window":258400}}}"#,
        );
        assert_eq!(parse_codex_token_count(&line), Some((85_000, Some(258_400))));
        let no_total = json(
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":70,"output_tokens":5}}}}"#,
        );
        assert_eq!(parse_codex_token_count(&no_total), Some((75, None)));
        // A rate-limit-only event has no `info`.
        let limits = json(r#"{"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}"#);
        assert_eq!(parse_codex_token_count(&limits), None);
        let other = json(r#"{"type":"event_msg","payload":{"type":"agent_message"}}"#);
        assert_eq!(parse_codex_token_count(&other), None);
    }

    #[test]
    fn codex_model_comes_from_turn_context() {
        let line = json(r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#);
        assert_eq!(parse_codex_model(&line), Some("gpt-5.5".to_string()));
        assert_eq!(parse_codex_model(&json(r#"{"type":"session_meta","payload":{"model":"x"}}"#)), None);
    }

    #[test]
    fn reads_the_tail_of_a_codex_rollout() {
        let path = std::env::temp_dir().join(format!("context-test-{}.jsonl", uuid::Uuid::new_v4()));
        let lines = [
            r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":10},"model_context_window":258400}}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"total_tokens":20},"model_context_window":258400}}}"#,
        ];
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        let ctx = codex_context(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(
            ctx,
            AgentContext { used: 20, window: 258_400, window_estimated: false, model: Some("gpt-5.5".to_string()) }
        );
    }

    #[test]
    fn only_plain_ids_reach_a_path() {
        assert!(plain_id("0199a1b2-c3d4_e5"));
        assert!(!plain_id(""));
        assert!(!plain_id("../x"));
        assert!(!plain_id("a/b"));
    }
}
