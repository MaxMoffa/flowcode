//! Read-only peeks into what an agent session is made of, for the usage
//! popover: which MCP servers, skills and memory files the CLI loads
//! (`agent_tools`), and the tokens and list-price cost one session has used so
//! far (`agent_session_usage`). Everything is read from the CLIs' own files
//! (config, skills folders, session transcripts); nothing is written, and no
//! secret (env vars, headers, tokens, URL credentials) is ever returned.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::util::{has_bytes as has, json_u64 as num, lock};

/// One MCP server the CLI would start or connect to. `target` is the command
/// line or the URL (without query string or credentials) - never env or headers.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    /// `"user"` or `"project"`.
    pub scope: String,
    /// `"stdio"`, `"http"` or `"sse"`.
    pub transport: String,
    pub target: String,
}

/// One skill, with the rough size of what it adds to every prompt (its name
/// and description are always in the context; the body is loaded on demand).
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    /// `"user"` or `"project"`.
    pub scope: String,
    pub est_tokens: u64,
}

#[derive(Serialize, Debug, Default, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentTools {
    pub mcp: Vec<McpServer>,
    pub skills: Vec<SkillInfo>,
    /// Characters in the memory files (`CLAUDE.md`, `AGENTS.md`...) found.
    pub memory_chars: u64,
    pub memory_files: Vec<String>,
}

#[derive(Serialize, Debug, Default, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// The context size (input + cache read + cache write + output) of each
    /// model call - the last `MAX_TURNS`, oldest first.
    pub turns: Vec<u64>,
    /// USD at list price; `None` when a model seen has no known price.
    pub cost: Option<f64>,
    pub model: Option<String>,
}

const MAX_TURNS: usize = 40;
/// Past this a transcript isn't read at all (the popover polls it).
const MAX_TRANSCRIPT: u64 = 200 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Tools: MCP servers, skills, memory
// ---------------------------------------------------------------------------

/// A URL without its query string, fragment and `user:pass@` part - those
/// are where tokens usually sit.
fn sanitize_url(url: &str) -> String {
    let url = url.trim();
    let end = url.find(|c: char| c == '?' || c == '#').unwrap_or(url.len());
    let url = &url[..end];
    match url.find("://") {
        Some(i) => {
            let (scheme, rest) = url.split_at(i + 3);
            let auth_end = rest.find('/').unwrap_or(rest.len());
            let (auth, path) = rest.split_at(auth_end);
            let host = auth.rsplit('@').next().unwrap_or(auth);
            format!("{scheme}{host}{path}")
        }
        None => url.to_string(),
    }
}

/// The servers of an `mcpServers` JSON object (Claude Code's `.claude.json`
/// and `.mcp.json` shape), appended to `out` unless the same name is already
/// there for that scope.
fn mcp_from_json(servers: Option<&serde_json::Value>, scope: &str, out: &mut Vec<McpServer>) {
    let Some(map) = servers.and_then(|s| s.as_object()) else { return };
    for (name, def) in map {
        if !def.is_object() || out.iter().any(|m| m.name == *name && m.scope == scope) {
            continue;
        }
        let url = def.get("url").and_then(|u| u.as_str()).filter(|u| !u.is_empty());
        let declared = def.get("type").and_then(|t| t.as_str()).unwrap_or_default().to_lowercase();
        let transport = match declared.as_str() {
            "sse" => "sse",
            "http" | "streamable-http" | "streamable_http" => "http",
            "stdio" => "stdio",
            _ if url.is_some() => "http",
            _ => "stdio",
        };
        let target = match url {
            Some(u) if transport != "stdio" => sanitize_url(u),
            _ => {
                let mut parts: Vec<String> = Vec::new();
                if let Some(cmd) = def.get("command").and_then(|c| c.as_str()) {
                    parts.push(cmd.to_string());
                }
                if let Some(args) = def.get("args").and_then(|a| a.as_array()) {
                    parts.extend(args.iter().filter_map(|a| a.as_str()).map(str::to_string));
                }
                parts.join(" ")
            }
        };
        out.push(McpServer { name: name.clone(), scope: scope.to_string(), transport: transport.to_string(), target });
    }
}

