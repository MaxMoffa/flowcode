//! The MCP server Flowcode hands to chat agents, so they can reach the app:
//! open a page in its browser, delegate a task to another agent.
//!
//! The server is a stdio Node script the agent launches itself. It talks to
//! the app through files in one folder (so it works the same on Windows and
//! inside WSL, with no network): a request file in, a response file out. A
//! background thread here watches the folder and hands each request to
//! `chat::delegate::mcp_call`, on a thread of its own - a task may wait a long
//! time and must not stall the others. A request names its caller by a random
//! per-chat token, so a chat can only act as itself.

use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

use crate::util::lock;

const SERVER_NAME: &str = "flowcode";
/// How Claude names the open tool (`mcp__<server>__<tool>`).
const CLAUDE_OPEN_TOOL: &str = "mcp__flowcode__open_in_browser";
const SCRIPT: &str = include_str!("flowcode-mcp.cjs");

pub(crate) const OPEN: &str = "open_in_browser";
pub(crate) const LIST_AGENTS: &str = "list_agents";
pub(crate) const DELEGATE_TASK: &str = "delegate_task";
pub(crate) const GET_TASK_RESULT: &str = "get_task_result";
pub(crate) const CANCEL_TASK: &str = "cancel_task";

const POLL: Duration = Duration::from_millis(150);
const IDLE_POLL: Duration = Duration::from_secs(1);
const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
/// Request and response files older than this are leftovers (a script that gave up, an app that died).
const STALE: Duration = Duration::from_secs(10 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(5 * 60);
/// Requests served at once; more are refused, so a runaway script can't pile up threads.
const MAX_IN_FLIGHT: usize = 32;

/// What a chat's agent may do through Flowcode (`chat_start`'s `tools`, from
/// the "Agent tools" settings). Missing means everything off.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ToolsConfig {
    /// Master switch: off, no server reaches the agent at all.
    pub enabled: bool,
    pub open: bool,
    /// Let `open_in_browser` through without asking (see `auto_allow`).
    pub open_auto_allow: bool,
    pub delegate: bool,
    /// The agents a task may be delegated to.
    pub delegate_agents: Vec<String>,
    /// Most tasks one chat may have running at once.
    pub max_parallel: usize,
}

/// The tools a chat gets. A delegated child (depth 1) never delegates further.
pub(crate) fn enabled_tools(cfg: &ToolsConfig, depth: u8) -> Vec<&'static str> {
    let mut tools = Vec::new();
    if !cfg.enabled {
        return tools;
    }
    if cfg.open {
        tools.push(OPEN);
    }
    if cfg.delegate && depth == 0 && !cfg.delegate_agents.is_empty() {
        tools.extend([LIST_AGENTS, DELEGATE_TASK, GET_TASK_RESULT, CANCEL_TASK]);
    }
    tools
}

/// Who a token stands for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Caller {
    pub chat_id: String,
    pub depth: u8,
}

/// The chats that may call in, by token.
#[derive(Default)]
struct Registry {
    callers: Mutex<HashMap<String, Caller>>,
}

impl Registry {
    fn register(&self, chat_id: &str, depth: u8) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        lock(&self.callers).insert(token.clone(), Caller { chat_id: chat_id.to_string(), depth });
        token
    }

    fn unregister(&self, token: &str) {
        lock(&self.callers).remove(token);
    }

    fn caller(&self, token: &str) -> Option<Caller> {
        lock(&self.callers).get(token).cloned()
    }
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(Registry::default)
}

/// A token for a chat that gets the server; give it back with `unregister` when the chat ends.
pub(crate) fn register(chat_id: &str, depth: u8) -> String {
    registry().register(chat_id, depth)
}

pub(crate) fn unregister(token: &str) {
    registry().unregister(token);
}

/// The script and the IPC folder on disk, set up once per run (and the poller
/// that serves the folder started with them): chats starting together share
/// them, none sees the script half written.
struct Setup {
    script: PathBuf,
    dir: PathBuf,
}

