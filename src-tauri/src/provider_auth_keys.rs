//! Per-provider authentication preferences and API keys for Flowcode-launched
//! processes. API keys never enter a command line, a response, or a log.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

const RECORD_NAME: &str = ".flowcode-auth.json";
const KEY_TIMEOUT: Duration = Duration::from_secs(15);
const LOGIN_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_KEY_BYTES: usize = 8192;
static STORE_LOCK: Mutex<()> = Mutex::new(());

// Deliberately not Debug: these values contain credentials.
#[derive(Deserialize, Serialize)]
struct AuthRecord {
    method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
}

fn provider_dir(dirs: &crate::profiles::ProfileDirs, cli: &str) -> Result<PathBuf, String> {
    match cli {
        "claude" => Ok(dirs.claude.clone()),
        "codex" => Ok(dirs.codex.clone()),
        "gemini" => Ok(dirs.gemini.join(".gemini")),
        "vibe" => Ok(dirs.vibe.clone()),
        _ => Err("unsupported_provider".into()),
    }
}

fn dir(app: &AppHandle, cli: &str, profile: Option<&str>) -> Result<PathBuf, String> {
    let dirs = crate::profiles::dirs(app, profile).ok_or("profile_not_found")?;
    provider_dir(&dirs, cli)
}

fn read_record(dir: &Path) -> Option<AuthRecord> {
    // The record is tiny. Refuse unexpectedly large or externally replaced files.
    let path = dir.join(RECORD_NAME);
    if fs::metadata(&path).ok()?.len() > (MAX_KEY_BYTES + 1024) as u64 {
        return None;
    }
    let raw = fs::read(path).ok()?;
    let record: AuthRecord = serde_json::from_slice(&raw).ok()?;
    match record.method.as_str() {
        "browser" => Some(AuthRecord { method: record.method, api_key: None }),
        "apiKey" if record.api_key.as_deref().is_some_and(|key| normalize_key(key).is_ok()) => Some(record),
        _ => None,
    }
}

/// Returns only the preference, never its credential.
pub fn method(app: &AppHandle, cli: &str, profile: Option<&str>) -> Option<String> {
    read_record(&dir(app, cli, profile).ok()?).map(|record| record.method)
}

pub fn has_key(app: &AppHandle, cli: &str, profile: Option<&str>) -> bool {
    dir(app, cli, profile)
        .ok()
        .and_then(|dir| read_record(&dir))
        .is_some_and(|record| record.method == "apiKey" && record.api_key.is_some())
}

fn variable_names(cli: &str) -> &'static [&'static str] {
    match cli {
        "claude" => &["ANTHROPIC_API_KEY"],
        "codex" => &["OPENAI_API_KEY"],
        "gemini" => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        "vibe" => &["MISTRAL_API_KEY"],
        _ => &[],
    }
}

fn record_env(cli: &str, record: &AuthRecord) -> Vec<(String, String)> {
    let names = variable_names(cli);
    names.iter().enumerate().map(|(index, name)| {
        // GOOGLE_API_KEY would otherwise override the chosen Gemini account.
        // Only the primary key variable gets the managed secret.
        let key = if record.method == "apiKey" && index == 0 {
            record.api_key.clone().unwrap_or_default()
        } else {
            String::new()
        };
        ((*name).to_string(), key)
    }).collect()
}

pub(crate) fn cli_record_env(cli: &str, path: &Path) -> Vec<(String, String)> {
    path.parent().and_then(read_record).map(|record| record_env(cli, &record)).unwrap_or_default()
}

/// Append to the environment of a CLI launched for this profile. Empty values
/// intentionally suppress inherited keys when the user chooses account login.
/// This function must never call `profiles::env_for` (which calls it).
pub fn env_for_cli(app: &AppHandle, profile: Option<&str>, cli: &str) -> Vec<(String, String)> {
    let Some(dirs) = crate::profiles::dirs(app, profile) else { return Vec::new() };
    provider_dir(&dirs, cli).ok().and_then(|dir| read_record(&dir))
        .map(|record| record_env(cli, &record)).unwrap_or_default()
}

fn normalize_key(key: &str) -> Result<&str, String> {
    // Reject controls before trimming so a pasted newline can never become
    // an extra stdin command, dotenv assignment, or HTTP header.
    if key.bytes().any(|byte| byte.is_ascii_control()) {
        return Err("key_invalid".into());
    }
    let key = key.trim();
    if key.is_empty() || key.len() > MAX_KEY_BYTES || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("key_invalid".into());
    }
    Ok(key)
}