/// The `[mcp_servers.<name>]` tables of a Codex `config.toml`. Env and
/// headers sub-tables are never looked at. An invalid file gives nothing.
fn mcp_from_codex_toml(text: &str) -> Vec<McpServer> {
    let mut out = Vec::new();
    let Ok(doc) = text.parse::<toml_edit::DocumentMut>() else { return out };
    let Some(table) = doc.as_table().get("mcp_servers").and_then(|i| i.as_table_like()) else { return out };
    for (name, item) in table.iter() {
        let Some(def) = item.as_table_like() else { continue };
        let url = def.get("url").and_then(|u| u.as_str()).filter(|u| !u.is_empty());
        let (transport, target) = match url {
            Some(u) => ("http", sanitize_url(u)),
            None => {
                let mut parts: Vec<String> = Vec::new();
                if let Some(cmd) = def.get("command").and_then(|c| c.as_str()) {
                    parts.push(cmd.to_string());
                }
                if let Some(args) = def.get("args").and_then(|a| a.as_array()) {
                    parts.extend(args.iter().filter_map(|a| a.as_str()).map(str::to_string));
                }
                ("stdio", parts.join(" "))
            }
        };
        out.push(McpServer {
            name: name.to_string(),
            scope: "user".to_string(),
            transport: transport.to_string(),
            target,
        });
    }
    out
}

/// A `SKILL.md`'s `description:` from its YAML frontmatter: plain, quoted, or
/// a `>` / `|` block (or plain continuation) over indented lines. A tolerant
/// line-wise read, not a YAML parser; empty when there is none.
fn frontmatter_description(text: &str) -> String {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next().map(str::trim) != Some("---") {
        return String::new();
    }
    let body: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let Some(at) = body.iter().position(|l| l.starts_with("description:")) else { return String::new() };
    let first = body[at]["description:".len()..].trim();
    let is_block = first.starts_with('>') || first.starts_with('|');
    let mut parts: Vec<&str> = Vec::new();
    if !is_block && !first.is_empty() {
        parts.push(first);
    }
    for line in &body[at + 1..] {
        if line.trim().is_empty() || line.starts_with(' ') || line.starts_with('\t') {
            let t = line.trim();
            if !t.is_empty() {
                parts.push(t);
            }
        } else {
            break;
        }
    }
    let joined = parts.join(" ");
    let quoted = |q: char| joined.len() >= 2 && joined.starts_with(q) && joined.ends_with(q);
    if quoted('"') || quoted('\'') {
        joined[1..joined.len() - 1].to_string()
    } else {
        joined
    }
}

/// `(len(name) + len(description)) / 4`, rounded up.
fn estimate_skill_tokens(name: &str, description: &str) -> u64 {
    let chars = (name.chars().count() + description.chars().count()) as u64;
    chars.div_ceil(4)
}

/// The skills in `<dir>/*/SKILL.md`, tagged with `scope`.
fn skills_in(dir: &Path, scope: &str, out: &mut Vec<SkillInfo>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Ok(text) = std::fs::read_to_string(path.join("SKILL.md")) else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let est_tokens = estimate_skill_tokens(&name, &frontmatter_description(&text));
        out.push(SkillInfo { name, scope: scope.to_string(), est_tokens });
    }
}

