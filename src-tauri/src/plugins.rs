use serde::{Deserialize, Serialize};
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
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
    /// One of "newTerminal" | "clearTerminal" | "toggleSidebar" | "runCommand"
    /// | "notify" | "commandOutput".
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
    /// One of "newTerminal" | "clearTerminal" | "toggleSidebar" | "runCommand"
    /// | "notify" | "dialog" | "commandOutput".
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
    plugins.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
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

/// Runs a plugin's `commandOutput` command headlessly - no terminal tab, no
/// stdin (so a command that expects interactive input fails fast instead of
/// hanging) - and returns its combined stdout+stderr for display in a popup.
/// Still just the same fixed action vocabulary as everything else: the
/// command text comes from a manifest field, never from anywhere else.
#[tauri::command]
pub fn run_plugin_command(command: String) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Comando vuoto".to_string());
    }

    let output = if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            // Not `.args(["/C", command])`: Rust escapes each element of
            // `args` as its own argv entry (doubling/backslash-escaping any
            // quotes `command` already contains), then cmd.exe's own /C
            // unquoting re-parses that already-mangled text - two
            // incompatible escaping conventions stacked on each other. That
            // corrupted e.g. `claude -p "/usage"` just enough that claude
            // stopped recognizing `/usage` as its client-side slash command
            // and treated it as a literal chat prompt instead. `raw_arg`
            // hands cmd.exe the command text byte-for-byte, matching how a
            // real `cmd /C claude -p "/usage"` invocation reads it.
            std::process::Command::new("cmd")
                .arg("/C")
                .raw_arg(command)
                .stdin(std::process::Stdio::null())
                .output()
        }
        #[cfg(not(target_os = "windows"))]
        unreachable!()
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        std::process::Command::new(shell)
            .args(["-lc", command])
            .stdin(std::process::Stdio::null())
            .output()
    }
    .map_err(|e| e.to_string())?;

    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let err_text = String::from_utf8_lossy(&output.stderr);
    let err_text = err_text.trim();
    if !err_text.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(err_text);
    }
    if text.is_empty() {
        text = "(nessun output)".to_string();
    }
    Ok(text)
}

/// Like `run_plugin_command`, but strict: only stdout, and a non-zero exit
/// is an error (with stderr as the message) instead of being folded into the
/// text. Used where the caller needs to parse the output (JSON, a fixed
/// phrase) and must be able to tell "it failed" from "it succeeded with
/// this text" - `run_plugin_command`'s tolerant merge is for display only.
#[tauri::command]
pub fn run_plugin_command_stdout(command: String) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Comando vuoto".to_string());
    }

    let output = if cfg!(target_os = "windows") {
        #[cfg(target_os = "windows")]
        {
            // See run_plugin_command's comment: raw_arg avoids Rust and
            // cmd.exe stacking two different quote-escaping conventions.
            std::process::Command::new("cmd")
                .arg("/C")
                .raw_arg(command)
                .stdin(std::process::Stdio::null())
                .output()
        }
        #[cfg(not(target_os = "windows"))]
        unreachable!()
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        std::process::Command::new(shell)
            .args(["-lc", command])
            .stdin(std::process::Stdio::null())
            .output()
    }
    .map_err(|e| e.to_string())?;

    if !output.status.success() {
        let err_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err_text.is_empty() {
            format!("Comando terminato con codice {:?}", output.status.code())
        } else {
            err_text
        });
    }
    // Some CLIs (e.g. `codex login status`) print their actual result to
    // stderr even on success - stdout alone would silently come back empty
    // and get misread as "not logged in" by callers that parse this text.
    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let err_text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !err_text.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err_text);
    }
    Ok(text)
}
