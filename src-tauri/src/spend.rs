//! Pay-per-use spend for Claude Code and Codex CLI, for when they run on an
//! API key instead of a subscription: there's no usage limit to show then,
//! only what the work cost. Neither CLI keeps a running total anywhere, but
//! both log every model call's token counts in their session transcripts -
//! Claude Code under `~/.claude/projects/**/*.jsonl` (each assistant
//! message's `usage`), Codex under `~/.codex/sessions/**/rollout-*.jsonl`
//! (`token_count` events with the session's running total). Summed here and
//! priced with the vendors' public list prices, so it's an estimate: a
//! negotiated rate, a partner platform's own pricing (Bedrock, Vertex) or a
//! session run on another machine isn't reflected. Mistral Vibe records its
//! own cost per session instead - see vibe.rs.
//!
//! Transcripts only ever grow and can reach hundreds of megabytes, so each
//! file is read incrementally: what was already parsed stays cached (by
//! path) along with how far it got, and only new lines are read on the next
//! poll.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

const DAY_MS: u64 = 86_400_000;

#[derive(Serialize, Default, Clone, Copy)]
pub struct SpendPeriod {
    /// USD.
    pub cost: f64,
    pub tokens: u64,
    pub sessions: u32,
}

#[derive(Serialize)]
pub struct CliSpend {
    today: SpendPeriod,
    week: SpendPeriod,
    month: SpendPeriod,
    /// The model of the most recent call.
    #[serde(rename = "lastModel")]
    last_model: Option<String>,
    /// Models used in the last 30 days that have no known price - their
    /// tokens are counted, their cost isn't.
    #[serde(rename = "unpricedModels")]
    unpriced_models: Vec<String>,
}

/// One model call: when, what it cost (`None`: unknown model), its tokens,
/// and the session it belongs to.
#[derive(Clone)]
struct Call {
    at: u64,
    cost: Option<f64>,
    tokens: u64,
    model: String,
    session: String,
}

/// List prices, USD per million tokens. `cache_write` is the 5-minute
/// write; the 1-hour write is 2x input (Anthropic's rule).
#[derive(Clone, Copy)]
struct Price {
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
}

const fn anthropic(input: f64, output: f64, cache_read: f64) -> Price {
    Price { input, output, cache_read, cache_write: input * 1.25 }
}

/// Anthropic first-party prices by model id prefix - longest prefix wins,
/// so a dated id (`claude-sonnet-4-5-20250929`) finds its family.
const CLAUDE_PRICES: &[(&str, Price)] = &[
    ("claude-fable-5-1", anthropic(10.0, 50.0, 0.25)),
    ("claude-mythos-5-1", anthropic(10.0, 50.0, 0.25)),
    ("claude-fable-5", anthropic(10.0, 50.0, 1.0)),
    ("claude-mythos-5", anthropic(10.0, 50.0, 1.0)),
    ("claude-opus-5-5", anthropic(4.0, 20.0, 0.20)),
    ("claude-opus-5", anthropic(5.0, 25.0, 0.50)),
    ("claude-opus-4-8", anthropic(5.0, 25.0, 0.50)),
    ("claude-opus-4-7", anthropic(5.0, 25.0, 0.50)),
    ("claude-opus-4-6", anthropic(5.0, 25.0, 0.50)),
    ("claude-opus-4-5", anthropic(5.0, 25.0, 0.50)),
    ("claude-opus-4-1", anthropic(15.0, 75.0, 1.50)),
    ("claude-opus-4", anthropic(15.0, 75.0, 1.50)),
    ("claude-sonnet-5-5", anthropic(2.0, 10.0, 0.20)),
    ("claude-sonnet-5", anthropic(2.0, 10.0, 0.20)),
    ("claude-sonnet-4", anthropic(3.0, 15.0, 0.30)),
    ("claude-haiku-4-5", anthropic(1.0, 5.0, 0.10)),
    ("claude-3-5-haiku", anthropic(0.8, 4.0, 0.08)),
];

