//! What the agents of a terminal tab get from Flowcode's MCP server
//! (`chat_mcp.rs`): `open_in_browser`, `call_user` and the delegation tools. The tab's PTY carries the
//! server's settings in its environment; the shims of `provider_launcher.rs`
//! (Windows tabs) and `wsl-shell/shim.sh` (WSL tabs), which every `claude` /
//! `codex` typed in the tab goes through, turn them into the CLI's own flags, so
//! the server reaches the agent without touching its config files. OpenCode
//! reads its servers from an environment variable instead. A request is answered
//! with an event on the tab's output stream (`PtyEvent::Ext`), which the
//! frontend routes like a chat's.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::chat::delegate::{call_params, ParentCtx, CALL_METHOD, OPEN_METHOD};
use crate::chat_mcp::{self, CALL_USER, OPEN};
use crate::pty::PtyState;

#[path = "tab_agent_mode.rs"]
mod tab_agent_mode;

const SHELL_SH: &str = include_str!("wsl-shell/shell.sh");
const BASHRC: &str = include_str!("wsl-shell/bashrc");
const SHIM_SH: &str = include_str!("wsl-shell/shim.sh");

/// A tab's server: its token (revoked on drop), the tools it was given and the
/// environment its PTY carries.
pub(crate) struct TerminalMcp {
    token: String,
    tools: Vec<&'static str>,
    /// The settings the tab was given its tools by, for the delegations it asks for.
    cfg: chat_mcp::ToolsConfig,
    app: AppHandle,
    pty_id: String,
    /// The tab's folder (a Linux path for a WSL tab, whose folder may be unknown).
    cwd: Option<String>,
    /// A WSL tab: its distro's name, empty for the default distro.
    wsl: Option<String>,
    /// Claude's `--mcp-config` file for this tab, removed on drop.
    claude_config: Option<PathBuf>,
    env: Vec<(String, String)>,
}

/// What `call` needs to know of a tab.
pub(crate) struct Info {
    pub(crate) tools: Vec<&'static str>,
    pub(crate) cfg: chat_mcp::ToolsConfig,
    pub(crate) cwd: Option<String>,
    pub(crate) wsl: Option<String>,
}

impl TerminalMcp {
    /// `None` when the settings give a tab no tool, or the server cannot be set up.
    /// `cwd` is the folder the tab starts in; without one, the user's home.
    pub(crate) fn new(app: &AppHandle, pty_id: &str, cfg: &chat_mcp::ToolsConfig, cwd: Option<&str>) -> Option<TerminalMcp> {
        let cwd = match cwd.filter(|c| !c.is_empty()) {
            Some(cwd) => cwd.to_string(),
            None => crate::fs::user_home()?.to_string_lossy().into_owned(),
        };
        Self::build(app, pty_id, cfg, Some(cwd), None)
    }

    /// A tab running in WSL: the agent sees Linux paths, the files stay on the
    /// Windows side. `distro` is `None` for the default distro; `posix_cwd` is
    /// unknown when the tab starts in the distro's own home.
    pub(crate) fn new_wsl(app: &AppHandle, pty_id: &str, cfg: &chat_mcp::ToolsConfig, posix_cwd: Option<&str>, distro: Option<&str>) -> Option<TerminalMcp> {
        let cwd = posix_cwd.filter(|c| !c.is_empty()).map(str::to_string);
        Self::build(app, pty_id, cfg, cwd, Some(distro.unwrap_or("").to_string()))
    }

