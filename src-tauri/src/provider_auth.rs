//! Private, bounded sign-in sessions shared by local windows and paired phones.
//! Native CLIs own OAuth, state/PKCE, token exchange and credential refresh.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::util::lock;

const LIFETIME: Duration = Duration::from_secs(15 * 60);
const MAX_OUTPUT: usize = 32 * 1024;
const MAX_SESSIONS: usize = 8;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthRequest {
    pub op: String,
    pub cli: String,
    pub profile: Option<String>,
    pub method: Option<String>,
    pub session_id: Option<String>,
    pub input: Option<String>,
    pub api_key: Option<String>,
    #[serde(default)]
    pub remote: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    cli: String,
    profile: Option<String>,
    method: Option<String>,
    phase: String,
    session_id: Option<String>,
    installed: bool,
    authenticated: bool,
    can_browser: bool,
    can_api_key: bool,
    output: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

enum Killer {
    Pty { killer: Box<dyn ChildKiller + Send + Sync>, pid: Option<u32> },
    Process(u32),
    Done,
}

impl Killer {
    /// Idempotent. On Windows the PTY child is `cmd.exe`; killing only it
    /// would orphan the provider's node process, so take down the whole tree.
    fn kill(&mut self) {
        match std::mem::replace(self, Self::Done) {
            Self::Pty { mut killer, pid } => {
                #[cfg(target_os = "windows")]
                if let Some(pid) = pid { kill_process_tree(pid); }
                #[cfg(not(target_os = "windows"))]
                let _ = pid;
                let _ = killer.kill();
            }
            Self::Process(pid) => kill_process_tree(pid),
            Self::Done => {}
        }
    }
}

fn kill_process_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(flowcode_shared::CREATE_NO_WINDOW).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = Command::new("kill").args(["-TERM", "--", &format!("-{}", pid)]).stdout(Stdio::null()).stderr(Stdio::null()).status(); }
}

struct AuthSession {
    owner: String,
    created: Instant,
    state: Mutex<AuthState>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Killer>,
    _master: Option<Mutex<Box<dyn MasterPty + Send>>>,
    exit: Mutex<Option<bool>>,
    stamp: Vec<(PathBuf, Option<std::time::SystemTime>, u64)>,
    settings: Mutex<Option<crate::provider_auth_keys::BrowserSettingsGuard>>,
    operation: Mutex<()>,
}

static SESSIONS: LazyLock<Mutex<HashMap<String, Arc<AuthSession>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// API-key verifications in flight, keyed by (owner, cli, profile). A key has
/// no session id, so `cancel` without one (dialog closed, phone disconnected)
/// flips this flag and the save aborts before committing anything.
type KeyOp = (String, String, Option<String>);
static KEY_OPS: LazyLock<Mutex<HashMap<KeyOp, Arc<AtomicBool>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn cancel_key_ops(matches: impl Fn(&KeyOp) -> bool) {
    for (op, flag) in lock(&KEY_OPS).iter() { if matches(op) { flag.store(true, Ordering::Release); } }
}

fn key_busy(cli: &str, profile: Option<&str>) -> bool {
    lock(&KEY_OPS).keys().any(|(_, c, p)| c == cli && p.as_deref() == profile)
}

fn state_for(app: &AppHandle, cli: &str, profile: Option<&str>, probe: bool) -> AuthState {
    let installed = crate::plugins::cli_is_installed(cli);
    let authenticated = probe && installed && (crate::provider_auth_keys::has_key(app, cli, profile)
        || crate::plugins::cli_is_logged_in(app, cli, profile));
    AuthState {
        cli: cli.into(), profile: profile.map(str::to_owned),
        method: crate::provider_auth_keys::method(app, cli, profile), phase: "idle".into(), session_id: None,
        installed, authenticated, can_browser: true, can_api_key: true, output: String::new(), url: None, code: None, error: None,
    }
}

fn validate_provider(cli: &str) -> Result<(), String> {
    if matches!(cli, "claude" | "codex" | "gemini" | "vibe") { Ok(()) } else { Err("unsupported_provider".into()) }
}