const fn openai(input: f64, cache_read: f64, output: f64) -> Price {
    Price { input, output, cache_read, cache_write: input }
}

/// OpenAI standard-tier prices by model id (developers.openai.com pricing).
/// Codex variants (`gpt-5.1-codex-max`, `gpt-5.2-codex`...) not listed on
/// their own are priced as their base model - see `codex_price`.
const OPENAI_PRICES: &[(&str, Price)] = &[
    ("gpt-6-astra", openai(10.0, 1.0, 50.0)),
    ("gpt-6.1-sol", openai(2.0, 0.10, 10.0)),
    ("gpt-6-sol", openai(2.0, 0.20, 10.0)),
    ("gpt-6-luna", openai(0.10, 0.01, 0.50)),
    ("gpt-5.6-sol", openai(4.0, 0.40, 20.0)),
    ("gpt-5.6-terra", openai(2.0, 0.20, 12.0)),
    ("gpt-5.6-luna", openai(0.20, 0.02, 1.20)),
    ("gpt-5.5", openai(5.0, 0.50, 30.0)),
    ("gpt-5.4-mini", openai(0.75, 0.075, 4.50)),
    ("gpt-5.4-nano", openai(0.20, 0.02, 1.25)),
    ("gpt-5.4", openai(2.50, 0.25, 15.0)),
    ("gpt-5.3-codex", openai(1.75, 0.175, 14.0)),
    ("gpt-5.2", openai(1.75, 0.175, 14.0)),
    ("gpt-5.1", openai(1.25, 0.125, 10.0)),
    ("gpt-5-mini", openai(0.25, 0.025, 2.0)),
    ("gpt-5-nano", openai(0.05, 0.005, 0.40)),
    ("gpt-5", openai(1.25, 0.125, 10.0)),
    ("o4-mini", openai(1.10, 0.275, 4.40)),
    ("o3", openai(2.0, 0.50, 8.0)),
];

fn by_prefix(table: &[(&str, Price)], model: &str) -> Option<Price> {
    table
        .iter()
        .filter(|(prefix, _)| model.starts_with(prefix))
        .max_by_key(|(prefix, _)| prefix.len())
        .map(|(_, price)| *price)
}

fn claude_price(model: &str) -> Option<Price> {
    by_prefix(CLAUDE_PRICES, &model.to_lowercase())
}

/// A Codex model's price: listed as is (`gpt-5.3-codex`), else as its base
/// model - a `-codex-mini` as that generation's mini, any other `-codex...`
/// as the model it's tuned from (`gpt-5.1-codex-max` -> `gpt-5.1`).
fn codex_price(model: &str) -> Option<Price> {
    let model = model.to_lowercase();
    let exact = |id: &str| OPENAI_PRICES.iter().find(|(listed, _)| *listed == id).map(|(_, price)| *price);
    if let Some(price) = exact(&model) {
        return Some(price);
    }
    if let Some(base) = model.split("-codex").next().filter(|b| *b != model) {
        if model.contains("-codex-mini") {
            return exact(&format!("{base}-mini")).or_else(|| exact("gpt-5-mini"));
        }
        return by_prefix(OPENAI_PRICES, base);
    }
    by_prefix(OPENAI_PRICES, &model)
}

/// Milliseconds since the epoch of an RFC 3339 timestamp
/// (`2026-10-06T21:05:03.123Z`, or with a `+02:00` offset).
fn parse_timestamp(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> { s.get(from..from + len)?.parse().ok() };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || (b[10] != b'T' && b[10] != b' ') {
        return None;
    }
    let (year, month, day) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hour, minute, second) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut rest = &s[19..];
    let mut millis = 0i64;
    if let Some(frac) = rest.strip_prefix('.') {
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        millis = format!("{digits:0<3}")[..3].parse().ok()?;
        rest = &frac[digits.len()..];
    }
    let offset_min = match rest.as_bytes().first() {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let h: i64 = rest.get(1..3)?.parse().ok()?;
            let m: i64 = rest.get(4..6).or_else(|| rest.get(3..5))?.parse().ok()?;
            (h * 60 + m) * if *sign == b'-' { -1 } else { 1 }
        }
        _ => return None,
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset_min * 60;
    u64::try_from(secs * 1000 + millis).ok()
}

