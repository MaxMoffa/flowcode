//! The permission mode of the agent running in a terminal tab, for the delegations it asks for: a
//! child must not be freer than the agent that launches it (`chat/delegate.rs` `inherited_mode`).
//!
//! Where each CLI says it:
//! - Claude Code: the newest `permissionMode` in its transcript (`permission-mode` and user entries);
//! - Codex: the newest `turn_context` of its rollout (`collaboration_mode` plan, else the sandbox);
//! - Gemini: the `--approval-mode` / `--yolo` flag it was started with;
//! - Vibe, OpenCode, Cline: nothing readable from outside, and agents inside WSL are not read either.
//!
//! What cannot be read is `None`; the caller then treats the tab as restricted.

use serde_json::Value;
use tauri::AppHandle;

/// What is known of a tab's agent.
#[derive(Default)]
pub(crate) struct TabAgent {
    /// The CLI actually found in the tab (`claude`, `codex`, ...).
    pub cli: Option<String>,
    /// Its mode in the words `inherited_mode` knows (`plan`, `read-only`, `default`, ...).
    pub mode: Option<String>,
}

/// Looks the tab's agent up. Slow (a process scan and a transcript read): call it only for a delegation.
pub(crate) fn of_tab(app: &AppHandle, pty_id: &str) -> TabAgent {
    let sessions = tauri::async_runtime::block_on(crate::agents::collect_agent_sessions(app)).unwrap_or_default();
    let Some(session) = sessions.into_iter().find(|s| s.pty_id == pty_id) else { return TabAgent::default() };
    let cli = session.cli.clone();
    // Inside WSL the pid is a Linux one and the files are on the other side.
    if session.wsl_distro.is_some() {
        return TabAgent { cli: Some(cli), mode: None };
    }
    let pid = serde_json::to_value(&session).ok().and_then(|v| v.get("pid")?.as_u64()).map(|p| p as u32);
    let argv = pid.map(argv_of).unwrap_or_default();
    let dirs = crate::profiles::dirs(app, session.profile.as_deref());
    let id = session.session_id.as_deref().filter(|id| crate::agents::is_safe_session_id(id));
    let from_file = match (cli.as_str(), dirs, id) {
        ("claude", Some(dirs), Some(id)) => crate::context::find_claude_transcript(&dirs.claude, id).and_then(|path| newest(&path, claude_line_mode)),
        ("codex", Some(dirs), Some(id)) => {
            crate::agents::find_codex_rollout(&dirs.codex.join("sessions"), id).and_then(|path| newest(&path, codex_line_mode))
        }
        _ => None,
    };
    let mode = from_file.or_else(|| argv_mode(&cli, &argv));
    TabAgent { cli: Some(cli), mode }
}

fn argv_of(pid: u32) -> Vec<String> {
    crate::system::with_processes(|sys| {
        sys.process(sysinfo::Pid::from_u32(pid)).map(|p| p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect()).unwrap_or_default()
    })
}

/// The first line from the end of `path` that `read` takes a mode from.
fn newest(path: &std::path::Path, read: fn(&[u8]) -> Option<String>) -> Option<String> {
    crate::agents::scan_lines_backwards(path, 64 * 1024, 16 * 1024 * 1024, read)
}

/// The modes of Claude Code, the only ones passed on (an unknown word is not a mode).
const CLAUDE_MODES: [&str; 6] = ["default", "acceptEdits", "plan", "auto", "bypassPermissions", "dontAsk"];

/// The mode a Claude Code transcript line names, if it names a known one.
pub(crate) fn claude_line_mode(line: &[u8]) -> Option<String> {
    const KEY: &[u8] = b"\"permissionMode\"";
    if !line.windows(KEY.len()).any(|w| w == KEY) {
        return None;
    }
    let value: Value = serde_json::from_slice(line).ok()?;
    let mode = value.get("permissionMode")?.as_str()?;
    CLAUDE_MODES.contains(&mode).then(|| mode.to_string())
}