/// This is only a sign-in URL allowlist, never a general external-link opener.
fn safe_auth_url(cli: &str, raw: &str) -> Option<String> {
    let parsed: tauri::Url = raw.parse().ok()?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some() { return None; }
    let host = parsed.host_str()?;
    let allowed = match cli {
        "claude" => matches!(host, "claude.ai" | "console.anthropic.com" | "platform.claude.com"),
        "codex" => matches!(host, "auth.openai.com" | "chatgpt.com"),
        "gemini" => matches!(host, "accounts.google.com"),
        "vibe" => matches!(host, "console.mistral.ai" | "chat.mistral.ai" | "auth.mistral.ai"),
        _ => false,
    };
    allowed.then(|| parsed.into())
}

/// Strip terminal protocol sequences before parsing links; keep the original
/// bounded stream for the optional native provider steps.
fn plain_output(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                Some('[') => { for c in chars.by_ref() { if ('@'..='~').contains(&c) { break; } } }
                Some(']') => { while let Some(c) = chars.next() { if c == '\u{7}' || (c == '\u{1b}' && chars.peek() == Some(&'\\')) { if c == '\u{1b}' { chars.next(); } break; } } }
                _ => {}
            }
        } else if c == '\n' || c == '\r' || !c.is_control() { out.push(c); }
    }
    out
}

const PTY_COLS: u16 = 160;
const URL_END: [char; 8] = [' ', '\t', '\n', '\r', '<', '>', '"', '\''];

/// CLI output may hard-wrap long OAuth links at the terminal width. Join a
/// continuation only when the line was completely full and the next line
/// starts without indentation; a shorter line ends the link.
fn link_at(plain: &str, start: usize) -> String {
    let line_start = plain[..start].rfind('\n').map_or(0, |i| i + 1);
    let mut col = plain[line_start..start].chars().filter(|c| *c != '\r').count();
    let mut rest = &plain[start..];
    let mut url = String::new();
    loop {
        let end = rest.find(URL_END).unwrap_or(rest.len());
        url.push_str(&rest[..end]);
        col += rest[..end].chars().count();
        let after = &rest[end..];
        let next = after.trim_start_matches(['\r', '\n']);
        if col == PTY_COLS as usize && next.len() < after.len() && next.starts_with(|c: char| !c.is_whitespace()) {
            rest = next;
            col = 0;
            continue;
        }
        return url;
    }
}

fn parse_link(cli: &str, output: &str) -> Option<String> {
    let plain = plain_output(output);
    for (start, _) in plain.rmatch_indices("https://") {
        let link = link_at(&plain, start);
        if let Some(url) = safe_auth_url(cli, link.trim_end_matches(['.', ')', ','])) { return Some(url); }
    }
    None
}

fn parse_device_code(output: &str) -> Option<String> {
    // Device codes look like `ABCD-1234`: 2-3 groups of 4-5 uppercase
    // letters/digits with at least one letter, so dates and ids never match.
    plain_output(output).split_whitespace().find(|word| {
        let groups: Vec<&str> = word.split('-').collect();
        (2..=3).contains(&groups.len())
            && groups.iter().all(|g| (4..=5).contains(&g.len()) && g.bytes().all(|b| b.is_ascii_uppercase() || b.is_ascii_digit()))
            && word.bytes().any(|b| b.is_ascii_uppercase())
    }).map(str::to_owned)
}

fn append_output(session: &AuthSession, data: &str) {
    let mut state = lock(&session.state);
    if state.phase != "waiting" { return; }
    state.output.push_str(data);
    if state.output.len() > MAX_OUTPUT {
        let mut start = state.output.len() - MAX_OUTPUT;
        while !state.output.is_char_boundary(start) { start += 1; }
        state.output.drain(..start);
    }
    if let Some(url) = parse_link(&state.cli, &state.output) { state.url = Some(url); }
    if state.cli == "codex" { state.code = parse_device_code(&state.output); }
}

