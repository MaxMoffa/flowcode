//! The MCP server Flowcode hands to chat agents, so they can reach the app.
//! It answers tool calls without doing anything: the app reads them from the
//! chat stream, where every window and the phone already see them.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

const SERVER_NAME: &str = "flowcode";
const OPEN_TOOL: &str = "mcp__flowcode__open_in_browser";
const SCRIPT: &str = include_str!("flowcode-mcp.cjs");

/// Puts the script on disk, once per run: chats starting together share it, none sees it half written.
fn script_path(app: &AppHandle) -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let dir = app.path().app_local_data_dir().ok()?.join("mcp");
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join("flowcode-mcp.cjs");
        if std::fs::read_to_string(&path).ok().as_deref() != Some(SCRIPT) {
            std::fs::write(&path, SCRIPT).ok()?;
        }
        Some(path)
    })
    .as_ref()
}

fn server_entry(path: &str) -> Value {
    json!([{ "name": SERVER_NAME, "command": "node", "args": [path], "env": [] }])
}

/// The `mcpServers` of a session. Prototype: Claude on the host only - inside WSL
/// the script's Windows path means nothing, and other agents name tools differently.
pub(crate) fn servers(app: &AppHandle, agent: &str, wsl: bool) -> Value {
    if wsl || agent != "claude" {
        return json!([]);
    }
    match script_path(app).and_then(|path| path.to_str()) {
        Some(path) => server_entry(path),
        None => json!([]),
    }
}

/// The option that lets a `session/request_permission` through unasked, when it
/// is for the open tool: the call itself does nothing, and what the app then
/// opens is bound by the Browser settings. Never the "always" option: nothing
/// is written to the user's agent settings.
pub(crate) fn auto_allow(params: &Value) -> Option<String> {
    let tool = params.pointer("/toolCall/_meta/claudeCode/toolName").and_then(Value::as_str)?;
    if tool != OPEN_TOOL {
        return None;
    }
    let options = params.get("options")?.as_array()?;
    let once = options.iter().find(|o| o.get("kind").and_then(Value::as_str) == Some("allow_once"))?;
    once.get("optionId")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tool: &str) -> Value {
        json!({
            "toolCall": { "_meta": { "claudeCode": { "toolName": tool } } },
            "options": [
                { "optionId": "always", "kind": "allow_always" },
                { "optionId": "once", "kind": "allow_once" },
                { "optionId": "no", "kind": "reject_once" },
            ],
        })
    }

    #[test]
    fn allows_only_the_open_tool_and_only_once() {
        assert_eq!(auto_allow(&request(OPEN_TOOL)).as_deref(), Some("once"));
        assert_eq!(auto_allow(&request("Bash")), None);
        assert_eq!(auto_allow(&request("mcp__other__open_in_browser")), None);
        assert_eq!(auto_allow(&json!({ "toolCall": {}, "options": [] })), None);
    }

    #[test]
    fn asks_when_there_is_no_allow_once_option() {
        let params = json!({
            "toolCall": { "_meta": { "claudeCode": { "toolName": OPEN_TOOL } } },
            "options": [{ "optionId": "no", "kind": "reject_once" }],
        });
        assert_eq!(auto_allow(&params), None);
    }

    #[test]
    fn describes_a_stdio_server() {
        let servers = server_entry("C:\\mcp\\flowcode-mcp.cjs");
        assert_eq!(servers[0]["name"], "flowcode");
        assert_eq!(servers[0]["command"], "node");
        assert_eq!(servers[0]["args"][0], "C:\\mcp\\flowcode-mcp.cjs");
    }
}