fn read_json(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Where Claude Code keeps its user-level JSON (`.claude.json`): inside the
/// profile's folder for a profile, `~/.claude.json` for the default one
/// unless `CLAUDE_CONFIG_DIR` moved it - the same rule as profiles.rs.
fn claude_global_json(claude_dir: &Path, profile: Option<&str>) -> PathBuf {
    let moved = std::env::var_os("CLAUDE_CONFIG_DIR").is_some_and(|v| !v.is_empty());
    if profile.is_some() || moved {
        return claude_dir.join(".claude.json");
    }
    match crate::fs::user_home() {
        Some(home) => home.join(".claude.json"),
        None => claude_dir.join(".claude.json"),
    }
}

/// The memory files among `candidates` that exist: their combined size in
/// characters and their paths.
fn memory_of(candidates: &[PathBuf]) -> (u64, Vec<String>) {
    let mut chars = 0u64;
    let mut files = Vec::new();
    for path in candidates {
        if let Ok(text) = std::fs::read_to_string(path) {
            chars += text.chars().count() as u64;
            files.push(path.display().to_string());
        }
    }
    (chars, files)
}

pub(crate) fn read_tools(app: &tauri::AppHandle, cli: &str, cwd: &str, profile: Option<String>) -> Result<AgentTools, String> {
    let mut tools = AgentTools::default();
    if cli != "claude" && cli != "codex" {
        return Ok(tools);
    }
    let Some(dirs) = crate::profiles::dirs(app, profile.as_deref()) else {
        return Err(format!("unknown profile {profile:?}"));
    };
    let cwd_path = if cwd.is_empty() { None } else { Some(PathBuf::from(cwd)) };
    let mut memory: Vec<PathBuf> = Vec::new();
    if cli == "claude" {
        let global = read_json(&claude_global_json(&dirs.claude, profile.as_deref()));
        mcp_from_json(global.as_ref().and_then(|g| g.get("mcpServers")), "user", &mut tools.mcp);
        if let Some(cwd_path) = &cwd_path {
            mcp_from_json(
                read_json(&cwd_path.join(".mcp.json")).as_ref().and_then(|j| j.get("mcpServers")),
                "project",
                &mut tools.mcp,
            );
            // Per-project servers in the user JSON, keyed by the path as
            // Claude Code saw it (slash style differs on Windows).
            let variants = [cwd.to_string(), cwd.replace('\\', "/"), cwd.replace('/', "\\")];
            if let Some(projects) = global.as_ref().and_then(|g| g.get("projects")) {
                for key in &variants {
                    mcp_from_json(projects.get(key.as_str()).and_then(|p| p.get("mcpServers")), "project", &mut tools.mcp);
                }
            }
            skills_in(&cwd_path.join(".claude").join("skills"), "project", &mut tools.skills);
            memory.push(dirs.claude.join("CLAUDE.md"));
            memory.push(cwd_path.join("CLAUDE.md"));
            memory.push(cwd_path.join(".claude").join("CLAUDE.md"));
            memory.push(cwd_path.join("CLAUDE.local.md"));
        } else {
            memory.push(dirs.claude.join("CLAUDE.md"));
        }
        skills_in(&dirs.claude.join("skills"), "user", &mut tools.skills);
    } else {
        if let Ok(text) = std::fs::read_to_string(dirs.codex.join("config.toml")) {
            tools.mcp = mcp_from_codex_toml(&text);
        }
        skills_in(&dirs.codex.join("skills"), "user", &mut tools.skills);
        memory.push(dirs.codex.join("AGENTS.md"));
        if let Some(cwd_path) = &cwd_path {
            memory.push(cwd_path.join("AGENTS.md"));
        }
    }
    tools.mcp.sort_by(|a, b| a.name.cmp(&b.name));
    tools.skills.sort_by(|a, b| a.name.cmp(&b.name));
    let (chars, files) = memory_of(&memory);
    tools.memory_chars = chars;
    tools.memory_files = files;
    Ok(tools)
}

/// The MCP servers, skills and memory files a `cli` (`"claude"` or
/// `"codex"`) session started in `cwd` loads. Missing or unreadable files are
/// skipped; any other `cli` gives an empty answer.
#[tauri::command]
pub async fn agent_tools(
    app: tauri::AppHandle,
    cli: String,
    cwd: String,
    profile: Option<String>,
) -> Result<AgentTools, String> {
    crate::blocking(move || read_tools(&app, &cli, &cwd, profile)).await
}

// ---------------------------------------------------------------------------
// Session usage
// ---------------------------------------------------------------------------

/// Running sums over a Claude Code transcript.
#[derive(Default)]
struct ClaudeAcc {
    usage: SessionUsage,
    /// Messages already counted (see `spend::call_key`): one message is
    /// logged on several lines, one per content block.
    seen: HashSet<u64>,
    cost: f64,
    unpriced: bool,
}

/// One Claude Code transcript line: counts an assistant message's `usage`
/// once. Sidechain (sub-agent) calls are summed but are not turns of the
/// main context.
fn add_claude_line(acc: &mut ClaudeAcc, line: &serde_json::Value) {
    if line.get("type").and_then(|t| t.as_str()) != Some("assistant") {
        return;
    }
    let Some(message) = line.get("message") else { return };
    let Some(usage) = message.get("usage") else { return };
    let model = message.get("model").and_then(|m| m.as_str()).unwrap_or_default();
    // Not a model call: a message Claude Code wrote itself.
    if model.is_empty() || model.starts_with('<') {
        return;
    }
    let id = message.get("id").and_then(|v| v.as_str()).unwrap_or_default();
    let request = line.get("requestId").and_then(|v| v.as_str()).unwrap_or_default();
    if !id.is_empty() && !acc.seen.insert(crate::spend::call_key(id, request)) {
        return;
    }
    let input = num(usage.get("input_tokens"));
    let output = num(usage.get("output_tokens"));
    let cache_read = num(usage.get("cache_read_input_tokens"));
    let cache_write = num(usage.get("cache_creation_input_tokens"));
    let write_1h = num(usage.get("cache_creation").and_then(|b| b.get("ephemeral_1h_input_tokens"))).min(cache_write);
    match crate::spend::claude_cost(model, input, output, cache_read, cache_write - write_1h, write_1h) {
        Some(c) => acc.cost += c,
        None => acc.unpriced = true,
    }
    acc.usage.input += input;
    acc.usage.output += output;
    acc.usage.cache_read += cache_read;
    acc.usage.cache_write += cache_write;
    if line.get("isSidechain").and_then(|s| s.as_bool()) != Some(true) {
        acc.usage.turns.push(input + output + cache_read + cache_write);
        acc.usage.model = Some(model.to_string());
    } else if acc.usage.model.is_none() {
        acc.usage.model = Some(model.to_string());
    }
}

/// Calls `f` with each line (newline included) of `path`, without holding
/// the file in memory.
fn for_each_line(path: &Path, mut f: impl FnMut(&[u8])) -> Result<(), String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => f(&buf),
        }
    }
    Ok(())
}