fn credential_stamp(app: &AppHandle, cli: &str, profile: Option<&str>) -> Vec<(PathBuf, Option<std::time::SystemTime>, u64)> {
    let Some(d) = crate::profiles::dirs(app, profile) else { return vec![]; };
    let paths = match cli {
        "claude" => vec![d.claude.join(".credentials.json"), d.claude.join(".claude.json")],
        "codex" => vec![d.codex.join("auth.json")],
        "gemini" => vec![d.gemini.join(".gemini/oauth_creds.json")],
        "vibe" => vec![d.vibe.join(".env")],
        _ => vec![],
    };
    paths.into_iter().map(|p| { let m = std::fs::metadata(&p).ok(); let modified = m.as_ref().and_then(|m| m.modified().ok()); let len = m.map_or(0, |m| m.len()); (p, modified, len) }).collect()
}

fn browser_env(app: &AppHandle, profile: Option<&str>) -> Vec<(String, String)> {
    let mut env = crate::profiles::env_for(app, profile);
    // Stored/inherited API keys must never override the explicit browser choice.
    const KEYS: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "MISTRAL_API_KEY"];
    env.retain(|(key, _)| !KEYS.contains(&key.as_str()));
    env.extend(KEYS.iter().map(|key| (key.to_string(), String::new())));
    env.push(("NO_BROWSER".into(), "true".into()));
    env
}

fn mark_error(session: &AuthSession, error: &str) {
    let mut state = lock(&session.state);
    if state.phase != "waiting" { return; }
    state.phase = "error".into(); state.error = Some(error.into()); state.url = None; state.code = None;
    // Native failure output can contain URLs/codes; do not retain it after failure.
    state.output.clear();
}

fn finish(app: &AppHandle, session: &AuthSession) -> Result<(), String> {
    let (cli, profile) = { let state = lock(&session.state); if state.phase != "waiting" { return Ok(()); } (state.cli.clone(), state.profile.clone()) };
    crate::provider_auth_keys::save_browser(app, &cli, profile.as_deref())?;
    if let Some(settings) = lock(&session.settings).take() { settings.commit(); }
    {
        let mut state = lock(&session.state);
        state.phase = "success".into(); state.authenticated = true; state.method = Some("browser".into());
        state.output.clear(); state.url = None; state.code = None;
    }
    lock(&session.killer).kill();
    let _ = app.emit("provider-authenticated", json!({"cli":cli,"profile":profile}));
    Ok(())
}

fn reap_expired() {
    let expired: Vec<_> = {
        let mut sessions = lock(&SESSIONS);
        let ids: Vec<_> = sessions.iter().filter(|(_, s)| s.created.elapsed() > LIFETIME).map(|(id, _)| id.clone()).collect();
        ids.into_iter().filter_map(|id| sessions.remove(&id)).collect()
    };
    for session in expired { lock(&session.killer).kill(); lock(&session.settings).take(); }
}

pub fn cancel_owner(owner: &str) {
    cancel_key_ops(|(o, _, _)| o == owner);
    let removed: Vec<_> = {
        let mut sessions = lock(&SESSIONS);
        let ids: Vec<_> = sessions.iter().filter(|(_, s)| s.owner == owner).map(|(id, _)| id.clone()).collect();
        ids.into_iter().filter_map(|id| sessions.remove(&id)).collect()
    };
    for session in removed {
        let _operation = lock(&session.operation);
        lock(&session.killer).kill(); lock(&session.settings).take();
        let mut state = lock(&session.state); state.phase = "cancelled".into(); state.output.clear(); state.url = None; state.code = None;
    }
}

fn send_rpc(session: &AuthSession, id: u64, method: &str, params: Value) -> Result<(), String> {
    let mut writer = lock(&session.writer);
    serde_json::to_writer(&mut *writer, &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})).map_err(|_| "auth_failed".to_string())?;
    writer.write_all(b"\n").and_then(|_| writer.flush()).map_err(|_| "auth_failed".into())
}