fn setup(app: &AppHandle) -> Option<&'static Setup> {
    static SETUP: OnceLock<Setup> = OnceLock::new();
    static INIT: Mutex<()> = Mutex::new(());
    let _init = lock(&INIT);
    if SETUP.get().is_none() {
        let initialized = (|| -> Option<Setup> {
            let root = app.path().app_local_data_dir().ok()?.join("mcp");
            let dir = root.join("ipc");
            std::fs::create_dir_all(&dir).ok()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                for path in [&root, &dir] {
                    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).ok()?;
                }
            }
            let script = root.join("flowcode-mcp.cjs");
            if std::fs::read_to_string(&script).ok().as_deref() != Some(SCRIPT) {
                std::fs::write(&script, SCRIPT).ok()?;
            }
            sweep(&dir, STALE);
            let (app, watched) = (app.clone(), dir.clone());
            std::thread::spawn(move || poll(app, watched));
            Some(Setup { script, dir })
        })();
        match initialized {
            Some(setup) => { let _ = SETUP.set(setup); }
            None => eprintln!("mcp: setup failed; the next chat will retry"),
        }
    }
    SETUP.get()
}

/// `path` as the agent sees it: a Linux path when it runs in WSL.
fn agent_path(path: &Path, wsl: bool) -> Option<String> {
    let path = path.to_str()?;
    if wsl { crate::chat::to_wsl_path(path) } else { Some(path.to_string()) }
}

fn server_entry(script: &str, dir: &str, token: &str, tools: &[&str]) -> Value {
    json!([{
        "name": SERVER_NAME,
        "command": "node",
        "args": [script],
        "env": [
            { "name": "FLOWCODE_MCP_DIR", "value": dir },
            { "name": "FLOWCODE_MCP_TOKEN", "value": token },
            { "name": "FLOWCODE_MCP_TOOLS", "value": tools.join(",") },
        ],
    }])
}

/// The `mcpServers` of a session: Flowcode's server when the chat has any tool
/// (`depth` 0 for a normal chat, 1 for a delegated child), none otherwise.
pub(crate) fn servers(app: &AppHandle, cfg: &ToolsConfig, depth: u8, token: &str, wsl: bool) -> Value {
    let tools = enabled_tools(cfg, depth);
    if tools.is_empty() {
        return json!([]);
    }
    let paths = setup(app).and_then(|s| Some((agent_path(&s.script, wsl)?, agent_path(&s.dir, wsl)?)));
    match paths {
        Some((script, dir)) => server_entry(&script, &dir, token, &tools),
        None => json!([]),
    }
}

/// One tool call as the script wrote it.
#[derive(Debug, PartialEq)]
struct Request {
    token: String,
    tool: String,
    args: Value,
    deadline_ms: Option<u64>,
}

/// A request id is the name of a file: nothing but a uuid-like word may be in it.
fn is_safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// The request in `req-<file_id>.json`: its body must say the same id.
fn parse_request(file_id: &str, text: &str) -> Result<Request, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| format!("unreadable request: {e}"))?;
    if value.get("id").and_then(Value::as_str) != Some(file_id) {
        return Err("the request id does not match its file".into());
    }
    let text_of = |key: &str| value.get(key).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    let token = text_of("token").ok_or("the request has no token")?;
    let tool = text_of("tool").ok_or("the request names no tool")?;
    let args = match value.get("args") {
        None | Some(Value::Null) => json!({}),
        Some(args) if args.is_object() => args.clone(),
        Some(_) => return Err("the arguments must be an object".into()),
    };
    let deadline_ms = match value.get("deadline_ms") {
        None => None,
        Some(value) => Some(value.as_u64().ok_or("deadline_ms must be an unsigned timestamp")?),
    };
    Ok(Request { token, tool, args, deadline_ms })
}

pub(crate) fn check_deadline(deadline_ms: Option<u64>, now: u64) -> Result<(), String> {
    if deadline_ms.is_some_and(|deadline| now >= deadline) {
        Err("the Flowcode tool call timed out".into())
    } else {
        Ok(())
    }
}

/// Serves the request of one caller: the token must be a live chat's, and the
/// tool one that chat was given - the script's word is never enough.
fn dispatch(app: &AppHandle, request: Request) -> Result<String, String> {
    check_deadline(request.deadline_ms, crate::util::now_ms())?;
    let caller = registry().caller(&request.token).ok_or("unknown or expired token")?;
    crate::chat::delegate::mcp_call(app, &caller, &request.tool, &request.args, request.deadline_ms)
}

fn write_atomic(dir: &Path, name: &str, body: &str) -> std::io::Result<()> {
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, dir.join(name))
}

