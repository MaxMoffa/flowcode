//! Terminal shims load credentials only in the provider process, never its parent shell.

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

pub(crate) const ARGUMENT: &str = "--flowcode-provider";

#[cfg(any(unix, test))]
fn quote_shell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn find_program(cli: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path).filter(|dir| dir.is_absolute()) {
        if dir
            .components()
            .any(|part| part.as_os_str() == "provider-launch")
        {
            continue;
        }
        #[cfg(windows)]
        for extension in ["exe", "cmd", "bat"] {
            let candidate = dir.join(format!("{cli}.{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let candidate = dir.join(cli);
            if candidate
                .metadata()
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            {
                return Some(candidate);
            }
        }
    }
    None
}

/// Writes the shim through a temp file so a shell launching it concurrently
/// never sees half a script.
fn write_shim(path: &Path, script: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::write(&temporary, script)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o700))?;
        }
        std::fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

/// The script an npm `.cmd` shim runs, relative to the shim's folder: the last
/// quoted `%dp0%\...` / `%~dp0\...` path with a script or executable extension.
#[cfg(any(windows, test))]
fn shim_target(text: &str) -> Option<String> {
    let mut found = None;
    for piece in text.split('"') {
        let lower = piece.to_ascii_lowercase();
        let rest = ["%dp0%\\", "%~dp0\\", "%dp0%/", "%~dp0/"]
            .iter()
            .find_map(|prefix| lower.starts_with(prefix).then(|| &piece[prefix.len()..]));
        let Some(rest) = rest else { continue };
        let ext = rest.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        if matches!(ext.as_str(), "js" | "mjs" | "cjs" | "exe") && !rest.contains('%') && !rest.eq_ignore_ascii_case("node.exe") {
            found = Some(rest.to_string());
        }
    }
    found
}

/// A `.cmd`/`.bat` program resolved to what it really runs, so arguments reach it
/// without passing through cmd.exe (which rejects newlines and expands `%VAR%`).
#[cfg(windows)]
fn resolve_cmd_shim(program: &Path) -> Option<(PathBuf, Vec<std::ffi::OsString>)> {
    let text = std::fs::read_to_string(program).ok()?;
    let dir = program.parent()?;
    let target = dir.join(shim_target(&text)?.replace('/', "\\"));
    if !target.is_file() {
        return None;
    }
    if target.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
        return Some((target, Vec::new()));
    }
    let local_node = dir.join("node.exe");
    let node = if local_node.is_file() { local_node } else { find_program("node").filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")))? };
    Some((node, vec![target.into_os_string()]))
}

pub(crate) fn install(
    app: &AppHandle,
    profile: Option<&str>,
) -> Result<Option<std::ffi::OsString>, String> {
    let dirs = crate::profiles::dirs(app, profile).ok_or("profile_not_found")?;
    let root = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("provider-launch")
        .join(profile.unwrap_or("default"));
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    for (cli, record_dir) in [
        ("claude", dirs.claude),
        ("codex", dirs.codex),
        ("gemini", dirs.gemini.join(".gemini")),
        ("vibe", dirs.vibe),
        ("opencode", dirs.opencode_config),
        ("cline", dirs.cline),
    ] {
        let Some(program) = find_program(cli) else {
            continue;
        };
        let record = record_dir.join(".flowcode-auth.json");
        let mut args = vec![
            exe.to_string_lossy(),
            ARGUMENT.into(),
            cli.into(),
            record.to_string_lossy(),
            program.to_string_lossy(),
        ];
        // A named profile must not attach to OpenCode's shared background service.
        if cli == "opencode" && profile.is_some() {
            args.push("--standalone".into());
        }
        #[cfg(windows)]
        let (path, script) = {
            let quoted = args
                .iter()
                .map(|arg| format!("\"{}\"", arg.replace('%', "%%")))
                .collect::<Vec<_>>()
                .join(" ");
            (root.join(format!("{cli}.cmd")), format!("@echo off\r\nsetlocal DisableDelayedExpansion\r\n{quoted} %*\r\nexit /b %errorlevel%\r\n"))
        };
        #[cfg(not(windows))]
        let (path, script) = {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
            let quoted = args
                .iter()
                .map(|arg| quote_shell(arg))
                .collect::<Vec<_>>()
                .join(" ");
            (root.join(cli), format!("#!/bin/sh\nexec {quoted} \"$@\"\n"))
        };
        if std::fs::read_to_string(&path).ok().as_deref() != Some(&script) {
            write_shim(&path, &script)?;
        }
    }
    let mut paths = vec![root];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    Ok(Some(
        std::env::join_paths(paths).map_err(|e| e.to_string())?,
    ))
}