/// Vibe advertises delegated browser authentication through ACP. Its server
/// polls Mistral, so this URL also works on a phone without a PC loopback URL.
fn read_vibe(app: AppHandle, session: Arc<AuthSession>, stdout: impl Read) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break; };
        if line.len() > MAX_OUTPUT { mark_error(&session, "auth_failed"); break; }
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue; };
        if message.get("error").is_some() { mark_error(&session, "auth_failed"); break; }
        let result = &message["result"];
        let next = match message["id"].as_u64() {
            Some(1) => {
                let supported = result["authMethods"].as_array().is_some_and(|methods| methods.iter().any(|m| m["id"] == "browser-auth-delegated"));
                if !supported { mark_error(&session, "browser_unsupported"); break; }
                send_rpc(&session, 2, "authenticate", json!({"methodId":"browser-auth-delegated","action":"start"}))
            }
            Some(2) => {
                let meta = &result["_meta"]["browser-auth-delegated"];
                let Some(url) = meta["signInUrl"].as_str().and_then(|url| safe_auth_url("vibe", url)) else { mark_error(&session, "auth_failed"); break; };
                let Some(attempt) = meta["attemptId"].as_str() else { mark_error(&session, "auth_failed"); break; };
                lock(&session.state).url = Some(url);
                send_rpc(&session, 3, "authenticate", json!({"methodId":"browser-auth-delegated","action":"complete","attemptId":attempt}))
            }
            Some(3) => {
                if result["_meta"]["browser-auth-delegated"]["status"] == "completed" {
                    let _operation = lock(&session.operation);
                    if let Err(error) = finish(&app, &session) { mark_error(&session, &error); }
                } else { mark_error(&session, "auth_failed"); }
                break;
            }
            _ => Ok(()),
        };
        if next.is_err() { mark_error(&session, "auth_failed"); break; }
    }
    if lock(&session.state).phase == "waiting" { mark_error(&session, "auth_failed"); }
}