fn write_response(dir: &Path, id: &str, result: &Result<String, String>) {
    let body = match result {
        Ok(text) => json!({ "ok": true, "text": text }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    if let Err(e) = write_atomic(dir, &format!("res-{id}.json"), &body.to_string()) {
        eprintln!("mcp: could not answer request {id}: {e}");
    }
}

/// Takes the pending request files out of `dir` (deleting each before it is
/// served, so it is served once): `(id, text)`.
fn take_requests(dir: &Path) -> Vec<(String, String)> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut taken = Vec::new();
    for entry in entries.flatten() {
        if taken.len() >= MAX_IN_FLIGHT { break; }
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|n| n.strip_prefix("req-")).and_then(|n| n.strip_suffix(".json")) else { continue };
        if !is_safe_id(id) {
            continue;
        }
        // Do not follow links, and bound the read even if the file grows meanwhile.
        let text = (|| -> std::io::Result<String> {
            if !entry.file_type()?.is_file() || entry.metadata()?.len() > MAX_REQUEST_BYTES {
                return Err(std::io::Error::other("request is not a bounded regular file"));
            }
            let mut text = String::new();
            std::fs::File::open(entry.path())?.take(MAX_REQUEST_BYTES + 1).read_to_string(&mut text)?;
            if text.len() as u64 > MAX_REQUEST_BYTES { return Err(std::io::Error::other("request too large")); }
            Ok(text)
        })();
        let _ = std::fs::remove_file(entry.path());
        if let Ok(text) = text {
            taken.push((id.to_string(), text));
        }
    }
    taken
}

/// Removes the request and response files older than `max_age`.
fn sweep(dir: &Path, max_age: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !(name.starts_with("req-") || name.starts_with("res-")) {
            continue;
        }
        let age = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| SystemTime::now().duration_since(t).ok());
        if age.is_some_and(|age| age > max_age) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Counts a request in flight until dropped.
struct InFlight(Arc<AtomicUsize>);

impl InFlight {
    fn enter(counter: &Arc<AtomicUsize>) -> Option<InFlight> {
        (counter.fetch_add(1, Ordering::AcqRel) < MAX_IN_FLIGHT).then(|| InFlight(Arc::clone(counter))).or_else(|| {
            counter.fetch_sub(1, Ordering::AcqRel);
            None
        })
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// The poller: every `POLL`, serves the new request files, each on its own thread.
fn poll(app: AppHandle, dir: PathBuf) {
    let in_flight = Arc::new(AtomicUsize::new(0));
    let mut swept = std::time::Instant::now();
    loop {
        let requests = take_requests(&dir);
        let idle = requests.is_empty() && in_flight.load(Ordering::Acquire) == 0;
        for (id, text) in requests {
            let Some(slot) = InFlight::enter(&in_flight) else {
                write_response(&dir, &id, &Err("Flowcode is busy with too many tool calls".into()));
                continue;
            };
            let (app, dir) = (app.clone(), dir.clone());
            std::thread::spawn(move || {
                let _slot = slot;
                let result = parse_request(&id, &text).and_then(|request| dispatch(&app, request));
                write_response(&dir, &id, &result);
            });
        }
        if swept.elapsed() > SWEEP_EVERY {
            sweep(&dir, STALE);
            swept = std::time::Instant::now();
        }
        std::thread::sleep(if idle { IDLE_POLL } else { POLL });
    }
}

const PREVIEWABLE: [&str; 11] = ["html", "htm", "svg", "pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm"];

/// Whether `path` ends in an extension Flowcode can preview (the list of `shared/agentOpen.ts`).
fn is_previewable(path: &str) -> bool {
    let Some(dot) = path.rfind('.') else { return false };
    let ext = &path[dot + 1..];
    !ext.contains(['/', '\\']) && PREVIEWABLE.iter().any(|p| ext.eq_ignore_ascii_case(p))
}

/// `ftp://...`, `data:...`: a scheme of its own (a drive letter's single character is not one).
fn has_scheme(target: &str) -> bool {
    target.find(':').is_some_and(|i| i >= 2 && target[..i].bytes().all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b)))
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/') || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
}

fn is_network_path(path: &str) -> bool {
    path.replace('\\', "/").starts_with("//")
}