/// What's been read of one transcript so far.
#[derive(Default)]
struct FileScan {
    /// Bytes parsed - always just after a complete line.
    offset: u64,
    calls: Vec<Call>,
    /// Claude Code: message ids already counted (a message's usage can be
    /// logged on several lines, one per content block).
    seen: HashSet<String>,
    /// Codex: the session's running totals at the last `token_count`
    /// (input, cached input, output), its model and id.
    totals: [u64; 3],
    model: Option<String>,
    session: Option<String>,
}

type ParseLine = fn(&mut FileScan, &serde_json::Value);
/// A cheap check on a raw line before it's parsed as JSON: most lines are
/// conversation content with no token counts in them.
type LineFilter = fn(&str) -> bool;

fn claude_filter(line: &str) -> bool {
    line.contains("\"usage\"")
}

/// `token_count` lines, plus the two that set the session's id and model.
fn codex_filter(line: &str) -> bool {
    line.contains("token_count") || line.contains("\"turn_context\"") || line.contains("\"session_meta\"")
}

static CACHE: LazyLock<Mutex<HashMap<PathBuf, FileScan>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// The calls logged in `path`, reading only what was appended since the
/// last time. A file that shrank (rewritten) is read again from the start.
fn calls_in(path: &Path, wanted: LineFilter, parse: ParseLine) -> Vec<Call> {
    let mut cache = CACHE.lock().unwrap();
    let scan = cache.entry(path.to_path_buf()).or_default();
    let Ok(mut file) = std::fs::File::open(path) else { return scan.calls.clone() };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    if len < scan.offset {
        *scan = FileScan::default();
    }
    if len > scan.offset && file.seek(SeekFrom::Start(scan.offset)).is_ok() {
        let mut buf = Vec::with_capacity((len - scan.offset) as usize);
        if file.take(len - scan.offset).read_to_end(&mut buf).is_ok() {
            // Up to the last complete line - a line still being written is
            // read next time, whole.
            let complete = buf.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
            for line in buf[..complete].split(|&b| b == b'\n') {
                let Ok(text) = std::str::from_utf8(line) else { continue };
                if !wanted(text) {
                    continue;
                }
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
                    parse(scan, &value);
                }
            }
            scan.offset += complete as u64;
        }
    }
    scan.calls.clone()
}

fn num(value: Option<&serde_json::Value>) -> u64 {
    value.and_then(|v| v.as_u64()).unwrap_or(0)
}

/// One Claude Code transcript line: an assistant message's `usage`.
fn parse_claude_line(scan: &mut FileScan, line: &serde_json::Value) {
    if line.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return;
    }
    let Some(message) = line.get("message") else { return };
    let Some(usage) = message.get("usage") else { return };
    let model = message.get("model").and_then(|m| m.as_str()).unwrap_or_default();
    // Not a model call: a message Claude Code wrote itself (errors, notices).
    if model.is_empty() || model.starts_with('<') {
        return;
    }
    let id = message.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let request = line.get("requestId").and_then(|v| v.as_str()).unwrap_or_default();
    if !id.is_empty() && !scan.seen.insert(format!("{id}:{request}")) {
        return;
    }
    let Some(at) = line.get("timestamp").and_then(|t| t.as_str()).and_then(parse_timestamp) else { return };
    let input = num(usage.get("input_tokens"));
    let output = num(usage.get("output_tokens"));
    let cache_read = num(usage.get("cache_read_input_tokens"));
    let cache_write = num(usage.get("cache_creation_input_tokens"));
    // The write split by TTL, when logged: a 1-hour write costs 2x input.
    let breakdown = usage.get("cache_creation");
    let write_1h = num(breakdown.and_then(|b| b.get("ephemeral_1h_input_tokens"))).min(cache_write);
    let write_5m = cache_write - write_1h;
    let cost = claude_price(model).map(|p| {
        (input as f64 * p.input
            + output as f64 * p.output
            + cache_read as f64 * p.cache_read
            + write_5m as f64 * p.cache_write
            + write_1h as f64 * p.input * 2.0)
            / 1_000_000.0
    });
    scan.calls.push(Call {
        at,
        cost,
        tokens: input + output + cache_read + cache_write,
        model: model.to_string(),
        session: line.get("sessionId").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
    });
}