/// The mode a Codex rollout line names: `turn_context` lines only. A plan collaboration mode wins, then the sandbox.
pub(crate) fn codex_line_mode(line: &[u8]) -> Option<String> {
    const KEY: &[u8] = b"\"turn_context\"";
    if !line.windows(KEY.len()).any(|w| w == KEY) {
        return None;
    }
    let value: Value = serde_json::from_slice(line).ok()?;
    if value.get("type")?.as_str()? != "turn_context" {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("collaboration_mode").and_then(|m| m.get("mode")).and_then(Value::as_str) == Some("plan") {
        return Some("plan".into());
    }
    let sandbox = payload.get("sandbox_policy")?;
    let sandbox = sandbox.get("type").and_then(Value::as_str).or_else(|| sandbox.as_str())?;
    match sandbox {
        "read-only" => Some("read-only"),
        "workspace-write" => Some("workspace-write"),
        "danger-full-access" => Some("full-access"),
        _ => None,
    }
    .map(str::to_string)
}

/// The mode a CLI was started in, from its command line. It is what a CLI whose current mode cannot
/// be read is left with, and what a transcript without a mode yet falls back to.
pub(crate) fn argv_mode(cli: &str, argv: &[String]) -> Option<String> {
    let value_of = |names: &[&str]| -> Option<String> {
        let mut found = None;
        let mut args = argv.iter();
        while let Some(arg) = args.next() {
            for name in names {
                if arg == name {
                    found = args.next().cloned();
                } else if let Some(v) = arg.strip_prefix(&format!("{name}=")) {
                    found = Some(v.to_string());
                }
            }
        }
        found
    };
    let has = |names: &[&str]| argv.iter().any(|a| names.contains(&a.as_str()));
    match cli {
        "claude" => {
            let mode = value_of(&["--permission-mode"]);
            match mode {
                Some(m) if CLAUDE_MODES.contains(&m.as_str()) => Some(m),
                Some(_) => None,
                None if has(&["--dangerously-skip-permissions"]) => Some("bypassPermissions".into()),
                None => None,
            }
        }
        "codex" => {
            if has(&["--dangerously-bypass-approvals-and-sandbox", "--yolo"]) {
                return Some("full-access".into());
            }
            match value_of(&["--sandbox", "-s"]).as_deref() {
                Some("read-only") => Some("read-only".into()),
                Some("workspace-write") => Some("workspace-write".into()),
                Some("danger-full-access") => Some("full-access".into()),
                Some(_) => None,
                None if has(&["--full-auto"]) => Some("workspace-write".into()),
                None => None,
            }
        }
        "gemini" => match value_of(&["--approval-mode"]).as_deref() {
            Some("plan") => Some("plan".into()),
            Some("default") => Some("default".into()),
            Some("auto_edit") => Some("autoEdit".into()),
            Some("yolo") => Some("yolo".into()),
            Some(_) => None,
            None if has(&["--yolo", "-y"]) => Some("yolo".into()),
            None => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(s: &str) -> Vec<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn claude_lines_name_the_mode() {
        let user = br#"{"type":"user","promptId":"x","message":{"role":"user","content":"hi"},"permissionMode":"plan"}"#;
        assert_eq!(claude_line_mode(user).as_deref(), Some("plan"));
        let entry = br#"{"type":"permission-mode","permissionMode":"auto","sessionId":"s"}"#;
        assert_eq!(claude_line_mode(entry).as_deref(), Some("auto"));
        assert_eq!(claude_line_mode(br#"{"type":"assistant"}"#), None);
        assert_eq!(claude_line_mode(br#"{"permissionMode":"somethingnew"}"#), None);
        assert_eq!(claude_line_mode(b"not json permissionMode"), None);
        assert_eq!(claude_line_mode(br#"{"text":"the \"permissionMode\" word"}"#), None);
    }

    #[test]
    fn codex_turn_contexts_name_the_mode() {
        let line = |extra: &str| format!(r#"{{"type":"turn_context","payload":{{"cwd":"C:\\p",{extra}}}}}"#);
        let ro = line(r#""collaboration_mode":{"mode":"default"},"sandbox_policy":{"type":"read-only"}"#);
        assert_eq!(codex_line_mode(ro.as_bytes()).as_deref(), Some("read-only"));
        let plan = line(r#""collaboration_mode":{"mode":"plan"},"sandbox_policy":{"type":"workspace-write"}"#);
        assert_eq!(codex_line_mode(plan.as_bytes()).as_deref(), Some("plan"));
        let full = line(r#""sandbox_policy":{"type":"danger-full-access"}"#);
        assert_eq!(codex_line_mode(full.as_bytes()).as_deref(), Some("full-access"));
        let ww = line(r#""sandbox_policy":{"type":"workspace-write","writable_roots":[]}"#);
        assert_eq!(codex_line_mode(ww.as_bytes()).as_deref(), Some("workspace-write"));
        assert_eq!(codex_line_mode(line(r#""sandbox_policy":{"type":"weird"}"#).as_bytes()), None);
        assert_eq!(codex_line_mode(br#"{"type":"event_msg","payload":{"text":"turn_context"}}"#), None);
    }

    #[test]
    fn command_lines_name_the_starting_mode() {
        assert_eq!(argv_mode("claude", &argv("claude --permission-mode plan")).as_deref(), Some("plan"));
        assert_eq!(argv_mode("claude", &argv("claude --permission-mode=acceptEdits")).as_deref(), Some("acceptEdits"));
        assert_eq!(argv_mode("claude", &argv("claude --dangerously-skip-permissions")).as_deref(), Some("bypassPermissions"));
        assert_eq!(argv_mode("claude", &argv("claude --permission-mode bogus")), None);
        assert_eq!(argv_mode("claude", &argv("claude")), None);
        assert_eq!(argv_mode("codex", &argv("codex -s read-only")).as_deref(), Some("read-only"));
        assert_eq!(argv_mode("codex", &argv("codex --sandbox=workspace-write")).as_deref(), Some("workspace-write"));
        assert_eq!(argv_mode("codex", &argv("codex --full-auto")).as_deref(), Some("workspace-write"));
        assert_eq!(argv_mode("codex", &argv("codex --dangerously-bypass-approvals-and-sandbox")).as_deref(), Some("full-access"));
        assert_eq!(argv_mode("gemini", &argv("gemini --approval-mode plan")).as_deref(), Some("plan"));
        assert_eq!(argv_mode("gemini", &argv("gemini --approval-mode auto_edit")).as_deref(), Some("autoEdit"));
        assert_eq!(argv_mode("gemini", &argv("gemini --yolo")).as_deref(), Some("yolo"));
        assert_eq!(argv_mode("gemini", &argv("gemini")), None);
        assert_eq!(argv_mode("opencode", &argv("opencode --agent plan")), None);
    }
}