/// Normalize separators and dot segments before checking a directory boundary.
fn lexical(path: &str) -> String {
    let path = path.replace('\\', "/");
    let drive = path.as_bytes().get(1) == Some(&b':');
    let (prefix, rest) = if drive { (&path[..3.min(path.len())], &path[3.min(path.len())..]) }
        else if let Some(rest) = path.strip_prefix('/') { ("/", rest) } else { ("", path.as_str()) };
    let mut parts = Vec::new();
    for part in rest.split('/') {
        match part {
            "" | "." => {},
            ".." => { parts.pop(); },
            part => parts.push(part),
        }
    }
    format!("{prefix}{}", parts.join("/"))
}

fn is_within(path: &str, root: &str) -> bool {
    if !is_absolute(root) || is_network_path(root) { return false; }
    let (mut path, mut root) = (lexical(path), lexical(root));
    if root.as_bytes().get(1) == Some(&b':') {
        path.make_ascii_lowercase();
        root.make_ascii_lowercase();
    }
    path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

/// What `open_in_browser` may open: an http(s) URL as is, or a previewable
/// file (a relative path is made absolute from the chat's folder `cwd`).
/// Anything else - another scheme, an executable - is refused with a reason
/// the model can act on.
pub(crate) fn open_target(target: &str, cwd: &str, homes: &[String], wsl_distro: Option<&str>) -> Result<String, String> {
    let target = target.trim();
    if target.is_empty() || target.chars().any(char::is_control) {
        return Err("target is empty or has control characters".into());
    }
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return if target.contains(char::is_whitespace) { Err("the URL must not contain spaces".into()) } else { Ok(target.to_string()) };
    }
    if is_network_path(target) || is_network_path(cwd) {
        return Err("network paths cannot be opened by this tool".into());
    }
    if has_scheme(target) || !is_previewable(target) {
        return Err("target must be an http(s) URL or a file Flowcode can preview (html, svg, pdf, png, jpg, gif, webp, mp4, webm)".into());
    }
    if target.starts_with('\\') || (!is_absolute(target) && target.contains(':')) {
        return Err("target must be an absolute file path or a path relative to the chat folder".into());
    }
    let full = lexical(&if is_absolute(target) { target.to_string() } else { format!("{}/{target}", cwd.trim_end_matches(['/', '\\'])) });
    let roots: Vec<&str> = std::iter::once(cwd).chain(homes.iter().map(String::as_str)).collect();
    if !is_absolute(&full) || !roots.iter().any(|root| is_within(&full, root)) {
        return Err("files must be inside the chat folder or the user's home directory".into());
    }
    let local = |path: &str| -> Result<PathBuf, String> {
        if cfg!(windows) && path.starts_with('/') {
            if let Some(distro) = wsl_distro {
                return crate::chat_images::from_wsl_path(path, distro).map(PathBuf::from);
            }
        }
        Ok(PathBuf::from(path))
    };
    let file = local(&full)?;
    // Check links before any canonicalize/stat can follow one into a remote share.
    if !crate::fs::links_stay_local(&file) {
        return Err("file links must stay local".into());
    }
    if let Ok(file) = file.canonicalize() {
        let allowed = roots.iter().filter_map(|root| local(root).ok()?.canonicalize().ok()).any(|root| file.starts_with(root));
        if !allowed {
            return Err("file links must stay inside the chat folder or the user's home directory".into());
        }
    }
    Ok(full)
}

/// The option that lets a `session/request_permission` through unasked, when it
/// is for the open tool and the chat allows that: the call itself does nothing,
/// and what the app then opens is bound by the Browser settings. Never the
/// "always" option: nothing is written to the user's agent settings.
pub(crate) fn auto_allow(cfg: &ToolsConfig, cwd: &str, params: &Value) -> Option<String> {
    if !(cfg.enabled && cfg.open && cfg.open_auto_allow) || !is_open_call(params.get("toolCall")?) {
        return None;
    }
    let target = params.pointer("/toolCall/rawInput/target")?.as_str()?;
    if !safe_auto_open(target, cwd) { return None; }
    allow_once_option(params)
}

fn safe_auto_open(target: &str, cwd: &str) -> bool {
    if let Ok(url) = tauri::Url::parse(target) {
        if matches!(url.scheme(), "http" | "https") {
            let host = url.host_str().unwrap_or_default().trim_matches(['[', ']']);
            return url.username().is_empty() && url.password().is_none()
                && (host.eq_ignore_ascii_case("localhost") || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback()));
        }
    }
    open_target(target, cwd, &[], None).is_ok()
}