/// One Codex rollout line: the session's id and model as they're set, and
/// the growth of its token totals at each `token_count` - its running
/// total, not each event's own figure, so a repeated event never counts
/// twice.
fn parse_codex_line(scan: &mut FileScan, line: &serde_json::Value) {
    let kind = line.get("type").and_then(|t| t.as_str()).unwrap_or_default();
    let payload = line.get("payload");
    let text = |v: Option<&serde_json::Value>| v.and_then(|v| v.as_str()).map(str::to_string);
    match kind {
        "session_meta" => scan.session = text(payload.and_then(|p| p.get("id"))),
        "turn_context" => {
            if let Some(model) = text(payload.and_then(|p| p.get("model"))) {
                scan.model = Some(model);
            }
        }
        "event_msg" if payload.and_then(|p| p.get("type")).and_then(|t| t.as_str()) == Some("token_count") => {
            let Some(total) = payload.and_then(|p| p.get("info")).and_then(|i| i.get("total_token_usage")) else {
                return;
            };
            let now = [
                num(total.get("input_tokens")),
                num(total.get("cached_input_tokens")),
                num(total.get("output_tokens")),
            ];
            let delta: Vec<u64> = now.iter().zip(scan.totals).map(|(n, p)| n.saturating_sub(p)).collect();
            scan.totals = now;
            let (input, cached, output) = (delta[0], delta[1].min(delta[0]), delta[2]);
            if input + output == 0 {
                return;
            }
            let Some(at) = line.get("timestamp").and_then(|t| t.as_str()).and_then(parse_timestamp) else { return };
            let model = scan.model.clone().unwrap_or_default();
            // Cached input is part of `input_tokens`, billed at its own rate.
            let cost = codex_price(&model).map(|p| {
                ((input - cached) as f64 * p.input + cached as f64 * p.cache_read + output as f64 * p.output) / 1_000_000.0
            });
            scan.calls.push(Call {
                at,
                cost,
                tokens: input + output,
                model,
                session: scan.session.clone().unwrap_or_default(),
            });
        }
        _ => {}
    }
}

/// Files under `dir` (to `depth` levels) whose name passes `wanted`,
/// written within the last 31 days - older ones can't add to any period.
fn recent_files(dir: &Path, depth: u8, wanted: fn(&str) -> bool, since: u64, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            recent_files(&path, depth - 1, wanted, since, out);
        } else if path.file_name().and_then(|n| n.to_str()).is_some_and(wanted)
            && crate::fs::system_time_to_millis(meta.modified()).is_some_and(|m| m >= since)
        {
            out.push(path);
        }
    }
}

fn summarize(calls: &[Call], now: u64, today_start: u64) -> CliSpend {
    let mut periods = [SpendPeriod::default(); 3];
    let mut sessions: [HashSet<&str>; 3] = Default::default();
    let mut unpriced: Vec<String> = Vec::new();
    let mut last: Option<&Call> = None;
    for call in calls {
        let age = now.saturating_sub(call.at);
        if age >= 30 * DAY_MS {
            continue;
        }
        if last.is_none_or(|l| call.at > l.at) {
            last = Some(call);
        }
        if call.cost.is_none() && !unpriced.contains(&call.model) {
            unpriced.push(call.model.clone());
        }
        let within = [call.at >= today_start, age < 7 * DAY_MS, true];
        for (i, inside) in within.into_iter().enumerate() {
            if inside {
                periods[i].cost += call.cost.unwrap_or(0.0);
                periods[i].tokens += call.tokens;
                sessions[i].insert(call.session.as_str());
            }
        }
    }
    for (period, ids) in periods.iter_mut().zip(&sessions) {
        period.sessions = ids.len() as u32;
    }
    CliSpend {
        today: periods[0],
        week: periods[1],
        month: periods[2],
        last_model: last.map(|c| c.model.clone()),
        unpriced_models: unpriced,
    }
}