fn key_status_error(status: u16) -> &'static str {
    match status {
        400 | 401 => "key_invalid",
        403 => "key_forbidden",
        429 => "provider_rate_limited",
        _ => "provider_unavailable",
    }
}

/// Authentication is tested against a fixed vendor endpoint with no model
/// generation. Redirects are disabled so credentials cannot leave that origin.
fn validate_key(cli: &str, key: &str) -> Result<(), String> {
    let agent = ureq::AgentBuilder::new().timeout(KEY_TIMEOUT).redirects(0).build();
    let request = match cli {
        "claude" => agent.get("https://api.anthropic.com/v1/models")
            .set("x-api-key", key).set("anthropic-version", "2023-06-01"),
        "codex" => agent.get("https://api.openai.com/v1/models")
            .set("Authorization", &format!("Bearer {key}")),
        "gemini" => agent.get("https://generativelanguage.googleapis.com/v1beta/models")
            .set("x-goog-api-key", key),
        "vibe" => agent.get("https://api.mistral.ai/v1/models")
            .set("Authorization", &format!("Bearer {key}")),
        _ => return Err("unsupported_provider".into()),
    };
    match request.call() {
        Ok(response) if (200..300).contains(&response.status()) => Ok(()),
        Ok(response) => Err(key_status_error(response.status()).into()),
        Err(ureq::Error::Status(status, _)) => Err(key_status_error(status).into()),
        // Do not format the transport error or read the response body: either
        // might include request headers or an echoed credential.
        Err(ureq::Error::Transport(_)) => Err("provider_unavailable".into()),
    }
}

fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    let existed = dir.exists();
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    if !existed {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    let _ = existed;
    Ok(())
}

/// The temporary file is private before the first credential byte is written.
/// The old record survives a failed write, flush, or rename.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "credential link refused"));
    }
    let parent = path.parent().ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing parent"))?;
    ensure_dir(parent)?;
    let temporary = parent.join(format!(".flowcode-auth-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn record_bytes(record: &AuthRecord) -> Result<Vec<u8>, String> {
    serde_json::to_vec_pretty(record).map_err(|_| "key_storage_failed".into())
}

/// Preserve unknown Gemini preferences instead of replacing the settings file.
fn gemini_settings(raw: Option<&[u8]>, selected_type: &str) -> Result<Vec<u8>, String> {
    let mut settings: serde_json::Value = match raw {
        Some(raw) => serde_json::from_slice(raw).map_err(|_| "auth_settings_invalid")?,
        None => serde_json::json!({}),
    };
    let object = settings.as_object_mut().ok_or("auth_settings_invalid")?;
    let security = object.entry("security").or_insert_with(|| serde_json::json!({}));
    let security = security.as_object_mut().ok_or("auth_settings_invalid")?;
    let auth = security.entry("auth").or_insert_with(|| serde_json::json!({}));
    let auth = auth.as_object_mut().ok_or("auth_settings_invalid")?;
    auth.insert("selectedType".into(), serde_json::Value::String(selected_type.into()));
    serde_json::to_vec_pretty(&settings).map_err(|_| "key_storage_failed".into())
}

fn snapshot(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("key_storage_failed".into()),
    }
}

fn restore(path: &Path, old: Option<&[u8]>) -> Result<(), String> {
    match old {
        Some(bytes) => write_private(path, bytes).map_err(|_| "key_storage_failed".into()),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("key_storage_failed".into()),
        },
    }
}

/// Temporarily selects Google's OAuth flow without changing the saved
/// Flowcode authentication preference. A cancelled or failed login restores
/// the previous selection and preserves unrelated settings written by the CLI.
pub struct BrowserSettingsGuard {
    path: PathBuf,
    previous: Option<Vec<u8>>,
    prepared: Vec<u8>,
    committed: bool,
}

impl BrowserSettingsGuard {
    /// Consume the guard after the new browser credentials were verified and
    /// `save_browser` succeeded. The new selection is then permanent.
    pub fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for BrowserSettingsGuard {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        let _guard = crate::util::lock(&STORE_LOCK);
        // Drop cannot report an error; leaving the CLI's new preferences is
        // preferable to replacing a file that became unreadable or malformed.
        let _ = rollback_gemini_selection(&self.path, self.previous.as_deref(), &self.prepared);
    }
}

