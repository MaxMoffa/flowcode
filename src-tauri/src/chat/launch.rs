//! How an agent is launched, and where (Windows or WSL).

/// The program and arguments that start an agent's ACP server (for the npm
/// adapters, the `npx` fallback used until `acp_adapters` has installed one).
pub(super) fn launch_command(agent: &str) -> Option<(&'static str, &'static [&'static str])> {
    Some(match agent {
        "vibe" => ("vibe-acp", &[]),
        "gemini" => ("gemini", &["--experimental-acp"]),
        "opencode" => ("opencode", &["acp"]),
        "claude" => ("npx", &["-y", "--ignore-scripts", "@agentclientprotocol/claude-agent-acp@0.101.0"]),
        "codex" => ("npx", &["-y", "--ignore-scripts", "@agentclientprotocol/codex-acp@2.5.0"]),
        _ => return None,
    })
}

/// Where a chat's agent runs when it runs inside WSL: the distro (`None`: the default one) and the cwd as a Linux path.
pub(super) struct WslTarget {
    pub(super) distro: Option<String>,
    pub(super) cwd: String,
}

/// A Windows path as the distro sees it: `C:\a\b` -> `/mnt/c/a/b`, a WSL UNC
/// path -> its Linux path. `None` for anything else (and off Windows).
pub(crate) fn to_wsl_path(path: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    if let Some((_, posix)) = crate::pty::shells::split_wsl_unc(path) {
        return Some(posix);
    }
    let bytes = path.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' || !path.is_char_boundary(2) {
        return None;
    }
    let rest = &path[2..];
    if !rest.is_empty() && !rest.starts_with(['\\', '/']) {
        return None;
    }
    let rest = rest.replace('\\', "/");
    let rest = rest.trim_end_matches('/');
    Some(format!("/mnt/{}{}{}", (bytes[0] as char).to_ascii_lowercase(), if rest.is_empty() || rest.starts_with('/') { "" } else { "/" }, rest))
}

/// Whether a chat in `cwd` runs inside WSL: its folder is a WSL UNC path (the
/// distro is then the folder's), or the user's terminal shell is WSL (the
/// agent should see the same config as the terminal agents do).
pub(super) fn wsl_target(cwd: &str, shell: Option<&str>) -> Option<WslTarget> {
    if !cfg!(windows) {
        return None;
    }
    if let Some((distro, posix)) = crate::pty::shells::split_wsl_unc(cwd) {
        return Some(WslTarget { distro: Some(distro), cwd: posix });
    }
    let shell = shell?;
    let distro = if shell == "wsl" { None } else { Some(shell.strip_prefix("wsl:")?).filter(|d| !d.is_empty()).map(str::to_string) };
    Some(WslTarget { distro, cwd: to_wsl_path(cwd)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn maps_windows_paths_into_wsl() {
        assert_eq!(to_wsl_path(r"C:\a\b").as_deref(), Some("/mnt/c/a/b"));
        assert_eq!(to_wsl_path("D:/a/b/").as_deref(), Some("/mnt/d/a/b"));
        assert_eq!(to_wsl_path(r"C:\").as_deref(), Some("/mnt/c"));
        assert_eq!(to_wsl_path(r"\\wsl.localhost\Ubuntu\home\me").as_deref(), Some("/home/me"));
        assert_eq!(to_wsl_path(r"\\wsl$\Debian").as_deref(), Some("/"));
        assert_eq!(to_wsl_path("relative/dir"), None);
        assert_eq!(to_wsl_path(r"\\server\share"), None);
    }

    #[cfg(windows)]
    #[test]
    fn wsl_target_follows_the_folder_then_the_shell() {
        let unc = wsl_target(r"\\wsl.localhost\Ubuntu\home\me", Some("powershell")).unwrap();
        assert_eq!((unc.distro.as_deref(), unc.cwd.as_str()), (Some("Ubuntu"), "/home/me"));
        let old = wsl_target(r"\\wsl$\Debian\srv", None).unwrap();
        assert_eq!((old.distro.as_deref(), old.cwd.as_str()), (Some("Debian"), "/srv"));
        let default = wsl_target(r"C:\a\b", Some("wsl")).unwrap();
        assert_eq!((default.distro, default.cwd.as_str()), (None, "/mnt/c/a/b"));
        let named = wsl_target("C:/a/b", Some("wsl:Ubuntu")).unwrap();
        assert_eq!((named.distro.as_deref(), named.cwd.as_str()), (Some("Ubuntu"), "/mnt/c/a/b"));
        let empty = wsl_target(r"C:\", Some("wsl:")).unwrap();
        assert_eq!((empty.distro, empty.cwd.as_str()), (None, "/mnt/c"));
        assert!(wsl_target(r"C:\a", Some("powershell")).is_none());
        assert!(wsl_target(r"C:\a", Some("system")).is_none());
        assert!(wsl_target(r"C:\a", None).is_none());
    }

    #[test]
    fn knows_how_to_launch_each_agent() {
        assert_eq!(launch_command("vibe"), Some(("vibe-acp", &[][..])));
        assert_eq!(launch_command("opencode"), Some(("opencode", &["acp"][..])));
        assert_eq!(launch_command("gemini"), Some(("gemini", &["--experimental-acp"][..])));
        assert_eq!(launch_command("claude").map(|c| c.0), Some("npx"));
        assert_eq!(launch_command("codex").map(|c| c.0), Some("npx"));
        assert!(launch_command("nope").is_none());
    }
}