fn keep_last_turns(turns: &mut Vec<u64>) {
    let skip = turns.len().saturating_sub(MAX_TURNS);
    turns.drain(..skip);
}

fn claude_usage(path: &Path) -> Result<SessionUsage, String> {
    let mut acc = ClaudeAcc::default();
    for_each_line(path, |line| {
        if !has(line, br#""usage""#) || !has(line, br#""assistant""#) {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
            add_claude_line(&mut acc, &value);
        }
    })?;
    let mut usage = acc.usage;
    keep_last_turns(&mut usage.turns);
    usage.cost = (!acc.unpriced).then_some(acc.cost);
    Ok(usage)
}

/// Running state over a Codex rollout.
#[derive(Default)]
struct CodexAcc {
    usage: SessionUsage,
    /// The session's running totals (input, cached input, output) at the last
    /// counted `token_count`.
    prev: [u64; 3],
    counted: bool,
    cost: f64,
    unpriced: bool,
}

/// One Codex rollout line: the model as a turn sets it, and each
/// `token_count`'s running totals and last-call size.
fn add_codex_line(acc: &mut CodexAcc, line: &serde_json::Value) {
    let kind = line.get("type").and_then(|t| t.as_str()).unwrap_or_default();
    let Some(payload) = line.get("payload") else { return };
    if kind == "turn_context" {
        if let Some(model) = payload.get("model").and_then(|m| m.as_str()) {
            acc.usage.model = Some(model.to_string());
        }
        return;
    }
    if payload.get("type").and_then(|t| t.as_str()) != Some("token_count") {
        return;
    }
    let Some(info) = payload.get("info") else { return };
    let Some(total) = info.get("total_token_usage") else { return };
    let now = [
        num(total.get("input_tokens")),
        num(total.get("cached_input_tokens")),
        num(total.get("output_tokens")),
    ];
    // A repeated event (rate-limit update) carries the same totals.
    if acc.counted && now == acc.prev {
        return;
    }
    let delta = [
        now[0].saturating_sub(acc.prev[0]),
        now[1].saturating_sub(acc.prev[1]),
        now[2].saturating_sub(acc.prev[2]),
    ];
    acc.prev = now;
    acc.counted = true;
    // Cached input is part of `input_tokens`.
    let cached_delta = delta[1].min(delta[0]);
    match acc.usage.model.as_deref() {
        Some(model) => match crate::spend::codex_cost(model, delta[0] - cached_delta, cached_delta, delta[2]) {
            Some(c) => acc.cost += c,
            None => acc.unpriced = true,
        },
        None => acc.unpriced = true,
    }
    let cached = now[1].min(now[0]);
    acc.usage.input = now[0] - cached;
    acc.usage.cache_read = cached;
    acc.usage.output = now[2];
    acc.usage.cache_write = 0;
    if let Some(last) = info.get("last_token_usage") {
        let size = last
            .get("total_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or_else(|| num(last.get("input_tokens")) + num(last.get("output_tokens")));
        acc.usage.turns.push(size);
    }
}

fn codex_usage(path: &Path) -> Result<SessionUsage, String> {
    let mut acc = CodexAcc::default();
    for_each_line(path, |line| {
        if !has(line, br#""token_count""#) && !has(line, br#""turn_context""#) {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(line) {
            add_codex_line(&mut acc, &value);
        }
    })?;
    let mut usage = acc.usage;
    keep_last_turns(&mut usage.turns);
    usage.cost = (acc.counted && !acc.unpriced).then_some(acc.cost);
    Ok(usage)
}

/// The last answer per transcript with its length when read, so polling an
/// idle session costs nothing (as in context.rs).
type ResultCache = HashMap<PathBuf, (u64, SessionUsage)>;
static RESULTS: LazyLock<Mutex<ResultCache>> = LazyLock::new(Default::default);

pub(crate) fn read_usage(
    app: &tauri::AppHandle,
    cli: &str,
    session_id: &str,
    profile: Option<String>,
) -> Result<SessionUsage, String> {
    // The id ends up in a path.
    if !crate::context::plain_id(session_id) {
        return Err("invalid session id".into());
    }
    let Some(dirs) = crate::profiles::dirs(app, profile.as_deref()) else {
        return Err(format!("unknown profile {profile:?}"));
    };
    let found = match cli {
        "claude" => crate::context::find_claude_transcript(&dirs.claude, session_id),
        "codex" => crate::agents::find_codex_rollout(&dirs.codex.join("sessions"), session_id),
        _ => return Err(format!("unsupported cli {cli}")),
    };
    let Some(path) = found else {
        return Err(format!("no transcript for {cli} session {session_id}"));
    };
    let len = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if len > MAX_TRANSCRIPT {
        return Err("transcript too large".into());
    }
    if let Some((at, usage)) = lock(&RESULTS).get(&path) {
        if *at == len {
            return Ok(usage.clone());
        }
    }
    let usage = if cli == "claude" { claude_usage(&path)? } else { codex_usage(&path)? };
    crate::util::insert_bounded(&mut lock(&RESULTS), path, (len, usage.clone()));
    Ok(usage)
}

/// Tokens, per-call context sizes and list-price cost of one `cli` session,
/// summed from its transcript. `Err` says why it can't be read (unknown CLI,
/// bad id, no transcript, transcript over 200 MiB).
#[tauri::command]
pub async fn agent_session_usage(
    app: tauri::AppHandle,
    cli: String,
    session_id: String,
    profile: Option<String>,
) -> Result<SessionUsage, String> {
    crate::blocking(move || read_usage(&app, &cli, &session_id, profile)).await
}

/// Prompt-cache lifetime of a Claude session and when it last called the model.
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    /// How long the prompt cache lives after a call: 1 h when the session writes 1-hour cache entries, else 5 min.
    pub ttl_ms: u64,
    /// `timestamp` (ISO-8601 string, as in the transcript) of the last main-context model call; None if none found.
    pub last_call_at: Option<String>,
}