fn rollback_gemini_selection(path: &Path, previous: Option<&[u8]>, prepared: &[u8]) -> Result<(), String> {
    let Some(current_bytes) = snapshot(path)? else { return Ok(()) };
    if current_bytes == prepared {
        return restore(path, previous);
    }
    let mut current: serde_json::Value = serde_json::from_slice(&current_bytes).map_err(|_| "auth_settings_invalid")?;
    // A different auth selection belongs to the CLI or another explicit user
    // action. The guard must not overwrite it.
    if current.pointer("/security/auth/selectedType").and_then(|value| value.as_str()) != Some("oauth-personal") {
        return Ok(());
    }
    let original: serde_json::Value = match previous {
        Some(bytes) => serde_json::from_slice(bytes).map_err(|_| "auth_settings_invalid")?,
        None => serde_json::json!({}),
    };
    let previous_selection = original.pointer("/security/auth/selectedType").cloned();
    let root = current.as_object_mut().ok_or("auth_settings_invalid")?;
    if let Some(security) = root.get_mut("security").and_then(|value| value.as_object_mut()) {
        if let Some(auth) = security.get_mut("auth").and_then(|value| value.as_object_mut()) {
            match previous_selection {
                Some(value) => { auth.insert("selectedType".into(), value); }
                None => { auth.remove("selectedType"); }
            }
            if auth.is_empty() && original.pointer("/security/auth").is_none() {
                security.remove("auth");
            }
        }
        if security.is_empty() && original.get("security").is_none() {
            root.remove("security");
        }
    }
    if root.is_empty() && previous.is_none() {
        return restore(path, None);
    }
    let bytes = serde_json::to_vec_pretty(&current).map_err(|_| "key_storage_failed")?;
    write_private(path, &bytes).map_err(|_| "key_storage_failed".into())
}

pub fn prepare_browser(app: &AppHandle, cli: &str, profile: Option<&str>) -> Result<Option<BrowserSettingsGuard>, String> {
    if cli != "gemini" {
        return Ok(None);
    }
    let path = dir(app, cli, profile)?.join("settings.json");
    let _guard = crate::util::lock(&STORE_LOCK);
    let previous = snapshot(&path)?;
    let prepared = gemini_settings(previous.as_deref(), "oauth-personal")?;
    write_private(&path, &prepared).map_err(|_| "key_storage_failed")?;
    Ok(Some(BrowserSettingsGuard { path, previous, prepared, committed: false }))
}

fn codex_login(dir: &Path, key: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let mut command = Command::new("cmd");
        command.args(["/D", "/C", "codex login --with-api-key"]);
        command.creation_flags(flowcode_shared::CREATE_NO_WINDOW);
        command.env("NoDefaultCurrentDirectoryInExePath", "1");
        command
    };
    #[cfg(not(target_os = "windows"))]
    let mut command = {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
        let mut command = Command::new(shell);
        command.args(["-lc", "exec codex login --with-api-key"]);
        command
    };
    let mut child = command.current_dir(dir).env("CODEX_HOME", dir)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|_| "auth_setup_failed")?;
    let Some(mut input) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return Err("auth_setup_failed".into());
    };
    let secret = key.to_owned();
    // Bound the process even if it never reads stdin. The timeout helper
    // kills its complete process tree, which also releases this writer.
    let writer = std::thread::spawn(move || writeln!(input, "{secret}"));
    let result = flowcode_shared::wait_with_timeout(child, LOGIN_TIMEOUT)
        .map_err(|_| "auth_setup_failed")?;
    if writer.join().ok().and_then(Result::ok).is_none() || !result.status.success() {
        return Err("auth_setup_failed".into());
    }
    // Native CLI output is deliberately discarded; it is not UI text.
    Ok(())
}

/// Validate before changing any saved configuration. The caller must run this
/// blocking operation off the UI thread and serialize logins for this account.
pub fn save_key_cancellable(app: &AppHandle, cli: &str, profile: Option<&str>, key: &str, cancelled: &AtomicBool) -> Result<(), String> {
    check_cancelled(cancelled)?;
    let key = normalize_key(key)?;
    let dir = dir(app, cli, profile)?;
    let validation = validate_key(cli, key);
    check_cancelled(cancelled)?;
    validation?;
    let _guard = crate::util::lock(&STORE_LOCK);
    check_cancelled(cancelled)?;
    ensure_dir(&dir).map_err(|_| "key_storage_failed")?;
    let record = record_bytes(&AuthRecord { method: "apiKey".into(), api_key: Some(key.into()) })?;
    let native_path = match cli {
        "gemini" => Some(dir.join("settings.json")),
        "codex" => Some(dir.join("auth.json")),
        _ => None,
    };
    let old_native = native_path.as_ref().map(|path| snapshot(path)).transpose()?.flatten();
    if cli == "gemini" {
        let settings = gemini_settings(old_native.as_deref(), "gemini-api-key")?;
        write_private(native_path.as_ref().unwrap(), &settings).map_err(|_| "key_storage_failed")?;
    } else if cli == "codex" {
        if let Err(error) = codex_login(&dir, key) {
            restore(native_path.as_ref().unwrap(), old_native.as_deref())?;
            check_cancelled(cancelled)?;
            return Err(error);
        }
    }
    commit_key_record(&dir.join(RECORD_NAME), &record, native_path.as_deref(), old_native.as_deref(), cancelled)
}

