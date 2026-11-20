//! What the agents of a terminal tab get from Flowcode's MCP server
//! (`chat_mcp.rs`): `open_in_browser` and `call_user`. The tab's PTY carries the
//! server's settings in its environment; the shims of `provider_launcher.rs`
//! (which every `claude` / `codex` typed in the tab goes through) turn them into
//! the CLI's own flags, so the server reaches the agent without touching its
//! config files. A request is answered with an event on the tab's output stream
//! (`PtyEvent::Ext`), which the frontend routes like a chat's.

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::chat::delegate::{call_params, CALL_METHOD, OPEN_METHOD};
use crate::chat_mcp::{self, CALL_USER, OPEN};
use crate::pty::PtyState;

/// A tab's server: its token (revoked on drop), the tools it was given and the
/// environment its PTY carries.
pub(crate) struct TerminalMcp {
    token: String,
    tools: Vec<&'static str>,
    cwd: String,
    /// Claude's `--mcp-config` file for this tab, removed on drop.
    claude_config: Option<PathBuf>,
    env: Vec<(String, String)>,
}

impl TerminalMcp {
    /// `None` when the settings give a tab no tool, or the server cannot be set up.
    /// `cwd` is the folder the tab starts in; without one, the user's home.
    pub(crate) fn new(app: &AppHandle, pty_id: &str, cfg: &chat_mcp::ToolsConfig, cwd: Option<&str>) -> Option<TerminalMcp> {
        let tools = chat_mcp::terminal_tools(cfg);
        if tools.is_empty() {
            return None;
        }
        let (script, dir) = chat_mcp::script_and_dir(app)?;
        let cwd = match cwd.filter(|c| !c.is_empty()) {
            Some(cwd) => cwd.to_string(),
            None => crate::fs::user_home()?.to_string_lossy().into_owned(),
        };
        let token = chat_mcp::register_terminal(pty_id);
        let (script, dir_text) = (script.to_string_lossy().into_owned(), dir.to_string_lossy().into_owned());
        let tools_text = tools.join(",");
        // Next to the `ipc` folder, so the folder the poller watches stays free of it.
        let claude_config = dir.parent().map(|root| root.join(format!("term-{pty_id}.json"))).filter(|path| {
            let config = json!({ "mcpServers": { "flowcode": {
                "type": "stdio",
                "command": "node",
                "args": [script],
                "env": {
                    "FLOWCODE_MCP_DIR": dir_text,
                    "FLOWCODE_MCP_TOKEN": token,
                    "FLOWCODE_MCP_TOOLS": tools_text,
                    "FLOWCODE_MCP_AGENT": "claude",
                },
            } } });
            write_atomic(path, &config.to_string()).is_ok()
        });
        let mut env = vec![
            ("FLOWCODE_MCP_TOKEN".to_string(), token.clone()),
            ("FLOWCODE_MCP_DIR".to_string(), dir_text),
            ("FLOWCODE_MCP_SCRIPT".to_string(), script),
            ("FLOWCODE_MCP_TOOLS".to_string(), tools_text),
        ];
        if let Some(path) = &claude_config {
            env.push(("FLOWCODE_MCP_CLAUDE_CONFIG".to_string(), path.to_string_lossy().into_owned()));
        }
        // The CLI asks before using an MCP tool; these ask for nothing worth asking about.
        let mut allow = Vec::new();
        if tools.contains(&CALL_USER) {
            allow.push("mcp__flowcode__call_user");
        }
        if tools.contains(&OPEN) && cfg.open_auto_allow {
            allow.push("mcp__flowcode__open_in_browser");
        }
        if !allow.is_empty() {
            env.push(("FLOWCODE_MCP_AUTO_ALLOW".to_string(), allow.join(",")));
        }
        Some(TerminalMcp { token, tools, cwd, claude_config, env })
    }

    pub(crate) fn env(&self) -> &[(String, String)] {
        &self.env
    }

    pub(crate) fn tools(&self) -> &[&'static str] {
        &self.tools
    }

    pub(crate) fn cwd(&self) -> &str {
        &self.cwd
    }
}

impl Drop for TerminalMcp {
    fn drop(&mut self) {
        chat_mcp::unregister(&self.token);
        if let Some(path) = &self.claude_config {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Written whole or not at all: Claude may read the file the moment it exists.
fn write_atomic(path: &std::path::Path, body: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// The folder `open_in_browser` resolves paths against: where the agent really
/// is (`reported`) when that stays in the tab's folder or the user's home, else
/// the tab's own. The report is the script's word, so it is only a hint.
fn base_folder(reported: Option<&str>, tab_cwd: &str, homes: &[String]) -> String {
    match reported {
        Some(dir) if is_absolute(dir) && std::iter::once(tab_cwd).chain(homes.iter().map(String::as_str)).any(|root| chat_mcp::is_within(dir, root)) => dir.to_string(),
        _ => tab_cwd.to_string(),
    }
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/') || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
}

/// Runs a tool call of a terminal tab; see `chat_mcp::dispatch`. The tab must be
/// open and have been given the tool - the caller's word is not enough.
pub(crate) fn call(app: &AppHandle, pty_id: &str, tool: &str, args: &Value, reported_cwd: Option<&str>, agent: Option<&str>) -> Result<String, String> {
    let state = app.state::<PtyState>();
    let (tools, tab_cwd) = crate::pty::mcp_of(&state, pty_id).ok_or("this terminal tab is closed")?;
    if !tools.contains(&tool) {
        return Err(format!("the tool `{tool}` is not available in terminal tabs"));
    }
    match tool {
        OPEN => {
            let homes: Vec<String> = crate::fs::user_home().map(|p| p.to_string_lossy().into_owned()).into_iter().collect();
            let base = base_folder(reported_cwd, &tab_cwd, &homes);
            let target = args.get("target").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).ok_or("`target` is required")?;
            let target = chat_mcp::open_target(target, &base, &homes, None)?;
            crate::pty::emit_ext(&state, pty_id, OPEN_METHOD, json!({ "target": target, "cwd": base }))?;
            Ok("Sent to Flowcode. External links require user confirmation before opening.".to_string())
        }
        CALL_USER => {
            let mut params = call_params(args)?;
            params["agent"] = agent.map_or(Value::Null, |a| json!(a));
            crate::pty::emit_ext(&state, pty_id, CALL_METHOD, params)?;
            Ok("The user has been notified.".to_string())
        }
        _ => Err(format!("unknown tool `{tool}`")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_agents_folder_is_used_only_inside_the_tab_or_home() {
        let homes = vec!["C:/Users/Alice".to_string()];
        assert_eq!(base_folder(Some("C:/repo/sub"), "C:/repo", &homes), "C:/repo/sub");
        assert_eq!(base_folder(Some("C:\\Users\\Alice\\notes"), "C:/repo", &homes), "C:\\Users\\Alice\\notes");
        assert_eq!(base_folder(Some("D:/elsewhere"), "C:/repo", &homes), "C:/repo");
        assert_eq!(base_folder(Some("C:/repo/../x"), "C:/repo", &homes), "C:/repo");
        assert_eq!(base_folder(Some("sub"), "C:/repo", &homes), "C:/repo");
        assert_eq!(base_folder(Some("//host/share"), "C:/repo", &homes), "C:/repo");
        assert_eq!(base_folder(None, "C:/repo", &homes), "C:/repo");
    }
}