const CACHE_TTL_5M: u64 = 300_000;
const CACHE_TTL_1H: u64 = 3_600_000;
/// Transcript tail scanned for cache info.
const CACHE_TAIL: u64 = 1024 * 1024;

/// Scans transcript lines from the end: the last main-context model call gives
/// `last_call_at`, the last cache write gives the TTL.
fn cache_info_from_tail(text: &str) -> CacheInfo {
    let mut last_call_at: Option<String> = None;
    let mut ttl_ms: Option<u64> = None;
    for raw in text.lines().rev() {
        if last_call_at.is_some() && ttl_ms.is_some() {
            break;
        }
        let Ok(line) = serde_json::from_str::<serde_json::Value>(raw) else { continue };
        if line.get("type").and_then(|t| t.as_str()) != Some("assistant")
            || line.get("isSidechain").and_then(|s| s.as_bool()) == Some(true)
        {
            continue;
        }
        let Some(message) = line.get("message") else { continue };
        let Some(usage) = message.get("usage") else { continue };
        let model = message.get("model").and_then(|m| m.as_str()).unwrap_or_default();
        if model.is_empty() || model.starts_with('<') {
            continue;
        }
        if last_call_at.is_none() {
            last_call_at = line.get("timestamp").and_then(|t| t.as_str()).map(str::to_string);
        }
        if ttl_ms.is_none() {
            let creation = usage.get("cache_creation");
            let w1h = num(creation.and_then(|b| b.get("ephemeral_1h_input_tokens")));
            let w5m = num(creation.and_then(|b| b.get("ephemeral_5m_input_tokens")));
            if w1h > 0 {
                ttl_ms = Some(CACHE_TTL_1H);
            } else if w5m > 0 || num(usage.get("cache_creation_input_tokens")) > 0 {
                ttl_ms = Some(CACHE_TTL_5M);
            }
        }
    }
    CacheInfo { ttl_ms: ttl_ms.unwrap_or(CACHE_TTL_5M), last_call_at }
}

