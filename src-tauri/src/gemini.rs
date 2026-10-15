//! Google's Gemini CLI (`gemini`, npm `@google/gemini-cli`) - what this app
//! reads off its own files. Deliberately small: the CLI keeps its state in
//! `<GEMINI_CLI_HOME or the user's home>/.gemini` (OAuth in `oauth_creds.json`,
//! an API key in `.env`, settings in `settings.json`), which is all the
//! account profiles and the sign-in check need. Not read: its saved chats and
//! any usage/quota figure - neither is verified, so the Agents panel shows no
//! saved Gemini sessions and the shortcut no limit gauge.

use std::path::{Path, PathBuf};

/// `.gemini` inside `root` (the `GEMINI_CLI_HOME` the CLI was given).
fn config_dir(root: &Path) -> PathBuf {
    root.join(".gemini")
}

/// Whether `root`'s `.gemini` holds a Google sign-in or a Gemini API key.
/// File-only and best-effort: a CLI that keeps its token in the OS keychain
/// instead reads as signed out here.
pub fn has_login(root: &Path) -> bool {
    let dir = config_dir(root);
    if dir.join("oauth_creds.json").is_file() {
        return true;
    }
    std::fs::read_to_string(dir.join(".env")).is_ok_and(|env| env_has_key(&env))
}

/// Whether a dotenv text sets a non-empty `GEMINI_API_KEY` / `GOOGLE_API_KEY`.
fn env_has_key(env: &str) -> bool {
    env.lines().any(|line| {
        let line = line.trim().trim_start_matches("export ").trim();
        ["GEMINI_API_KEY", "GOOGLE_API_KEY"].iter().any(|k| {
            line.strip_prefix(k)
                .and_then(|rest| rest.trim_start().strip_prefix('='))
                .is_some_and(|v| !v.trim().trim_matches(['"', '\'']).is_empty())
        })
    })
}

/// Signs out: removes the cached Google sign-in. A key in `.env` is the
/// user's own file and stays.
pub fn logout(root: &Path) -> Result<(), String> {
    let dir = config_dir(root);
    for name in ["oauth_creds.json", "google_accounts.json"] {
        match std::fs::remove_file(dir.join(name)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::env_has_key;

    #[test]
    fn reads_api_key_from_dotenv() {
        assert!(env_has_key("GEMINI_API_KEY=abc"));
        assert!(env_has_key("# c\nexport GOOGLE_API_KEY = \"abc\""));
        assert!(!env_has_key("GEMINI_API_KEY=\n"));
        assert!(!env_has_key("OTHER=1"));
    }
}