fn start(app: &AppHandle, owner: &str, mut state: AuthState, remote: bool) -> Result<AuthState, String> {
    reap_expired();
    let mut sessions = lock(&SESSIONS);
    if sessions.len() >= MAX_SESSIONS || sessions.values().any(|session| {
        let current = lock(&session.state);
        current.cli == state.cli && current.profile == state.profile && current.phase == "waiting"
    }) || key_busy(&state.cli, state.profile.as_deref()) { return Err("auth_busy".into()); }
    let id = uuid::Uuid::new_v4().to_string();
    state.session_id = Some(id.clone()); state.phase = "waiting".into(); state.method = Some("browser".into()); state.authenticated = false;
    let settings = crate::provider_auth_keys::prepare_browser(app, &state.cli, state.profile.as_deref())?;
    let stamp = credential_stamp(app, &state.cli, state.profile.as_deref());
    let env = browser_env(app, state.profile.as_deref());
    let neutral = app.path().app_config_dir().map_err(|_| "auth_failed")?;
    std::fs::create_dir_all(&neutral).map_err(|_| "auth_failed")?;
    if state.cli == "vibe" {
        #[cfg(target_os = "windows")]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut cmd = Command::new("cmd.exe"); cmd.args(["/D", "/C", "vibe-acp"]);
            cmd.creation_flags(flowcode_shared::CREATE_NO_WINDOW); cmd
        };
        #[cfg(not(target_os = "windows"))]
        let mut command = {
            use std::os::unix::process::CommandExt;
            let mut cmd = Command::new("vibe-acp"); cmd.process_group(0); cmd
        };
        command.current_dir(&neutral).envs(env).env("NoDefaultCurrentDirectoryInExePath", "1")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = command.spawn().map_err(|_| "browser_unsupported")?;
        let stdout = child.stdout.take().ok_or("auth_failed")?;
        let stdin = child.stdin.take().ok_or("auth_failed")?;
        let session = Arc::new(AuthSession { owner: owner.into(), created: Instant::now(), state: Mutex::new(state.clone()), writer: Mutex::new(Box::new(stdin)), killer: Mutex::new(Killer::Process(child.id())), _master: None, exit: Mutex::new(None), stamp, settings: Mutex::new(settings), operation: Mutex::new(()) });
        send_rpc(&session, 1, "initialize", json!({"protocolVersion":1,"clientInfo":{"name":"flowcode","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{"_meta":{"browser-auth-delegated":true}}}))?;
        sessions.insert(id, Arc::clone(&session));
        let handle = app.clone();
        let reader = Arc::clone(&session);
        std::thread::spawn(move || read_vibe(handle, reader, stdout));
        std::thread::spawn(move || { let success = child.wait().is_ok_and(|s| s.success()); *lock(&session.exit) = Some(success); });
    } else {
        #[cfg(target_os = "windows")]
        crate::pty::warmup_conpty();
        let pair = native_pty_system().openpty(PtySize { rows: 24, cols: PTY_COLS, pixel_width: 0, pixel_height: 0 }).map_err(|_| "auth_failed")?;
        let line = match state.cli.as_str() { "claude" => "claude auth login", "codex" if remote => "codex login --device-auth", "codex" => "codex login", "gemini" => "gemini", _ => return Err("unsupported_provider".into()) };
        #[cfg(target_os = "windows")]
        let mut command = { let mut cmd = CommandBuilder::new("cmd.exe"); cmd.args(["/D", "/C", line]); cmd };
        #[cfg(not(target_os = "windows"))]
        let mut command = { let mut cmd = CommandBuilder::new("/bin/sh"); cmd.args(["-c", &format!("exec {line}")]); cmd };
        command.cwd(&neutral);
        for (key, value) in env { command.env(key, value); }
        command.env("TERM", "xterm-256color"); command.env("NoDefaultCurrentDirectoryInExePath", "1");
        command.env_remove("CLAUDECODE"); command.env_remove("CLAUDE_CODE_ENTRYPOINT");
        let mut child = pair.slave.spawn_command(command).map_err(|_| "auth_failed")?;
        let reader = pair.master.try_clone_reader().map_err(|_| "auth_failed")?;
        let writer = pair.master.take_writer().map_err(|_| "auth_failed")?;
        drop(pair.slave);
        let session = Arc::new(AuthSession { owner: owner.into(), created: Instant::now(), state: Mutex::new(state.clone()), writer: Mutex::new(writer), killer: Mutex::new(Killer::Pty { killer: child.clone_killer(), pid: child.process_id() }), _master: Some(Mutex::new(pair.master)), exit: Mutex::new(None), stamp, settings: Mutex::new(settings), operation: Mutex::new(()) });
        sessions.insert(id, Arc::clone(&session));
        let reader_session = Arc::clone(&session);
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut bytes = [0; 4096];
            loop { match reader.read(&mut bytes) { Ok(0) | Err(_) => break, Ok(n) => append_output(&reader_session, &String::from_utf8_lossy(&bytes[..n])) } }
        });
        std::thread::spawn(move || { let success = child.wait().is_ok_and(|s| s.success()); *lock(&session.exit) = Some(success); });
    }
    // Reap even when a frontend vanishes without another request.
    std::thread::spawn(|| { std::thread::sleep(LIFETIME + Duration::from_secs(1)); reap_expired(); });
    Ok(state)
}

fn scoped_session(owner: &str, request: &AuthRequest) -> Result<Arc<AuthSession>, String> {
    let id = request.session_id.as_deref().ok_or("auth_session_missing")?;
    let session = lock(&SESSIONS).get(id).cloned().ok_or("auth_session_expired")?;
    let state = lock(&session.state);
    if session.owner != owner || state.cli != request.cli || state.profile != request.profile { return Err("auth_owner_mismatch".into()); }
    drop(state);
    Ok(session)
}

pub fn handle(app: &AppHandle, owner: &str, mut request: AuthRequest) -> Result<AuthState, String> {
    validate_provider(&request.cli)?;
    request.profile = request.profile.filter(|profile| !profile.is_empty());
    if crate::profiles::dirs(app, request.profile.as_deref()).is_none() { return Err("profile_not_found".into()); }
    match request.op.as_str() {
        "status" => Ok(state_for(app, &request.cli, request.profile.as_deref(), true)),
        "start" => {
            if request.method.as_deref().is_some_and(|method| method != "browser") { return Err("unsupported_method".into()); }
            let state = state_for(app, &request.cli, request.profile.as_deref(), false);
            if !state.installed { return Err("provider_not_installed".into()); }
            start(app, owner, state, request.remote)
        }
        "key" => {
            let mut state = state_for(app, &request.cli, request.profile.as_deref(), false);
            if !state.installed { return Err("provider_not_installed".into()); }
            let api_key = request.api_key.as_deref().ok_or("key_invalid")?;
            if lock(&SESSIONS).values().any(|session| { let s = lock(&session.state); s.cli == request.cli && s.profile == request.profile && s.phase == "waiting" }) { return Err("auth_busy".into()); }
            let op: KeyOp = (owner.to_owned(), request.cli.clone(), request.profile.clone());
            let cancelled = Arc::new(AtomicBool::new(false));
            {
                let mut ops = lock(&KEY_OPS);
                if ops.keys().any(|(_, c, p)| *c == op.1 && *p == op.2) { return Err("auth_busy".into()); }
                ops.insert(op.clone(), Arc::clone(&cancelled));
            }
            let saved = crate::provider_auth_keys::save_key_cancellable(app, &request.cli, request.profile.as_deref(), api_key, &cancelled);
            lock(&KEY_OPS).remove(&op);
            saved?;
            state.phase = "success".into(); state.authenticated = true; state.method = Some("apiKey".into());
            let _ = app.emit("provider-authenticated", json!({"cli":request.cli,"profile":request.profile}));
            Ok(state)
        }
        // A key verification has no session id: cancel it by owner/provider/profile.
        "cancel" if request.session_id.is_none() => {
            cancel_key_ops(|(o, c, p)| o == owner && *c == request.cli && *p == request.profile);
            let mut state = state_for(app, &request.cli, request.profile.as_deref(), false);
            state.phase = "cancelled".into();
            Ok(state)
        }
        "poll" | "input" | "cancel" => {
            let session = scoped_session(owner, &request)?;
            let _operation = lock(&session.operation);
            if request.op == "cancel" {
                lock(&SESSIONS).remove(request.session_id.as_deref().unwrap_or_default());
                lock(&session.killer).kill(); lock(&session.settings).take();
                let mut state = lock(&session.state); state.phase = "cancelled".into(); state.output.clear(); state.url = None; state.code = None;
                return Ok(state.clone());
            }
            if lock(&session.state).phase != "waiting" { return Ok(lock(&session.state).clone()); }
            if session.created.elapsed() > LIFETIME { mark_error(&session, "auth_expired"); lock(&session.killer).kill(); }
            if request.op == "input" {
                if request.cli == "vibe" { return Err("unsupported_input".into()); }
                let input = request.input.as_deref().ok_or("invalid_input")?;
                if input.len() > 8192 { return Err("invalid_input".into()); }
                let normalized = normalize_input(&request.cli, input)?;
                lock(&session.writer).write_all(normalized.as_bytes()).map_err(|_| "auth_session_ended")?;
            } else if request.cli != "vibe" {
                let exited = *lock(&session.exit);
                let changed = credential_stamp(app, &request.cli, request.profile.as_deref()) != session.stamp;
                if exited == Some(false) { mark_error(&session, "auth_failed"); }
                else if exited == Some(true) || changed {
                    let authenticated = match request.cli.as_str() {
                        "gemini" => crate::profiles::dirs(app, request.profile.as_deref()).is_some_and(|dirs| crate::gemini::has_login(&dirs.gemini)),
                        _ => crate::plugins::cli_is_logged_in(app, &request.cli, request.profile.as_deref()),
                    };
                    if authenticated { finish(app, &session)?; }
                    else if exited.is_some() { mark_error(&session, "auth_failed"); }
                }
            }
            let response = lock(&session.state).clone();
            Ok(response)
        }
        _ => Err("unsupported_auth_operation".into()),
    }
}

fn normalize_input(cli: &str, input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    // A phone may receive a failed localhost redirect instead of a displayed
    // code. Forward only the OAuth code (and Claude's state), never fetch a URL.
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let url: tauri::Url = trimmed.parse().map_err(|_| "invalid_input")?;
        let code = url.query_pairs().find(|(key, _)| key == "code").map(|(_, v)| v.into_owned()).ok_or("invalid_input")?;
        let state = url.query_pairs().find(|(key, _)| key == "state").map(|(_, v)| v.into_owned());
        return Ok(if cli == "claude" { state.map_or_else(|| format!("{code}\r"), |state| format!("{code}#{state}\r")) } else { format!("{code}\r") });
    }
    Ok(input.to_owned())
}