fn commit_key_record(record_path: &Path, record: &[u8], native_path: Option<&Path>, old_native: Option<&[u8]>, cancelled: &AtomicBool) -> Result<(), String> {
    if let Err(error) = check_cancelled(cancelled) {
        if let Some(path) = native_path {
            restore(path, old_native)?;
        }
        return Err(error);
    }
    if write_private(record_path, record).is_err() {
        if let Some(path) = native_path {
            restore(path, old_native)?;
        }
        return Err("key_storage_failed".into());
    }
    Ok(())
}

fn check_cancelled(cancelled: &AtomicBool) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) { Err("auth_cancelled".into()) } else { Ok(()) }
}

/// Call only after the native browser login succeeds. Choosing a method or
/// cancelling a login must not discard a working saved API key.
pub fn save_browser(app: &AppHandle, cli: &str, profile: Option<&str>) -> Result<(), String> {
    let dir = dir(app, cli, profile)?;
    let _guard = crate::util::lock(&STORE_LOCK);
    ensure_dir(&dir).map_err(|_| "key_storage_failed")?;
    let path = dir.join("settings.json");
    let old_settings = if cli == "gemini" { snapshot(&path)? } else { None };
    if cli == "gemini" {
        let settings = gemini_settings(old_settings.as_deref(), "oauth-personal")?;
        write_private(&path, &settings).map_err(|_| "key_storage_failed")?;
    }
    let record = record_bytes(&AuthRecord { method: "browser".into(), api_key: None })?;
    if write_private(&dir.join(RECORD_NAME), &record).is_err() {
        if cli == "gemini" { restore(&path, old_settings.as_deref())?; }
        return Err("key_storage_failed".into());
    }
    Ok(())
}

