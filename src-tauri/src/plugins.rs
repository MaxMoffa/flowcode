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
    /// "commandOutput" - see `PluginAction` in src/plugins/types.ts.
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
        return Err("Id del plugin non valido".to_string());
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
    crate::blocking(move || {
        let installed = cli_is_installed(&cli);
        let logged_in = installed && cli_is_logged_in(&cli);
        Ok(CliStatus { installed, logged_in })
    })
    .await
}

/// Runs a plugin's `commandOutput` command headlessly and returns its
/// combined stdout+stderr for display in a popup. Still just the same fixed
/// action vocabulary as everything else: the command text comes from a
/// manifest field, never from anywhere else.
#[tauri::command]
pub async fn run_plugin_command(command: String) -> Result<String, String> {
    flowcode_shared::run_command_for_display(command).await
}