/// Subcommands that are not a session (or reject unknown flags): no server for them.
pub(crate) fn skips_mcp(cli: &str) -> &'static [&'static str] {
    match cli {
        "claude" => &["mcp", "config", "update", "doctor", "install", "migrate-installer", "setup-token", "plugin", "plugins", "auth", "help"],
        _ => &["login", "logout", "mcp", "mcp-server", "app-server", "completion", "sandbox", "debug", "apply", "features", "help", "update"],
    }
}

/// A TOML string for a `-c` value: the literal form, which has no escapes to get
/// wrong across the shim's quoting, unless the text can't be one.
fn toml_string(text: &str) -> String {
    if text.contains('\'') || text.chars().any(char::is_control) {
        format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        format!("'{text}'")
    }
}

/// The flags that hand Flowcode's MCP server to `cli`, from the settings a tab's
/// environment carries (`terminal_mcp.rs`). Nothing for a call that starts no
/// session (`--version`, `mcp list`...) or a CLI without support yet. Claude's
/// flags use the `=` form: `--mcp-config` takes any number of values, and
/// `--mcp-config x "prompt"` would swallow the prompt.
fn mcp_args(cli: &str, user_args: &[std::ffi::OsString], var: impl Fn(&str) -> Option<String>) -> Vec<std::ffi::OsString> {
    let set = |name: &str| var(name).filter(|v| !v.is_empty());
    if set("FLOWCODE_MCP_TOKEN").is_none() || set("FLOWCODE_MCP_TOOLS").is_none() {
        return Vec::new();
    }
    let first = user_args.first().map(|a| a.to_string_lossy());
    if matches!(first.as_deref(), Some("-v" | "--version" | "-h" | "--help")) {
        return Vec::new();
    }
    let subcommand = user_args.iter().map(|a| a.to_string_lossy()).find(|a| !a.starts_with('-'));
    if subcommand.is_some_and(|s| skips_mcp(cli).contains(&&*s)) {
        return Vec::new();
    }
    let mut out: Vec<std::ffi::OsString> = Vec::new();
    match cli {
        "claude" => {
            if let Some(config) = set("FLOWCODE_MCP_CLAUDE_CONFIG") {
                out.push(format!("--mcp-config={config}").into());
            }
            if let Some(allow) = set("FLOWCODE_MCP_AUTO_ALLOW") {
                out.push(format!("--allowedTools={allow}").into());
            }
        }
        "codex" => {
            let Some(script) = set("FLOWCODE_MCP_SCRIPT") else { return Vec::new() };
            for setting in [
                "mcp_servers.flowcode.command='node'".to_string(),
                format!("mcp_servers.flowcode.args=[{}]", toml_string(&script)),
                "mcp_servers.flowcode.env_vars=['FLOWCODE_MCP_DIR','FLOWCODE_MCP_TOKEN','FLOWCODE_MCP_TOOLS','FLOWCODE_MCP_AGENT']".to_string(),
            ] {
                out.push("-c".into());
                out.push(setting.into());
            }
            // Same list as Claude's `--allowedTools`; Codex otherwise asks before every MCP call.
            let allow = set("FLOWCODE_MCP_AUTO_ALLOW").unwrap_or_default();
            for tool in allow.split(',').filter_map(|t| t.strip_prefix("mcp__flowcode__")) {
                if !tool.is_empty() && tool.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
                    out.push("-c".into());
                    out.push(format!("mcp_servers.flowcode.tools.{tool}.approval_mode='approve'").into());
                }
            }
        }
        _ => {}
    }
    out
}