fn now_ms() -> u64 {
    crate::fs::system_time_to_millis(Ok(std::time::SystemTime::now())).unwrap_or(0)
}

/// Claude Code's config folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`.
fn claude_home() -> Option<PathBuf> {
    match std::env::var_os("CLAUDE_CONFIG_DIR").filter(|v| !v.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => Some(crate::fs::user_home()?.join(".claude")),
    }
}

/// Codex's home: `$CODEX_HOME`, else `~/.codex`.
fn codex_home() -> Option<PathBuf> {
    match std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => Some(crate::fs::user_home()?.join(".codex")),
    }
}

/// Spend of an agent CLI on this machine - `cli` is `"claude"` or
/// `"codex"` - today (from the frontend's local midnight, `today_start`)
/// and over the last 7 / 30 days. See the module docs for what it counts.
#[tauri::command]
pub async fn cli_spend(cli: String, today_start: Option<u64>) -> Result<CliSpend, String> {
    crate::blocking(move || {
        let now = now_ms();
        let today = today_start.filter(|t| *t <= now).unwrap_or(now - now % DAY_MS);
        let since = now.saturating_sub(31 * DAY_MS);
        let mut files = Vec::new();
        let (filter, parse): (LineFilter, ParseLine) = match cli.as_str() {
            "claude" => {
                if let Some(home) = claude_home() {
                    recent_files(&home.join("projects"), 5, |n| n.ends_with(".jsonl"), since, &mut files);
                }
                (claude_filter, parse_claude_line)
            }
            "codex" => {
                if let Some(home) = codex_home() {
                    recent_files(&home.join("sessions"), 5, |n| n.starts_with("rollout-") && n.ends_with(".jsonl"), since, &mut files);
                }
                (codex_filter, parse_codex_line)
            }
            _ => return Err(format!("unknown CLI: {cli}")),
        };
        let calls: Vec<Call> = files.iter().flat_map(|f| calls_in(f, filter, parse)).collect();
        Ok(summarize(&calls, now, today))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_timestamps() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_timestamp("1970-01-02T00:00:01.5Z"), Some(DAY_MS + 1500));
        assert_eq!(parse_timestamp("2026-10-06T21:05:03.123Z"), Some(1_791_320_703_123));
        assert_eq!(parse_timestamp("2026-10-06T23:05:03.123+02:00"), Some(1_791_320_703_123));
        assert_eq!(parse_timestamp("not a date"), None);
    }

    #[test]
    fn prices_models_by_family() {
        assert_eq!(claude_price("claude-sonnet-4-5-20250929").map(|p| p.input), Some(3.0));
        assert_eq!(claude_price("claude-opus-4-1-20250805").map(|p| p.input), Some(15.0));
        assert_eq!(claude_price("claude-opus-5-5").map(|p| p.cache_read), Some(0.20));
        assert!(claude_price("claude-unknown-9").is_none());
        assert_eq!(codex_price("gpt-5.3-codex").map(|p| p.output), Some(14.0));
        assert_eq!(codex_price("gpt-5.1-codex-max").map(|p| p.input), Some(1.25));
        assert_eq!(codex_price("gpt-5.1-codex-mini").map(|p| p.input), Some(0.25));
        assert_eq!(codex_price("gpt-5.2-codex").map(|p| p.input), Some(1.75));
        assert_eq!(codex_price("gpt-5.5").map(|p| p.input), Some(5.0));
        assert!(codex_price("some-other-model").is_none());
    }

    fn write(lines: &[&str]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("spend-test-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    #[test]
    fn sums_claude_usage_once_per_message() {
        let line = |id: &str| {
            format!(
                r#"{{"type":"assistant","sessionId":"s1","requestId":"r-{id}","timestamp":"2026-10-06T10:00:00Z","message":{{"id":"{id}","model":"claude-sonnet-4-6","usage":{{"input_tokens":1000000,"output_tokens":100000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
            )
        };
        let (a, b) = (line("m1"), line("m2"));
        // m1 logged twice (two content blocks), plus a synthetic message.
        let synthetic = r#"{"type":"assistant","timestamp":"2026-10-06T10:00:00Z","message":{"id":"x","model":"<synthetic>","usage":{"input_tokens":5}}}"#;
        let path = write(&[&a, &a, &b, synthetic, r#"{"type":"user","message":{"content":"hi"}}"#]);
        let calls = calls_in(&path, claude_filter, parse_claude_line);
        assert_eq!(calls.len(), 2);
        assert!((calls[0].cost.unwrap() - (3.0 + 1.5)).abs() < 1e-9);
        // Appended later: only the new line is read.
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .and_then(|mut f| std::io::Write::write_all(&mut f, (line("m3") + "\n").as_bytes()))
            .unwrap();
        assert_eq!(calls_in(&path, claude_filter, parse_claude_line).len(), 3);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn counts_codex_token_growth() {
        let count = |input: u64, cached: u64, output: u64| {
            format!(
                r#"{{"timestamp":"2026-10-06T10:00:00Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"output_tokens":{output},"reasoning_output_tokens":0,"total_tokens":0}}}}}}}}"#
            )
        };
        let path = write(&[
            r#"{"timestamp":"2026-10-06T09:59:00Z","type":"session_meta","payload":{"id":"t1","cwd":"/x"}}"#,
            r#"{"timestamp":"2026-10-06T09:59:00Z","type":"turn_context","payload":{"model":"gpt-5.5","cwd":"/x"}}"#,
            &count(1_000_000, 0, 0),
            // Repeated with nothing new (a rate-limit update): no new call.
            &count(1_000_000, 0, 0),
            &count(2_000_000, 1_000_000, 100_000),
        ]);
        let calls = calls_in(&path, codex_filter, parse_codex_line);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].session, "t1");
        // 1M input at $5; then 1M cached at $0.50 + 100K output at $30/M.
        assert!((calls[0].cost.unwrap() - 5.0).abs() < 1e-9);
        assert!((calls[1].cost.unwrap() - (0.5 + 3.0)).abs() < 1e-9);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn sums_periods_and_sessions() {
        let now = 100 * DAY_MS + 12 * 3_600_000;
        let call = |at: u64, cost: Option<f64>, session: &str| Call {
            at,
            cost,
            tokens: 10,
            model: if cost.is_some() { "m".into() } else { "unknown".into() },
            session: session.into(),
        };
        let calls = vec![
            call(now - 1000, Some(1.0), "a"),
            call(now - 2000, Some(1.0), "a"),
            call(now - 3 * DAY_MS, Some(2.0), "b"),
            call(now - 20 * DAY_MS, None, "c"),
            call(now - 40 * DAY_MS, Some(9.0), "d"),
        ];
        let spend = summarize(&calls, now, now - now % DAY_MS);
        assert!((spend.today.cost - 2.0).abs() < 1e-9);
        assert_eq!(spend.today.sessions, 1);
        assert!((spend.week.cost - 4.0).abs() < 1e-9);
        assert_eq!(spend.month.sessions, 3);
        assert_eq!(spend.month.tokens, 40);
        assert_eq!(spend.unpriced_models, vec!["unknown".to_string()]);
        assert_eq!(spend.last_model.as_deref(), Some("m"));
    }
}