fn read_cache_info(
    app: &tauri::AppHandle,
    session_id: &str,
    profile: Option<String>,
    wsl_distro: Option<String>,
) -> Result<CacheInfo, String> {
    use std::io::{Read, Seek, SeekFrom};
    // The id ends up in a path.
    if !crate::context::plain_id(session_id) {
        return Err("invalid session id".into());
    }
    let dir = match wsl_distro.as_deref().filter(|d| !d.is_empty()) {
        Some(distro) => {
            let home = crate::util::wsl_home(distro).ok_or("WSL distro not running")?;
            crate::util::wsl_unc(distro, &format!("{home}/.claude"))
        }
        None => match crate::profiles::dirs(app, profile.as_deref()) {
            Some(d) => d.claude,
            None => return Err(format!("unknown profile {profile:?}")),
        },
    };
    let Some(path) = crate::context::find_claude_transcript(&dir, session_id) else {
        return Err(format!("no transcript for claude session {session_id}"));
    };
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(CACHE_TAIL);
    file.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    file.take(CACHE_TAIL).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&buf);
    // A cut tail starts mid-line: drop the partial first line.
    let text = if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        &text
    };
    Ok(cache_info_from_tail(text))
}

/// Cache lifetime and last model call of a Claude session, read from the end
/// of its transcript.
#[tauri::command]
pub async fn chat_cache_info(
    app: tauri::AppHandle,
    session_id: String,
    profile: Option<String>,
    wsl_distro: Option<String>,
) -> Result<CacheInfo, String> {
    crate::blocking(move || read_cache_info(&app, &session_id, profile, wsl_distro)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asst(ts: &str, side: bool, model: &str, usage: &str) -> String {
        format!(
            r#"{{"type":"assistant","isSidechain":{side},"timestamp":"{ts}","message":{{"model":"{model}","usage":{usage}}}}}"#
        )
    }

    #[test]
    fn cache_ttl_1h_write() {
        let t = asst("t1", false, "claude-x", r#"{"cache_creation_input_tokens":10,"cache_creation":{"ephemeral_1h_input_tokens":10,"ephemeral_5m_input_tokens":0}}"#);
        assert_eq!(cache_info_from_tail(&t), CacheInfo { ttl_ms: 3_600_000, last_call_at: Some("t1".into()) });
    }

    #[test]
    fn cache_ttl_5m_only() {
        let t = asst("t1", false, "claude-x", r#"{"cache_creation":{"ephemeral_5m_input_tokens":7}}"#);
        assert_eq!(cache_info_from_tail(&t).ttl_ms, 300_000);
    }

    #[test]
    fn cache_last_read_only_uses_earlier_write() {
        let t = [
            asst("t1", false, "claude-x", r#"{"cache_creation":{"ephemeral_1h_input_tokens":5}}"#),
            asst("t2", false, "claude-x", r#"{"cache_read_input_tokens":99}"#),
        ]
        .join("\n");
        assert_eq!(cache_info_from_tail(&t), CacheInfo { ttl_ms: 3_600_000, last_call_at: Some("t2".into()) });
    }

    #[test]
    fn cache_ignores_sidechain_and_synthetic() {
        let t = [
            asst("t1", false, "claude-x", r#"{"cache_creation_input_tokens":3}"#),
            asst("t2", true, "claude-x", r#"{"cache_creation":{"ephemeral_1h_input_tokens":5}}"#),
            asst("t3", false, "<synthetic>", r#"{"cache_creation":{"ephemeral_1h_input_tokens":5}}"#),
        ]
        .join("\n");
        assert_eq!(cache_info_from_tail(&t), CacheInfo { ttl_ms: 300_000, last_call_at: Some("t1".into()) });
    }

    #[test]
    fn cache_no_lines() {
        assert_eq!(cache_info_from_tail(""), CacheInfo { ttl_ms: 300_000, last_call_at: None });
    }

    fn json(text: &str) -> serde_json::Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn description_plain_quoted_and_block() {
        assert_eq!(frontmatter_description("---\nname: a\ndescription: Does a thing\n---\nbody"), "Does a thing");
        assert_eq!(frontmatter_description("---\ndescription: \"Quoted: yes\"\n---\n"), "Quoted: yes");
        assert_eq!(frontmatter_description("---\ndescription: 'single'\n---\n"), "single");
        assert_eq!(
            frontmatter_description("---\nname: a\ndescription: >\n  first line\n  second line\nother: x\n---\n"),
            "first line second line"
        );
        assert_eq!(frontmatter_description("---\ndescription: |-\n  one\n\n  two\n---\n"), "one two");
        assert_eq!(frontmatter_description("no frontmatter"), "");
        assert_eq!(frontmatter_description("---\nname: a\n---\n"), "");
    }

    #[test]
    fn skill_tokens_round_up() {
        assert_eq!(estimate_skill_tokens("abcd", ""), 1);
        assert_eq!(estimate_skill_tokens("abcd", "e"), 2);
        assert_eq!(estimate_skill_tokens("", ""), 0);
    }

    #[test]
    fn sanitizes_urls() {
        assert_eq!(sanitize_url("https://user:pw@host.com:8080/mcp?token=abc#x"), "https://host.com:8080/mcp");
        assert_eq!(sanitize_url("http://localhost:3000/sse"), "http://localhost:3000/sse");
        assert_eq!(sanitize_url("https://host.com?key=1"), "https://host.com");
    }

    #[test]
    fn parses_mcp_json_without_secrets() {
        let v = json(
            r#"{"mcpServers":{
                "fs":{"command":"npx","args":["-y","server-fs","/tmp"],"env":{"TOKEN":"secret"}},
                "web":{"url":"https://x.dev/mcp?key=secret","headers":{"Authorization":"Bearer s"}},
                "ev":{"type":"sse","url":"https://x.dev/sse"},
                "bad":"nope"
            }}"#,
        );
        let mut out = Vec::new();
        mcp_from_json(v.get("mcpServers"), "user", &mut out);
        out.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = out.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["ev", "fs", "web"]);
        assert_eq!((out[0].transport.as_str(), out[0].target.as_str()), ("sse", "https://x.dev/sse"));
        assert_eq!((out[1].transport.as_str(), out[1].target.as_str()), ("stdio", "npx -y server-fs /tmp"));
        assert_eq!((out[2].transport.as_str(), out[2].target.as_str()), ("http", "https://x.dev/mcp"));
        // The same name in the same scope isn't added twice.
        mcp_from_json(v.get("mcpServers"), "user", &mut out);
        assert_eq!(out.len(), 3);
        mcp_from_json(None, "user", &mut out);
        assert_eq!(out.len(), 3);
    }

    #[test]
    fn parses_codex_toml_servers() {
        let toml = r#"
model = "gpt-5.5"
[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-server"]
[mcp_servers.docs.env]
KEY = "secret"
[mcp_servers.remote]
url = "https://r.dev/mcp?token=abc"
"#;
        let out = mcp_from_codex_toml(toml);
        assert_eq!(out.len(), 2);
        let docs = out.iter().find(|m| m.name == "docs").unwrap();
        assert_eq!((docs.transport.as_str(), docs.target.as_str()), ("stdio", "npx -y docs-server"));
        let remote = out.iter().find(|m| m.name == "remote").unwrap();
        assert_eq!((remote.transport.as_str(), remote.target.as_str()), ("http", "https://r.dev/mcp"));
        assert!(mcp_from_codex_toml("not = [valid").is_empty());
    }

    #[test]
    fn claude_usage_counts_each_message_once() {
        let line = |id: &str, side: bool| {
            json(&format!(
                r#"{{"type":"assistant","isSidechain":{side},"requestId":"r-{id}","message":{{"id":"{id}","model":"claude-sonnet-4-6","usage":{{"input_tokens":1000000,"output_tokens":100000,"cache_read_input_tokens":10,"cache_creation_input_tokens":5}}}}}}"#
            ))
        };
        let mut acc = ClaudeAcc::default();
        add_claude_line(&mut acc, &line("m1", false));
        add_claude_line(&mut acc, &line("m1", false));
        add_claude_line(&mut acc, &line("m2", true));
        assert_eq!(acc.usage.input, 2_000_000);
        assert_eq!(acc.usage.cache_write, 10);
        // The sidechain call is summed but isn't a turn.
        assert_eq!(acc.usage.turns, vec![1_100_015]);
        assert!(!acc.unpriced);
        assert!(acc.cost > 9.0);
    }

    #[test]
    fn codex_usage_uses_running_totals() {
        let count = |input: u64, cached: u64, output: u64, last: u64| {
            json(&format!(
                r#"{{"type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input},"cached_input_tokens":{cached},"output_tokens":{output}}},"last_token_usage":{{"total_tokens":{last}}}}}}}}}"#
            ))
        };
        let mut acc = CodexAcc::default();
        add_codex_line(&mut acc, &json(r#"{"type":"turn_context","payload":{"model":"gpt-5.5"}}"#));
        add_codex_line(&mut acc, &count(1_000_000, 0, 0, 1_000_000));
        add_codex_line(&mut acc, &count(1_000_000, 0, 0, 1_000_000));
        add_codex_line(&mut acc, &count(2_000_000, 1_000_000, 100_000, 1_100_000));
        assert_eq!(acc.usage.turns, vec![1_000_000, 1_100_000]);
        assert_eq!((acc.usage.input, acc.usage.cache_read, acc.usage.output), (1_000_000, 1_000_000, 100_000));
        assert!(!acc.unpriced);
        assert!((acc.cost - 8.5).abs() < 1e-9);
    }

    #[test]
    fn keeps_only_the_last_turns() {
        let mut turns: Vec<u64> = (0..100).collect();
        keep_last_turns(&mut turns);
        assert_eq!(turns.len(), MAX_TURNS);
        assert_eq!(turns[0], 60);
    }
}
