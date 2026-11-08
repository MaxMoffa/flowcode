//! Terminal shims load credentials only in the provider process, never its parent shell.

use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{AppHandle, Manager};

const ARGUMENT: &str = "--flowcode-provider";

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
            std::fs::write(&path, script).map_err(|e| e.to_string())?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
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
    let mut command = Command::new(program);
    command
        .args(args)
        .envs(crate::provider_auth_keys::cli_record_env(
            &cli,
            Path::new(&record),
        ));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let _ = command.exec();
        std::process::exit(127);
    }
    #[cfg(not(unix))]
    std::process::exit(
        command
            .status()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(127),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_paths_are_quoted_without_expansion() {
        assert_eq!(quote_shell("a'b$(x)"), "'a'\"'\"'b$(x)'");
    }
}