    fn build(app: &AppHandle, pty_id: &str, cfg: &chat_mcp::ToolsConfig, cwd: Option<String>, wsl: Option<String>) -> Option<TerminalMcp> {
        let tools = chat_mcp::terminal_tools(cfg);
        if tools.is_empty() {
            return None;
        }
        let (script_path, dir_path) = chat_mcp::script_and_dir(app)?;
        // A path as the agent sees it: a Linux path inside WSL.
        let seen = |path: &Path| -> Option<String> {
            let text = path.to_str()?;
            if wsl.is_some() { crate::chat::to_wsl_path(text) } else { Some(text.to_string()) }
        };
        let (script, dir_text) = (seen(&script_path)?, seen(&dir_path)?);
        // Next to the `ipc` folder, so the folder the poller watches stays free of it.
        let claude_path = dir_path.parent().map(|root| root.join(format!("term-{pty_id}.json")));
        let claude_seen = match &claude_path {
            Some(path) => Some(seen(path)?),
            None => None,
        };
        let token = chat_mcp::register_terminal(pty_id);
        let tools_text = tools.join(",");
        let claude_config = claude_path.filter(|path| {
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
            ("FLOWCODE_MCP_DIR".to_string(), dir_text.clone()),
            ("FLOWCODE_MCP_SCRIPT".to_string(), script.clone()),
            ("FLOWCODE_MCP_TOOLS".to_string(), tools_text.clone()),
        ];
        if let (Some(_), Some(path)) = (&claude_config, claude_seen) {
            env.push(("FLOWCODE_MCP_CLAUDE_CONFIG".to_string(), path));
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
        // A WSL tab never carries the user's own (the variable is not in its WSLENV).
        let existing = if wsl.is_none() { std::env::var("OPENCODE_CONFIG_CONTENT").ok() } else { None };
        if let Some(config) = opencode_config(existing.as_deref(), &script, &dir_text, &token, &tools_text) {
            env.push(("OPENCODE_CONFIG_CONTENT".to_string(), config));
        }
        Some(TerminalMcp { token, tools, cfg: cfg.clone(), app: app.clone(), pty_id: pty_id.to_string(), cwd, wsl, claude_config, env })
    }

    pub(crate) fn env(&self) -> &[(String, String)] {
        &self.env
    }

    /// Whether the tab may use `open_in_browser`: then what its processes open is routed through Flowcode.
    pub(crate) fn opens(&self) -> bool {
        self.tools.contains(&OPEN)
    }

    pub(crate) fn info(&self) -> Info {
        Info { tools: self.tools.clone(), cfg: self.cfg.clone(), cwd: self.cwd.clone(), wsl: self.wsl.clone() }
    }
}

impl Drop for TerminalMcp {
    fn drop(&mut self) {
        chat_mcp::unregister(&self.token);
        if let Some(path) = &self.claude_config {
            let _ = std::fs::remove_file(path);
        }
        // Its tasks end with the tab. This may run under the pty map lock: the work is on another thread.
        crate::chat::delegate::terminal_closed(&self.app, &self.pty_id);
    }
}

/// OpenCode's `OPENCODE_CONFIG_CONTENT` with Flowcode's server added to the
/// user's own (`existing`), which is kept. `None` when the user's is not a JSON
/// object: theirs wins rather than being replaced.
fn opencode_config(existing: Option<&str>, script: &str, dir: &str, token: &str, tools: &str) -> Option<String> {
    let mut config = match existing.map(str::trim).filter(|t| !t.is_empty()) {
        None => json!({}),
        Some(text) => serde_json::from_str::<Value>(text).ok().filter(Value::is_object)?,
    };
    let mcp = config.as_object_mut()?.entry("mcp").or_insert_with(|| json!({}));
    if !mcp.is_object() {
        return None;
    }
    mcp["flowcode"] = json!({
        "type": "local",
        "command": ["node", script],
        "environment": {
            "FLOWCODE_MCP_DIR": dir,
            "FLOWCODE_MCP_TOKEN": token,
            "FLOWCODE_MCP_TOOLS": tools,
            "FLOWCODE_MCP_AGENT": "opencode",
        },
        "enabled": true,
    });
    Some(config.to_string())
}

/// The startup script and the agent shims of WSL tabs, as Linux paths:
/// `(shell.sh, shim folder)`. Written under the app's data folder once per run
/// (a failure is retried by the next WSL tab).
pub(crate) fn wsl_shell(app: &AppHandle) -> Option<(String, String)> {
    static READY: OnceLock<(String, String)> = OnceLock::new();
    static INIT: Mutex<()> = Mutex::new(());
    let _init = INIT.lock().unwrap_or_else(|e| e.into_inner());
    if READY.get().is_none() {
        match write_wsl_shell(app) {
            Some(paths) => { let _ = READY.set(paths); }
            None => eprintln!("mcp: WSL shell files not written; the next WSL tab will retry"),
        }
    }
    READY.get().cloned()
}

fn write_wsl_shell(app: &AppHandle) -> Option<(String, String)> {
    let root = app.path().app_local_data_dir().ok()?.join("mcp").join("wsl");
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).ok()?;
    // A Windows checkout may have turned the embedded files CRLF; sh would choke on it.
    let lf = |text: &str| text.replace("\r\n", "\n");
    let skip = |cli: &str| crate::provider_launcher::skips_mcp(cli).join("|");
    let shim = lf(SHIM_SH).replace("@CLAUDE_SKIP@", &skip("claude")).replace("@CODEX_SKIP@", &skip("codex"));
    let shell = root.join("shell.sh");
    write_if_changed(&shell, &lf(SHELL_SH)).ok()?;
    write_if_changed(&root.join("bashrc"), &lf(BASHRC)).ok()?;
    for cli in ["claude", "codex"] {
        write_if_changed(&bin.join(cli), &shim).ok()?;
    }
    // Openers that hand a page to Flowcode's browser settings (see browser_open.rs); BROWSER points to `flowcode-open`.
    let opener = crate::browser_open::shim_script();
    for name in crate::browser_open::WSL_NAMES {
        write_if_changed(&bin.join(name), &opener).ok()?;
    }
    Some((crate::chat::to_wsl_path(shell.to_str()?)?, crate::chat::to_wsl_path(bin.to_str()?)?))
}

fn write_if_changed(path: &Path, body: &str) -> std::io::Result<()> {
    if std::fs::read_to_string(path).ok().as_deref() == Some(body) {
        return Ok(());
    }
    write_atomic(path, body)
}

/// Written whole or not at all: an agent may read the file the moment it exists.
fn write_atomic(path: &Path, body: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
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

/// Where a tab's agent is: its distro (WSL tabs), the folders it may name, and the folder relative paths mean.
struct Place {
    distro: Option<String>,
    homes: Vec<String>,
    base: String,
}

fn locate(wsl: Option<String>, cwd: Option<String>, reported_cwd: Option<&str>) -> Place {
    let mut homes: Vec<String> = crate::fs::user_home().map(|p| p.to_string_lossy().into_owned()).into_iter().collect();
    // Looked up here, never at spawn: asking WSL may run wsl.exe.
    let distro = wsl.map(|d| if d.is_empty() { crate::util::wsl_default_distro().unwrap_or_default() } else { d });
    let tab_cwd = match &distro {
        Some(distro) => {
            homes.extend(homes.clone().iter().filter_map(|home| crate::chat::to_wsl_path(home)));
            let wsl_home = Some(distro).filter(|d| !d.is_empty()).and_then(|d| crate::util::wsl_home(d));
            homes.extend(wsl_home.clone());
            cwd.or(wsl_home).or_else(|| homes.iter().find(|h| h.starts_with('/')).cloned()).unwrap_or_default()
        }
        None => cwd.unwrap_or_default(),
    };
    let base = base_folder(reported_cwd, &tab_cwd, &homes);
    Place { distro, homes, base }
}

/// The folder and shell a child chat of a delegation asked from a tab starts with: the Windows-side
/// path of the agent's folder, and `wsl:<distro>` when the tab is a WSL one (a chat takes the shell from there).
fn child_place(place: &Place, wsl_tab: bool) -> Result<(String, Option<String>), String> {
    if !wsl_tab {
        return Ok((place.base.clone(), None));
    }
    let distro = Some(place.distro.as_deref().unwrap_or("")).filter(|d| !d.is_empty()).ok_or("could not find the WSL distro of this tab")?;
    Ok((crate::chat_images::from_wsl_path(&place.base, distro)?, Some(format!("wsl:{distro}"))))
}

/// The mode a tab's children are held to: the agent's own, and read-only when it could not be read
/// (a child never gets more freedom than a parent that might be restricted).
fn parent_mode(mode: Option<String>) -> String {
    mode.unwrap_or_else(|| "read-only".to_string())
}

/// Runs a tool call of a terminal tab; see `chat_mcp::dispatch`. The tab must be
/// open and have been given the tool - the caller's word is not enough.
pub(crate) fn call(app: &AppHandle, pty_id: &str, tool: &str, args: &Value, reported_cwd: Option<&str>, agent: Option<&str>, deadline_ms: Option<u64>) -> Result<String, String> {
    let state = app.state::<PtyState>();
    let Info { tools, cfg, cwd, wsl } = crate::pty::mcp_of(&state, pty_id).ok_or("this terminal tab is closed")?;
    if !tools.contains(&tool) {
        return Err(format!("the tool `{tool}` is not available in terminal tabs"));
    }
    match tool {
        OPEN => {
            let Place { distro, homes, base } = locate(wsl, cwd, reported_cwd);
            let target = args.get("target").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).ok_or("`target` is required")?;
            let target = chat_mcp::open_target(target, &base, &homes, distro.as_deref())?;
            crate::pty::emit_ext(&state, pty_id, OPEN_METHOD, json!({ "target": target, "cwd": base, "distro": distro }))?;
            Ok("Sent to Flowcode. External links require user confirmation before opening.".to_string())
        }
        CALL_USER => {
            let mut params = call_params(args)?;
            params["agent"] = agent.map_or(Value::Null, |a| json!(a));
            crate::pty::emit_ext(&state, pty_id, CALL_METHOD, params)?;
            Ok("The user has been notified.".to_string())
        }
        chat_mcp::LIST_AGENTS | chat_mcp::DELEGATE_TASK | chat_mcp::GET_TASK_RESULT | chat_mcp::CANCEL_TASK => {
            let (window, profile) = crate::pty::window_and_profile(&state, pty_id)?;
            let wsl_tab = wsl.is_some();
            let place = locate(wsl, cwd, reported_cwd);
            let (cwd, shell) = child_place(&place, wsl_tab)?;
            // Only asked for a task that starts a child: the lookup scans processes and reads a transcript.
            let (agent, mode) = if tool == chat_mcp::DELEGATE_TASK {
                let tab = tab_agent_mode::of_tab(app, pty_id);
                (tab.cli.or_else(|| agent.map(str::to_string)), Some(parent_mode(tab.mode)))
            } else {
                (agent.map(str::to_string), None)
            };
            let ctx = ParentCtx {
                owner: chat_mcp::Owner::Terminal(pty_id.to_string()),
                window,
                agent,
                cwd,
                profile,
                shell,
                tools: cfg,
                mode,
                depth: 0,
            };
            crate::chat::delegate::terminal_delegation_call(app, ctx, tool, args, deadline_ms)
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

    #[test]
    fn a_tab_whose_mode_is_unknown_is_restricted() {
        assert_eq!(parent_mode(None), "read-only");
        assert_eq!(parent_mode(Some("plan".into())), "plan");
        assert_eq!(parent_mode(Some("auto".into())), "auto");
    }

    #[test]
    fn a_wsl_tabs_children_start_on_the_windows_side() {
        let place = |distro: Option<&str>, base: &str| Place { distro: distro.map(str::to_string), homes: vec![], base: base.to_string() };
        assert_eq!(child_place(&place(None, "C:/repo"), false).unwrap(), ("C:/repo".to_string(), None));
        let (cwd, shell) = child_place(&place(Some("Ubuntu"), "/mnt/c/repo/sub"), true).unwrap();
        assert_eq!((cwd.as_str(), shell.as_deref()), (r"C:\repo\sub", Some("wsl:Ubuntu")));
        assert_eq!(child_place(&place(Some("Ubuntu"), "/mnt/c"), true).unwrap().0, r"C:\");
        assert_eq!(child_place(&place(Some("Debian"), "/home/me/app"), true).unwrap().0, r"\\wsl.localhost\Debian\home\me\app");
        assert!(child_place(&place(Some(""), "/home/me"), true).is_err());
        assert!(child_place(&place(None, "/home/me"), true).is_err());
    }

    fn opencode(existing: Option<&str>) -> Option<Value> {
        opencode_config(existing, "/s.cjs", "/ipc", "tok", "call_user").map(|c| serde_json::from_str(&c).unwrap())
    }

    #[test]
    fn opencode_gets_the_server_alone_when_the_user_has_no_config() {
        let config = opencode(None).unwrap();
        assert_eq!(config["mcp"]["flowcode"]["command"], json!(["node", "/s.cjs"]));
        assert_eq!(config["mcp"]["flowcode"]["environment"]["FLOWCODE_MCP_TOKEN"], "tok");
        assert_eq!(config["mcp"]["flowcode"]["environment"]["FLOWCODE_MCP_AGENT"], "opencode");
        assert_eq!(config["mcp"]["flowcode"]["enabled"], true);
        assert_eq!(opencode(Some("  ")).unwrap(), config);
    }

    #[test]
    fn opencode_keeps_the_users_own_config() {
        let config = opencode(Some(r#"{"model":"x","mcp":{"mine":{"type":"remote"}}}"#)).unwrap();
        assert_eq!(config["model"], "x");
        assert_eq!(config["mcp"]["mine"]["type"], "remote");
        assert_eq!(config["mcp"]["flowcode"]["type"], "local");
        let config = opencode(Some(r#"{"model":"x"}"#)).unwrap();
        assert_eq!(config["model"], "x");
        assert!(config["mcp"]["flowcode"].is_object());
    }

    #[test]
    fn opencode_leaves_a_config_that_is_not_an_object_alone() {
        assert!(opencode(Some("not json")).is_none());
        assert!(opencode(Some("[1]")).is_none());
        assert!(opencode(Some(r#"{"mcp":[]}"#)).is_none());
    }
}