/// Whether a permission request's tool call is Flowcode's `open_in_browser`.
/// Claude names it exactly (`_meta`). Other adapters only give a title, which a
/// shell command can imitate, so there it takes all of: the title names the
/// tool and the server, and the input is just a `target` (a command has
/// `command`). Unsure means the user is asked.
fn is_open_call(tool_call: &Value) -> bool {
    if let Some(tool) = tool_call.pointer("/_meta/claudeCode/toolName").and_then(Value::as_str) {
        return tool == CLAUDE_OPEN_TOOL
            && tool_call.pointer("/_meta/claudeCode/mcpServer/name").and_then(Value::as_str) == Some(SERVER_NAME)
            && tool_call.pointer("/_meta/claudeCode/mcpServer/source").and_then(Value::as_str) == Some("dynamic");
    }
    let title = tool_call.get("title").and_then(Value::as_str).unwrap_or_default().to_ascii_lowercase();
    let only_target = tool_call.get("rawInput").and_then(Value::as_object).is_some_and(|input| input.len() == 1 && input.contains_key("target"));
    matches!(title.as_str(), "flowcode/open_in_browser" | "tool: flowcode/open_in_browser") && only_target
}

fn allow_once_option(params: &Value) -> Option<String> {
    let options = params.get("options")?.as_array()?;
    let once = options.iter().find(|o| o.get("kind").and_then(Value::as_str) == Some("allow_once"))?;
    once.get("optionId")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auto_allow(cfg: &ToolsConfig, params: &Value) -> Option<String> {
        super::auto_allow(cfg, "/repo", params)
    }

    fn open_target(target: &str, cwd: &str) -> Result<String, String> {
        super::open_target(target, cwd, &["/home/alice".into(), "C:/Users/Alice".into()], None)
    }

    fn on() -> ToolsConfig {
        ToolsConfig {
            enabled: true,
            open: true,
            open_auto_allow: true,
            delegate: true,
            delegate_agents: vec!["codex".into()],
            max_parallel: 3,
        }
    }

    fn request(tool_call: Value) -> Value {
        json!({
            "toolCall": tool_call,
            "options": [
                { "optionId": "always", "kind": "allow_always" },
                { "optionId": "once", "kind": "allow_once" },
                { "optionId": "no", "kind": "reject_once" },
            ],
        })
    }

    fn claude(tool: &str) -> Value {
        request(json!({ "rawInput": { "target": "http://localhost:3000" }, "_meta": { "claudeCode": { "toolName": tool, "mcpServer": { "name": "flowcode", "source": "dynamic" } } } }))
    }

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("flowcode-mcp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn oversized_requests_are_removed_without_being_dispatched() {
        let dir = temp_dir();
        std::fs::write(dir.join("req-large.json"), vec![b'x'; MAX_REQUEST_BYTES as usize + 1]).unwrap();
        assert!(take_requests(&dir).is_empty());
        assert!(!dir.join("req-large.json").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn config_defaults_to_everything_off_and_reads_camel_case() {
        let cfg: ToolsConfig = serde_json::from_value(json!({})).unwrap();
        assert_eq!(cfg, ToolsConfig::default());
        assert!(enabled_tools(&cfg, 0).is_empty());
        let cfg: ToolsConfig = serde_json::from_value(json!({
            "enabled": true, "open": true, "openAutoAllow": true,
            "delegate": true, "delegateAgents": ["codex"], "maxParallel": 2,
        }))
        .unwrap();
        assert!(cfg.open_auto_allow && cfg.delegate);
        assert_eq!((cfg.delegate_agents, cfg.max_parallel), (vec!["codex".to_string()], 2));
    }

    #[test]
    fn tools_follow_the_switches_and_children_only_open() {
        assert_eq!(enabled_tools(&on(), 0), [OPEN, LIST_AGENTS, DELEGATE_TASK, GET_TASK_RESULT, CANCEL_TASK]);
        assert_eq!(enabled_tools(&on(), 1), [OPEN]);
        assert_eq!(enabled_tools(&ToolsConfig { enabled: false, ..on() }, 0), Vec::<&str>::new());
        assert_eq!(enabled_tools(&ToolsConfig { open: false, ..on() }, 0), [LIST_AGENTS, DELEGATE_TASK, GET_TASK_RESULT, CANCEL_TASK]);
        assert_eq!(enabled_tools(&ToolsConfig { delegate_agents: vec![], ..on() }, 0), [OPEN]);
        assert!(enabled_tools(&ToolsConfig { open: false, ..on() }, 1).is_empty());
    }

    #[test]
    fn describes_a_stdio_server_with_its_environment() {
        let servers = server_entry("C:\\mcp\\flowcode-mcp.cjs", "C:\\mcp\\ipc", "tok", &[OPEN, LIST_AGENTS]);
        assert_eq!(servers[0]["name"], "flowcode");
        assert_eq!(servers[0]["command"], "node");
        assert_eq!(servers[0]["args"][0], "C:\\mcp\\flowcode-mcp.cjs");
        let env = servers[0]["env"].as_array().unwrap();
        let value = |name: &str| env.iter().find(|e| e["name"] == name).map(|e| e["value"].clone());
        assert_eq!(value("FLOWCODE_MCP_DIR"), Some(json!("C:\\mcp\\ipc")));
        assert_eq!(value("FLOWCODE_MCP_TOKEN"), Some(json!("tok")));
        assert_eq!(value("FLOWCODE_MCP_TOOLS"), Some(json!("open_in_browser,list_agents")));
    }

    #[test]
    fn parses_a_request_and_rejects_the_malformed() {
        let good = json!({ "id": "a-1", "token": "t", "tool": "open_in_browser", "args": { "target": "x" } }).to_string();
        let parsed = parse_request("a-1", &good).unwrap();
        assert_eq!(parsed.deadline_ms, None);
        assert_eq!((parsed.token.as_str(), parsed.tool.as_str(), parsed.args["target"].as_str()), ("t", "open_in_browser", Some("x")));
        // No args means none.
        let bare = json!({ "id": "a-1", "token": "t", "tool": "list_agents" }).to_string();
        assert_eq!(parse_request("a-1", &bare).unwrap().args, json!({}));
        assert!(parse_request("a-1", "not json").is_err());
        assert!(parse_request("other", &good).is_err(), "the id must match the file");
        assert!(parse_request("a-1", &json!({ "id": "a-1", "tool": "x" }).to_string()).is_err(), "no token");
        assert!(parse_request("a-1", &json!({ "id": "a-1", "token": "t" }).to_string()).is_err(), "no tool");
        assert!(parse_request("a-1", &json!({ "id": "a-1", "token": "t", "tool": "x", "args": [1] }).to_string()).is_err());
        let timed = json!({ "id": "a-1", "token": "t", "tool": "delegate_task", "deadline_ms": 1234 });
        assert_eq!(parse_request("a-1", &timed.to_string()).unwrap().deadline_ms, Some(1234));
        let mut invalid = timed;
        invalid["deadline_ms"] = json!("later");
        assert!(parse_request("a-1", &invalid.to_string()).is_err());
    }

    #[test]
    fn expired_tool_calls_are_refused_including_the_deadline_itself() {
        assert!(check_deadline(Some(1234), 1233).is_ok());
        assert!(check_deadline(Some(1234), 1234).is_err());
        assert!(check_deadline(Some(1234), 2000).is_err());
        assert!(check_deadline(None, u64::MAX).is_ok());
    }

    #[test]
    fn ids_cannot_escape_the_folder() {
        assert!(is_safe_id("0b1f4c1e-aa00-4f2e-9d44-0123456789ab"));
        for bad in ["", "..", "a/b", "a\\b", "a.json", "a b", &"x".repeat(65)] {
            assert!(!is_safe_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn unknown_tokens_are_rejected_and_unregistered_ones_forgotten() {
        let registry = Registry::default();
        assert_eq!(registry.caller("nope"), None);
        let token = registry.register("chat-1", 1);
        assert_eq!(registry.caller(&token), Some(Caller { chat_id: "chat-1".into(), depth: 1 }));
        assert_ne!(token, registry.register("chat-1", 1), "each registration gets its own token");
        registry.unregister(&token);
        assert_eq!(registry.caller(&token), None);
    }

    #[test]
    fn requests_are_taken_once_and_responses_written_whole() {
        let dir = temp_dir();
        std::fs::write(dir.join("req-abc.json"), "{}").unwrap();
        std::fs::write(dir.join("req-abc2.json.tmp"), "half").unwrap();
        std::fs::write(dir.join("req-..x.json"), "{}").unwrap();
        std::fs::write(dir.join("res-abc.json"), "{}").unwrap();
        assert_eq!(take_requests(&dir), [("abc".to_string(), "{}".to_string())]);
        assert!(take_requests(&dir).is_empty(), "taken means deleted");
        write_response(&dir, "abc", &Ok("hi".into()));
        let body: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("res-abc.json")).unwrap()).unwrap();
        assert_eq!(body, json!({ "ok": true, "text": "hi" }));
        write_response(&dir, "abc", &Err("no".into()));
        let body: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("res-abc.json")).unwrap()).unwrap();
        assert_eq!(body, json!({ "ok": false, "error": "no" }));
        assert!(!dir.join("res-abc.json.tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn sweep_removes_only_old_ipc_files() {
        let dir = temp_dir();
        std::fs::write(dir.join("req-a.json"), "{}").unwrap();
        std::fs::write(dir.join("res-a.json"), "{}").unwrap();
        std::fs::write(dir.join("keep.txt"), "x").unwrap();
        sweep(&dir, Duration::from_secs(600));
        assert!(dir.join("req-a.json").exists(), "fresh files stay");
        std::thread::sleep(Duration::from_millis(20));
        sweep(&dir, Duration::ZERO);
        assert!(!dir.join("req-a.json").exists() && !dir.join("res-a.json").exists());
        assert!(dir.join("keep.txt").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn in_flight_requests_are_capped() {
        let counter = Arc::new(AtomicUsize::new(0));
        let held: Vec<_> = (0..MAX_IN_FLIGHT).filter_map(|_| InFlight::enter(&counter)).collect();
        assert_eq!(held.len(), MAX_IN_FLIGHT);
        assert!(InFlight::enter(&counter).is_none());
        drop(held);
        assert!(InFlight::enter(&counter).is_some());
    }

    #[test]
    fn open_targets_are_urls_or_previewable_files() {
        assert_eq!(open_target(" https://example.com/a?b=1 ", "/repo").unwrap(), "https://example.com/a?b=1");
        assert_eq!(open_target("HTTP://localhost:5173", "/repo").unwrap(), "HTTP://localhost:5173");
        assert_eq!(open_target("out/report.HTML", "/repo/").unwrap(), "/repo/out/report.HTML");
        assert_eq!(open_target("./a.png", "C:\\repo").unwrap(), "C:/repo/a.png");
        assert_eq!(open_target("C:\\Users\\Alice\\a.pdf", "/repo").unwrap(), "C:/Users/Alice/a.pdf");
        assert_eq!(open_target("/home/alice/a.svg", "C:\\repo").unwrap(), "/home/alice/a.svg");
        assert!(open_target("a.webm", "").is_err());
        for bad in ["", "javascript:alert(1)", "C:\\Windows\\calc.exe", "file:///etc/passwd", "ftp://x/a.html", "notes.txt", "dir.html/readme", "https://a b.com", "a.html\nb"] {
            assert!(open_target(bad, "/repo").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn open_files_stay_in_the_chat_folder_or_its_users_home() {
        assert_eq!(open_target("out/../report.html", "/repo").unwrap(), "/repo/report.html");
        assert_eq!(open_target("../report.html", "/home/alice/repo/sub").unwrap(), "/home/alice/repo/report.html");
        assert!(open_target("../report.html", "/repo/sub").is_err());
        for bad in ["../../etc/report.html", "/etc/report.html", "/repo-other/report.html", "/home/bob/report.html",
            "C:\\Windows\\report.html", "C:report.html", "\\report.html", "//host/share/a.html", "\\\\host\\share\\a.html", "\\\\?\\UNC\\host\\share\\a.html"] {
            assert!(open_target(bad, "/repo").is_err(), "{bad:?}");
        }
        assert!(open_target("../report.html", "/repo").is_err());
        assert!(open_target("a.html", "//host/share").is_err());
        assert!(is_within("c:/REPO/a.html", "C:/repo"));
        assert!(!is_within("C:/repo-other/a.html", "C:/repo"));
        assert!(!is_within("/Repo/a.html", "/repo"));
        assert!(super::open_target("/mnt/c/Users/Alice/a.html", "/repo", &["/mnt/c/Users/Alice".into()], Some("Ubuntu")).is_ok());
    }

    #[test]
    fn open_files_cannot_escape_through_a_symlink() {
        let dir = temp_dir();
        let root = dir.join("repo");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(dir.join("outside.html"), "outside").unwrap();
        std::fs::write(root.join("inside.html"), "inside").unwrap();
        assert!(super::open_target("inside.html", root.to_str().unwrap(), &[], None).is_ok());
        assert!(super::open_target(dir.join("outside.html").to_str().unwrap(), root.to_str().unwrap(), &[], None).is_err());
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(dir.join("outside.html"), root.join("linked.html"));
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(dir.join("outside.html"), root.join("linked.html"));
        // Windows without Developer Mode cannot create a symlink.
        if linked.is_err() {
            std::fs::remove_dir_all(dir).unwrap();
            return;
        }
        assert!(super::open_target("linked.html", root.to_str().unwrap(), &[], None).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn allows_only_the_open_tool_and_only_once() {
        let cfg = on();
        assert_eq!(auto_allow(&cfg, &claude(CLAUDE_OPEN_TOOL)).as_deref(), Some("once"));
        assert_eq!(auto_allow(&cfg, &claude("Bash")), None);
        assert_eq!(auto_allow(&cfg, &claude("mcp__other__open_in_browser")), None);
        assert_eq!(auto_allow(&cfg, &claude("mcp__flowcode__delegate_task")), None);
        assert_eq!(auto_allow(&cfg, &json!({ "toolCall": {}, "options": [] })), None);
    }

    #[test]
    fn asks_when_there_is_no_allow_once_option() {
        let params = json!({
            "toolCall": { "_meta": { "claudeCode": { "toolName": CLAUDE_OPEN_TOOL } } },
            "options": [{ "optionId": "no", "kind": "reject_once" }],
        });
        assert_eq!(auto_allow(&on(), &params), None);
    }

    #[test]
    fn auto_allow_needs_the_chats_settings() {
        let params = claude(CLAUDE_OPEN_TOOL);
        for cfg in [
            ToolsConfig::default(),
            ToolsConfig { enabled: false, ..on() },
            ToolsConfig { open: false, ..on() },
            ToolsConfig { open_auto_allow: false, ..on() },
        ] {
            assert_eq!(auto_allow(&cfg, &params), None, "{cfg:?}");
        }
    }

    #[test]
    fn other_adapters_are_matched_only_by_a_title_and_input_a_command_cannot_fake() {
        let call = |title: &str, input: Value| request(json!({ "title": title, "rawInput": input }));
        let cfg = on();
        assert_eq!(auto_allow(&cfg, &call("Tool: flowcode/open_in_browser", json!({ "target": "https://a.b" }))), None);
        assert_eq!(auto_allow(&cfg, &call("Tool: flowcode/open_in_browser", json!({ "target": "http://127.0.0.1:3000" }))).as_deref(), Some("once"));
        // A shell command that mentions both words is not the tool.
        assert_eq!(auto_allow(&cfg, &call("echo flowcode open_in_browser", json!({ "command": "echo flowcode open_in_browser" }))), None);
        assert_eq!(auto_allow(&cfg, &call("Tool: other/open_in_browser", json!({ "target": "x" }))), None);
        assert_eq!(auto_allow(&cfg, &request(json!({ "title": "flowcode open_in_browser" }))), None, "no input to check");
        // Claude's exact name is final, whatever the title says.
        let mut claude_other = claude("Bash");
        claude_other["toolCall"]["title"] = json!("flowcode open_in_browser");
        claude_other["toolCall"]["rawInput"] = json!({ "target": "x" });
        assert_eq!(auto_allow(&cfg, &claude_other), None);
    }

    #[test]
    fn auto_open_rejects_external_hosts_spoofed_metadata_and_home_files() {
        for target in ["https://attacker.invalid/?secret=abc", "http://localhost.attacker.invalid", "http://localhost@attacker.invalid", "http://192.168.1.1", "/home/alice/a.html"] {
            assert!(!safe_auto_open(target, "/repo"), "{target}");
        }
        for target in ["http://localhost:3000", "http://127.0.0.1", "http://[::1]:80", "docs/a.html"] {
            assert!(safe_auto_open(target, "/repo"), "{target}");
        }
        let mut params = claude(CLAUDE_OPEN_TOOL);
        params["toolCall"]["_meta"]["claudeCode"]["mcpServer"]["source"] = json!("project");
        assert_eq!(auto_allow(&on(), &params), None);
    }
}