#[tauri::command]
pub async fn provider_auth(app: AppHandle, window: tauri::WebviewWindow, request: AuthRequest) -> Result<AuthState, String> {
    let owner = format!("desktop:{}", window.label());
    crate::blocking(move || handle(&app, &owner, request)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn auth_links_are_exact_vendor_origins() {
        assert!(safe_auth_url("claude", "https://claude.ai/oauth/authorize?state=a").is_some());
        assert!(safe_auth_url("codex", "https://auth.openai.com/codex/device").is_some());
        assert!(safe_auth_url("gemini", "https://accounts.google.com/o/oauth2/auth").is_some());
        assert!(safe_auth_url("vibe", "https://console.mistral.ai/login").is_some());
        for url in ["https://claude.ai.evil.com/login", "http://claude.ai/login", "https://evil@claude.ai/login", "https://claude.ai:8443/login", "javascript:alert(1)"] { assert!(safe_auth_url("claude", url).is_none()); }
    }
    #[test]
    fn extracts_ansi_links_and_device_codes_without_control_sequences() {
        assert_eq!(parse_link("codex", "Open \u{1b}[32mhttps://auth.openai.com/codex/device\u{1b}[0m\r\nCode: ABCD-1234"), Some("https://auth.openai.com/codex/device".into()));
        assert_eq!(parse_device_code("Code: \u{1b}[1mABCD-1234\u{1b}[0m"), Some("ABCD-1234".into()));
        assert!(parse_device_code("WARNING auth_failed 2026-11-07").is_none());
    }
    #[test]
    fn joins_links_hard_wrapped_at_terminal_width_only() {
        let url = format!("https://claude.ai/oauth/authorize?code=true&state={}", "a".repeat(200));
        let (head, tail) = url.split_at(PTY_COLS as usize - 4);
        assert_eq!(parse_link("claude", &format!("    {head}\r\n{tail}\r\nPaste code here")), Some(url.clone()));
        // A line shorter than the terminal is a complete link.
        assert_eq!(parse_link("claude", "Visit https://claude.ai/login\r\nPaste code here"), Some("https://claude.ai/login".into()));
    }
    #[test]
    fn sessionless_cancel_flags_only_matching_key_operation() {
        let mine: KeyOp = ("desktop:test-a".into(), "codex".into(), None);
        let other: KeyOp = ("desktop:test-b".into(), "codex".into(), None);
        let (a, b) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
        lock(&KEY_OPS).insert(mine.clone(), Arc::clone(&a));
        lock(&KEY_OPS).insert(other.clone(), Arc::clone(&b));
        cancel_owner("desktop:test-a");
        assert!(a.load(Ordering::Acquire) && !b.load(Ordering::Acquire));
        lock(&KEY_OPS).remove(&mine);
        lock(&KEY_OPS).remove(&other);
    }
    #[test]
    fn callback_urls_become_codes_and_are_never_fetched() {
        assert_eq!(normalize_input("claude", "http://localhost:5321/callback?code=abc&state=def\r").unwrap(), "abc#def\r");
        assert_eq!(normalize_input("gemini", "http://localhost:5321/oauth2callback?code=abc&state=def").unwrap(), "abc\r");
        assert!(normalize_input("claude", "https://example.com/?error=denied").is_err());
        assert_eq!(normalize_input("gemini", "\u{1b}[A").unwrap(), "\u{1b}[A");
    }
}
