//! macOS apps opened from Finder or the Dock start with launchd's bare PATH
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), not the one of the user's shell, so agent
//! CLIs installed by npm, Homebrew or nvm (`cline`, `opencode`, `npx`...) are
//! not found by the chats and sign-in dialogs that spawn them directly.

const START: &str = "__FLOWCODE_PATH_START__";
const END: &str = "__FLOWCODE_PATH_END__";

/// The PATH printed between the markers (rc files may print anything else).
fn between_markers(output: &str) -> Option<&str> {
    let rest = &output[output.find(START)? + START.len()..];
    let path = &rest[..rest.find(END)?];
    (!path.trim().is_empty()).then(|| path.trim())
}

/// `login` entries first, then the entries of `current` it lacks.
fn merge(login: &str, current: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for entry in login.split(':').chain(current.split(':')) {
        if !entry.is_empty() && !out.contains(&entry) {
            out.push(entry);
        }
    }
    out.join(":")
}

/// Adds the user's login-shell PATH to this process's, when the app was not
/// started from a terminal (no `TERM`). Call before any thread starts.
#[cfg(target_os = "macos")]
pub(crate) fn apply_at_startup() {
    if std::env::var_os("TERM").is_some() {
        return;
    }
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into());
    let mut cmd = std::process::Command::new(shell);
    // Interactive too: nvm and friends are set up in ~/.zshrc, not in the login files.
    cmd.args(["-ilc", &format!("printf '%s%s%s' {START} \"$PATH\" {END}")]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    let Ok(child) = cmd.stdout(std::process::Stdio::piped()).spawn() else { return };
    let Ok(out) = flowcode_shared::wait_with_timeout(child, std::time::Duration::from_secs(4)) else { return };
    let Some(login) = between_markers(&String::from_utf8_lossy(&out.stdout)).map(str::to_owned) else { return };
    let current = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", merge(&login, &current));
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn apply_at_startup() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_path_between_markers_despite_rc_noise() {
        let out = format!("Welcome back\n{START}/opt/homebrew/bin:/usr/bin{END}\n");
        assert_eq!(between_markers(&out), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(between_markers("no markers"), None);
        assert_eq!(between_markers(&format!("{START}{END}")), None);
    }

    #[test]
    fn merge_keeps_login_order_and_drops_duplicates() {
        assert_eq!(merge("/a:/b:/usr/bin", "/usr/bin:/bin:/a"), "/a:/b:/usr/bin:/bin");
        assert_eq!(merge("", "/bin"), "/bin");
    }
}
