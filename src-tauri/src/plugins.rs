use flowcode_shared::i18n::tr;
use flowcode_shared::{combined_output, run_command_blocking};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// The plugin "standard": a small declarative JSON file, not arbitrary code.
/// A plugin can only ever do one of a fixed, safe set of things (`action`) -
/// there is no way for a plugin file to run code the app doesn't already
/// know how to run, which is what keeps "anyone can drop a file in the
/// plugins folder" from being a code-execution risk. Full schema and
/// examples: PLUGINS.md at the repo root.
#[derive(Serialize, Deserialize, Clone)]
pub struct PluginButtonManifest {
    pub label: String,
    /// Same vocabulary as `PluginManifest::action`, minus "dialog".
    pub action: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub message: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct PluginManifest {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub description: String,
    /// One of "newTerminal" | "clearTerminal" | "toggleSidebar" |
    /// "toggleAgentsSidebar" | "runCommand" | "notify" | "dialog" |
    /// "commandOutput" | "openInVsCode" - see `PluginAction` in
    /// src/plugins/types.ts.
    pub action: String,
    /// runCommand: typed into the active terminal exactly as if the user had
    /// typed it themselves. commandOutput: run headlessly (no terminal,
    /// no stdin) and its combined stdout/stderr shown in a popup.
    #[serde(default)]
    pub command: String,
    /// notify: the toast text. dialog: the body text.
    #[serde(default)]
    pub message: String,
    /// dialog only - defaults to `label` client-side if omitted.
    #[serde(default)]
    pub title: String,
    /// dialog only.
    #[serde(default)]
    pub buttons: Vec<PluginButtonManifest>,
    /// SVG path `d` data for a single <path>, drawn in a fixed-size icon
    /// frame - deliberately not a full arbitrary SVG/HTML string.
    #[serde(default)]
    pub icon: String,
}

fn plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?.join("plugins");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Keeps ids filesystem-safe and prevents path traversal - a manifest's id
/// becomes its filename.
fn sanitize_id(id: &str) -> String {
    id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

#[tauri::command]
pub fn list_plugins(app: AppHandle) -> Result<Vec<PluginManifest>, String> {
    let dir = plugins_dir(&app)?;
    let mut plugins = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let Ok(entry) = entry else { continue };
        if entry.path().extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Ok(contents) = std::fs::read_to_string(entry.path()) {
            if let Ok(manifest) = serde_json::from_str::<PluginManifest>(&contents) {
                plugins.push(manifest);
            }
        }
    }
    plugins.sort_by_key(|p| p.label.to_lowercase());
    Ok(plugins)
}

#[tauri::command]
pub fn save_plugin(app: AppHandle, plugin: PluginManifest) -> Result<(), String> {
    let dir = plugins_dir(&app)?;
    let id = sanitize_id(&plugin.id);
    if id.is_empty() {
        return Err(tr("Id del plugin non valido", "Invalid plugin id").to_string());
    }
    let mut plugin = plugin;
    plugin.id = id.clone();
    let path = dir.join(format!("{id}.json"));
    let contents = serde_json::to_string_pretty(&plugin).map_err(|e| e.to_string())?;
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_plugin(app: AppHandle, id: String) -> Result<(), String> {
    let dir = plugins_dir(&app)?;
    let id = sanitize_id(&id);
    let path = dir.join(format!("{id}.json"));
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct CliStatus {
    installed: bool,
    logged_in: bool,
}

/// Whether `claude`/`codex` resolve on PATH at all. Deliberately not "try to
/// run the CLI and see if it errors": on Windows that error text ("'claude'
/// is not recognized as an internal or external command") comes back in the
/// OS's own display language - Italian on this machine - so matching it
/// would silently break for anyone not on an English Windows install.
/// `where`/`command -v` report found-or-not purely via exit code, no text
/// parsing, no locale dependency.
fn cli_is_installed(cli: &str) -> bool {
    let probe = if cfg!(windows) { format!("where {cli}") } else { format!("command -v {cli}") };
    run_command_blocking(&probe).map(|o| o.status.success()).unwrap_or(false)
}

/// Best-effort login check for a plugin's CLI, used to decide whether
/// clicking its shortcut should offer to install/log in first instead of
/// just launching it. Claude Code's `claude auth status` prints clean JSON
/// (`{"loggedIn": true/false, ...}`) - Codex has no equivalent structured
/// output, so `codex login status` is matched against the literal English
/// "Not logged in" text it's documented to print (same kind of heuristic
/// src/plugins/codexStatus.ts already uses against Codex's interactive
/// screen - there's no more reliable signal available for it).
fn cli_is_logged_in(cli: &str) -> bool {
    match cli {
        "claude" => run_command_blocking("claude auth status")
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
            .and_then(|v| v.get("loggedIn").and_then(|b| b.as_bool()))
            .unwrap_or(false),
        "codex" => run_command_blocking("codex login status")
            .ok()
            .is_some_and(|o| o.status.success() && !combined_output(&o).to_lowercase().contains("not logged in")),
        // Vibe has no status command: it's "signed in" once a Mistral API key
        // is set - `vibe --setup` saves it to `~/.vibe/.env`.
        "vibe" => crate::vibe::has_api_key(),
        _ => false,
    }
}

/// Checked before a "runCommand" shortcut for a known CLI (Claude Code,
/// Codex) actually launches it - lets the frontend offer a one-click
/// install/login in a fresh terminal instead of the shortcut just silently
/// doing nothing (or, for Codex, launching straight into its interactive
/// login prompt with no explanation).
#[tauri::command]
pub async fn check_cli_status(cli: String) -> Result<CliStatus, String> {
    // `cli` ends up inside a shell command line - only the names this knows.
    if !matches!(cli.as_str(), "claude" | "codex" | "vibe") {
        return Ok(CliStatus { installed: false, logged_in: false });
    }
    crate::blocking(move || {
        let installed = cli_is_installed(&cli);
        let logged_in = installed && cli_is_logged_in(&cli);
        Ok(CliStatus { installed, logged_in })
    })
    .await
}

/// How a CLI is paid for, as far as its own status command tells:
/// `"subscription"` (a Claude / ChatGPT plan, with usage limits to show),
/// `"api"` (billed per token - an API key, or for Claude Code a cloud
/// provider such as Bedrock or Vertex - with spend to show instead) or
/// `"unknown"` (signed out, not installed, unreadable). Decides which popup
/// the CLI's shortcut shows - see src/plugins/usage.ts.
#[tauri::command]
pub async fn cli_billing_mode(cli: String) -> Result<&'static str, String> {
    crate::blocking(move || {
        Ok(match cli.as_str() {
            "claude" => run_command_blocking("claude auth status")
                .ok()
                .and_then(|o| serde_json::from_slice::<serde_json::Value>(&o.stdout).ok())
                .map_or("unknown", |status| claude_billing_mode(&status)),
            "codex" => run_command_blocking("codex login status")
                .ok()
                .map_or("unknown", |o| codex_billing_mode(&combined_output(&o))),
            "vibe" => "api",
            _ => "unknown",
        })
    })
    .await
}

/// From `claude auth status`'s JSON: signed in through claude.ai (a Pro /
/// Max / Team plan) is a subscription; any other signed-in method - an API
/// key, a token, a cloud provider - is billed per token.
fn claude_billing_mode(status: &serde_json::Value) -> &'static str {
    if status.get("loggedIn").and_then(|v| v.as_bool()) != Some(true) {
        return "unknown";
    }
    let method = status.get("authMethod").and_then(|v| v.as_str()).unwrap_or_default();
    let provider = status.get("apiProvider").and_then(|v| v.as_str()).unwrap_or("firstParty");
    if method == "claude.ai" && provider == "firstParty" {
        "subscription"
    } else {
        "api"
    }
}

/// From `codex login status`: "Logged in using ChatGPT" is a plan, "Logged
/// in using an API key" is billed per token. English text matched on
/// purpose - it's Codex's own wording, not the OS's (see `cli_is_logged_in`).
fn codex_billing_mode(output: &str) -> &'static str {
    let text = output.to_lowercase();
    if text.contains("not logged in") {
        "unknown"
    } else if text.contains("api key") {
        "api"
    } else if text.contains("chatgpt") {
        "subscription"
    } else {
        "unknown"
    }
}