/// Removes only Flowcode's credential record. The caller also invokes the
/// provider's native logout so cached browser credentials are removed.
pub fn clear(app: &AppHandle, cli: &str, profile: Option<&str>) -> Result<(), String> {
    let path = dir(app, cli, profile)?.join(RECORD_NAME);
    let _guard = crate::util::lock(&STORE_LOCK);
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("key_storage_failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("flowcode-auth-keys-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[test]
    fn rejects_header_or_stdin_injection_without_echoing_secret() {
        for secret in ["secret\nOPENAI_API_KEY=other", "secret\rvalue", "secret\0value", "", "a b", "é"] {
            let error = normalize_key(secret).unwrap_err();
            assert_eq!(error, "key_invalid");
            assert!(!error.contains("secret"));
        }
        assert!(normalize_key(&"s".repeat(MAX_KEY_BYTES + 1)).is_err());
        assert_eq!(normalize_key("  sk-valid-example  ").unwrap(), "sk-valid-example");
    }

    #[test]
    fn maps_http_errors_without_response_contents() {
        assert_eq!(key_status_error(401), "key_invalid");
        assert_eq!(key_status_error(403), "key_forbidden");
        assert_eq!(key_status_error(429), "provider_rate_limited");
        assert_eq!(key_status_error(302), "provider_unavailable");
        assert_eq!(key_status_error(500), "provider_unavailable");
    }

    #[test]
    fn gemini_method_change_preserves_unrelated_preferences() {
        let original = br#"{"theme":"dark","security":{"auth":{"selectedType":"oauth-personal","useExternal":true},"trust":true},"tools":{"sandbox":true}}"#;
        let modified = gemini_settings(Some(original), "gemini-api-key").unwrap();
        let value: serde_json::Value = serde_json::from_slice(&modified).unwrap();
        assert_eq!(value["theme"], "dark");
        assert_eq!(value["security"]["auth"]["selectedType"], "gemini-api-key");
        assert_eq!(value["security"]["auth"]["useExternal"], true);
        assert_eq!(value["security"]["trust"], true);
        assert_eq!(value["tools"]["sandbox"], true);
        assert!(gemini_settings(Some(b"not JSON"), "oauth-personal").is_err());
        assert!(gemini_settings(Some(br#"{"security":false}"#), "oauth-personal").is_err());
    }

    #[test]
    fn browser_preference_never_exports_a_stale_key() {
        let record = AuthRecord { method: "browser".into(), api_key: Some("old-secret".into()) };
        assert_eq!(record_env("gemini", &record), vec![("GEMINI_API_KEY".into(), "".into()), ("GOOGLE_API_KEY".into(), "".into())]);
        let record = AuthRecord { method: "apiKey".into(), api_key: Some("new-secret".into()) };
        assert_eq!(record_env("gemini", &record), vec![("GEMINI_API_KEY".into(), "new-secret".into()), ("GOOGLE_API_KEY".into(), "".into())]);
    }

    #[test]
    fn private_atomic_store_roundtrips_and_restores_previous_file() {
        let temporary = TempDir::new();
        let path = temporary.0.join(RECORD_NAME);
        let old = record_bytes(&AuthRecord { method: "apiKey".into(), api_key: Some("old-secret".into()) }).unwrap();
        write_private(&path, &old).unwrap();
        assert_eq!(read_record(&temporary.0).unwrap().api_key.as_deref(), Some("old-secret"));
        write_private(&path, &record_bytes(&AuthRecord { method: "browser".into(), api_key: None }).unwrap()).unwrap();
        assert!(read_record(&temporary.0).unwrap().api_key.is_none());
        restore(&path, Some(&old)).unwrap();
        assert_eq!(fs::read(&path).unwrap(), old);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(fs::read_dir(&temporary.0).unwrap().count(), 1);
    }

    #[test]
    fn cancelled_browser_login_restores_selection_and_preserves_cli_changes() {
        let temporary = TempDir::new();
        let path = temporary.0.join("settings.json");
        let original = br#"{"security":{"auth":{"selectedType":"gemini-api-key"}},"theme":"dark"}"#;
        let prepared = gemini_settings(Some(original), "oauth-personal").unwrap();
        let mut modified: serde_json::Value = serde_json::from_slice(&prepared).unwrap();
        modified["security"]["auth"]["newCliSetting"] = serde_json::json!(true);
        modified["theme"] = serde_json::json!("light");
        write_private(&path, &serde_json::to_vec(&modified).unwrap()).unwrap();
        rollback_gemini_selection(&path, Some(original), &prepared).unwrap();
        let actual: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(actual["security"]["auth"]["selectedType"], "gemini-api-key");
        assert_eq!(actual["security"]["auth"]["newCliSetting"], true);
        assert_eq!(actual["theme"], "light");
    }

    #[test]
    fn cancelled_browser_login_does_not_overwrite_new_auth_selection() {
        let temporary = TempDir::new();
        let path = temporary.0.join("settings.json");
        let prepared = gemini_settings(None, "oauth-personal").unwrap();
        let changed = gemini_settings(None, "vertex-ai").unwrap();
        write_private(&path, &changed).unwrap();
        rollback_gemini_selection(&path, None, &prepared).unwrap();
        assert_eq!(fs::read(&path).unwrap(), changed);
    }

    #[test]
    fn browser_guard_rollback_removes_new_unmodified_file_but_commit_keeps_it() {
        let temporary = TempDir::new();
        let path = temporary.0.join("settings.json");
        let prepared = gemini_settings(None, "oauth-personal").unwrap();
        write_private(&path, &prepared).unwrap();
        drop(BrowserSettingsGuard { path: path.clone(), previous: None, prepared: prepared.clone(), committed: false });
        assert!(!path.exists());
        write_private(&path, &prepared).unwrap();
        BrowserSettingsGuard { path: path.clone(), previous: None, prepared: prepared.clone(), committed: false }.commit();
        assert_eq!(fs::read(&path).unwrap(), prepared);
    }

    #[test]
    fn cancellation_after_native_login_restores_credentials_and_keeps_previous_record() {
        let temporary = TempDir::new();
        let path = temporary.0.join(RECORD_NAME);
        let native_path = temporary.0.join("auth.json");
        let old_record = record_bytes(&AuthRecord { method: "browser".into(), api_key: None }).unwrap();
        write_private(&path, &old_record).unwrap();
        write_private(&native_path, b"native-new-credential").unwrap();
        let new_record = record_bytes(&AuthRecord { method: "apiKey".into(), api_key: Some("new-secret".into()) }).unwrap();
        let cancelled = AtomicBool::new(true);
        let error = commit_key_record(&path, &new_record, Some(&native_path), Some(b"native-old-credential"), &cancelled).unwrap_err();
        assert_eq!(error, "auth_cancelled");
        assert_eq!(fs::read(&path).unwrap(), old_record);
        assert_eq!(fs::read(&native_path).unwrap(), b"native-old-credential");
        assert_eq!(fs::read_dir(&temporary.0).unwrap().count(), 2);
    }
}