/// Runs before Tauri starts. No credential is put in arguments or returned to the frontend.
pub fn run_if_requested() {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new(ARGUMENT)) {
        return;
    }
    let Some(cli) = args
        .next()
        .and_then(|arg| arg.into_string().ok())
        .filter(|cli| crate::agents::registry::is_known(cli))
    else {
        std::process::exit(2);
    };
    let Some(record) = args.next() else {
        std::process::exit(2);
    };
    let Some(program) = args.next() else {
        std::process::exit(2);
    };
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(
            windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
        );
    }
    let mut args: Vec<std::ffi::OsString> = args.collect();
    // Computed from the user's own arguments; placed after any script the resolution below prepends.
    let mcp = mcp_args(&cli, &args, |name| std::env::var(name).ok());
    let mut program = std::path::PathBuf::from(program);
    #[allow(unused_mut)]
    let mut insert_at = 0;
    #[cfg(windows)]
    if program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat")) {
        if let Some((real, mut prefix)) = resolve_cmd_shim(&program) {
            insert_at = prefix.len();
            prefix.append(&mut args);
            args = prefix;
            program = real;
        } else if args.iter().any(|a| a.to_string_lossy().contains(['\n', '\r'])) {
            // cmd.exe cannot take a multi-line argument; fail loudly, not with a silent 127.
            eprintln!("flowcode: {} cannot receive a multi-line argument through a .cmd launcher; run its .exe or node entry point directly", program.display());
            std::process::exit(1);
        }
    }
    args.splice(insert_at..insert_at, mcp.iter().cloned());
    let mut command = Command::new(&program);
    if !mcp.is_empty() && matches!(cli.as_str(), "claude" | "codex") {
        command.env("FLOWCODE_MCP_AGENT", &cli);
    }
    command
        .args(args)
        .envs(crate::provider_auth_keys::cli_record_env(
            &cli,
            Path::new(&record),
        ));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        eprintln!("flowcode: cannot start {}: {error}", program.display());
        std::process::exit(127);
    }
    #[cfg(not(unix))]
    match command.status() {
        Ok(status) => std::process::exit(status.code().unwrap_or(127)),
        Err(error) => {
            eprintln!("flowcode: cannot start {}: {error}", program.display());
            std::process::exit(127);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_paths_are_quoted_without_expansion() {
        assert_eq!(quote_shell("a'b$(x)"), "'a'\"'\"'b$(x)'");
    }

    fn os(args: &[&str]) -> Vec<std::ffi::OsString> {
        args.iter().map(std::ffi::OsString::from).collect()
    }

    fn env(name: &str) -> Option<String> {
        Some(match name {
            "FLOWCODE_MCP_TOKEN" => "tok",
            "FLOWCODE_MCP_TOOLS" => "open_in_browser,call_user",
            "FLOWCODE_MCP_CLAUDE_CONFIG" => "C:\\mcp\\term-1.json",
            "FLOWCODE_MCP_AUTO_ALLOW" => "mcp__flowcode__call_user",
            "FLOWCODE_MCP_SCRIPT" => "C:\\mcp\\flowcode-mcp.cjs",
            _ => return None,
        }.to_string())
    }

    #[test]
    fn claude_gets_its_flags_before_the_prompt_in_the_equals_form() {
        let args = mcp_args("claude", &os(&["fix the bug"]), env);
        assert_eq!(args, os(&["--mcp-config=C:\\mcp\\term-1.json", "--allowedTools=mcp__flowcode__call_user"]));
        assert_eq!(mcp_args("claude", &os(&["--model", "opus", "hi"]), env).len(), 2);
    }

    #[test]
    fn calls_that_start_no_session_get_nothing() {
        assert!(mcp_args("claude", &os(&["mcp", "list"]), env).is_empty());
        assert!(mcp_args("claude", &os(&["--debug", "doctor"]), env).is_empty());
        assert!(mcp_args("claude", &os(&["--version"]), env).is_empty());
        assert!(mcp_args("codex", &os(&["-h"]), env).is_empty());
        assert!(mcp_args("codex", &os(&["login"]), env).is_empty());
        assert!(mcp_args("codex", &os(&["mcp-server"]), env).is_empty());
        assert!(mcp_args("gemini", &os(&[]), env).is_empty());
    }

    #[test]
    fn nothing_without_a_token() {
        assert!(mcp_args("claude", &os(&["hi"]), |n| env(n).filter(|_| n != "FLOWCODE_MCP_TOKEN")).is_empty());
        assert!(mcp_args("codex", &os(&["hi"]), |_| None).is_empty());
    }

    #[test]
    fn codex_gets_the_server_as_config_overrides() {
        assert_eq!(
            mcp_args("codex", &os(&["hi"]), env),
            os(&[
                "-c", "mcp_servers.flowcode.command='node'",
                "-c", "mcp_servers.flowcode.args=['C:\\mcp\\flowcode-mcp.cjs']",
                "-c", "mcp_servers.flowcode.env_vars=['FLOWCODE_MCP_DIR','FLOWCODE_MCP_TOKEN','FLOWCODE_MCP_TOOLS','FLOWCODE_MCP_AGENT']",
                "-c", "mcp_servers.flowcode.tools.call_user.approval_mode='approve'",
            ])
        );
    }

    #[test]
    fn a_script_path_with_an_apostrophe_becomes_a_basic_string() {
        let with_quote = |n: &str| if n == "FLOWCODE_MCP_SCRIPT" { Some("C:\\O'Neil\\a.cjs".to_string()) } else { env(n) };
        assert_eq!(mcp_args("codex", &os(&[]), with_quote)[3], std::ffi::OsString::from("mcp_servers.flowcode.args=[\"C:\\\\O'Neil\\\\a.cjs\"]"));
    }

    #[test]
    fn npm_shim_target_is_extracted() {
        let shim = "@ECHO off\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";
        assert_eq!(shim_target(shim).as_deref(), Some("node_modules\\@openai\\codex\\bin\\codex.js"));
        assert_eq!(shim_target("@echo off\r\ncall other.cmd %*"), None);
    }
}