/// Runs a plugin's `commandOutput` command headlessly and returns its
/// combined stdout+stderr for display in a popup. Still just the same fixed
/// action vocabulary as everything else: the command text comes from a
/// manifest field, never from anywhere else.
#[tauri::command]
pub async fn run_plugin_command(command: String) -> Result<String, String> {
    flowcode_shared::run_command_for_display(command).await
}

/// Whether `codex` has to be launched with `--no-daemon` from this app: on
/// Windows, whenever the installed Codex knows the flag (older versions have
/// no daemon, so nothing to disable, and reject unknown flags outright).
///
/// The daemon (Codex's shared background server) runs detached, with no
/// console of its own, so every console program it starts for a session -
/// MCP servers, `node_repl`, `codex-code-mode-host.exe` - gets a brand-new
/// console window (a Windows Terminal one, where that's the default
/// terminal) popping up over the app. Without it they're children of the
/// `codex` in the tab and share its pseudoconsole instead, invisibly. It also
/// covers hosts whose Job Object forbids breakaway, where Codex refuses to
/// start the daemon at all ("host Job Object prevents daemon detachment").
#[tauri::command]
pub async fn codex_needs_no_daemon() -> Result<bool, String> {
    crate::blocking(|| {
        if !cfg!(target_os = "windows") {
            return Ok(false);
        }
        Ok(run_command_blocking("codex --help")
            .map(|o| combined_output(&o).contains("--no-daemon"))
            .unwrap_or(false))
    })
    .await
}

/// What `open_in_vscode` fails with when no VS Code install can be found -
/// matched by the frontend to show its own translated message instead of
/// this raw text.
const VSCODE_NOT_FOUND: &str = "vscode-not-found";

/// VS Code's own executable: on Windows `Code.exe` (a GUI program, so
/// launching it directly never flashes a console the way going through
/// `code.cmd` would), elsewhere the bundled `code` CLI. Looked up on PATH
/// first, then in the standard install locations - an app started from the
/// Start menu can have a PATH older than the VS Code install.
#[cfg(target_os = "windows")]
fn find_vscode() -> Option<PathBuf> {
    // `where code` finds `<install>\bin\code.cmd`; Code.exe sits one level up.
    let from_path = run_command_blocking("where code.cmd")
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|line| PathBuf::from(line.trim()).parent()?.parent().map(|dir| dir.join("Code.exe")))
                .find(|exe| exe.is_file())
        });
    from_path.or_else(|| {
        ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]
            .iter()
            .filter_map(std::env::var_os)
            .map(|base| {
                let base = PathBuf::from(base);
                // Per-user installs land in %LOCALAPPDATA%\Programs.
                let base = if base.ends_with("Local") { base.join("Programs") } else { base };
                base.join("Microsoft VS Code").join("Code.exe")
            })
            .find(|exe| exe.is_file())
    })
}

#[cfg(not(target_os = "windows"))]
fn find_vscode() -> Option<PathBuf> {
    let from_path = run_command_blocking("command -v code")
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
        .filter(|p| p.is_file());
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let candidates = [
        PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
        home.join("Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
        PathBuf::from("/usr/bin/code"),
        PathBuf::from("/usr/local/bin/code"),
        PathBuf::from("/snap/bin/code"),
    ];
    from_path.or_else(|| candidates.into_iter().find(|p| p.is_file()))
}

/// The built-in "Apri in VS Code" feature: opens `folder` in VS Code, or
/// fails with `VSCODE_NOT_FOUND` when it isn't installed. With `wsl_distro`,
/// `folder` is a Linux path inside that distro and opens through VS Code's
/// WSL remote, like `code .` typed in a WSL shell - not as a
/// `\wsl.localhost\...` share, which VS Code only opens behind a warning.
#[tauri::command]
pub async fn open_in_vscode(folder: String, wsl_distro: Option<String>) -> Result<(), String> {
    // Never a folder VS Code could read as one of its options (`--inspect`,
    // `--install-extension`, ...): only absolute paths come here today, but
    // an argument starting with `-` must not reach it whatever the caller.
    if folder.is_empty() || folder.starts_with('-') {
        return Err(format!("Not a folder: {folder}"));
    }
    crate::blocking(move || {
        let exe = find_vscode().ok_or_else(|| VSCODE_NOT_FOUND.to_string())?;
        let mut command = std::process::Command::new(exe);
        if let Some(distro) = wsl_distro.filter(|d| !d.is_empty()) {
            command.args(["--remote", &format!("wsl+{distro}")]);
        }
        command
            .arg(&folder)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::{claude_billing_mode, codex_billing_mode};

    #[test]
    fn tells_a_plan_from_pay_per_use() {
        let status = |method: &str, provider: &str| {
            serde_json::json!({ "loggedIn": true, "authMethod": method, "apiProvider": provider })
        };
        assert_eq!(claude_billing_mode(&status("claude.ai", "firstParty")), "subscription");
        assert_eq!(claude_billing_mode(&status("api_key", "firstParty")), "api");
        assert_eq!(claude_billing_mode(&status("claude.ai", "bedrock")), "api");
        assert_eq!(claude_billing_mode(&serde_json::json!({ "loggedIn": false })), "unknown");
        assert_eq!(codex_billing_mode("Logged in using ChatGPT"), "subscription");
        assert_eq!(codex_billing_mode("Logged in using an API key - sk-proj-***"), "api");
        assert_eq!(codex_billing_mode("Not logged in"), "unknown");
    }
}
