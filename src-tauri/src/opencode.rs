//! OpenCode (`opencode`, npm `opencode-ai`). Its credentials live inside the
//! sqlite `opencode.db`, so there is no readable file: sign-in state, login and
//! logout go through the CLI's own `auth` commands. A terminal command attaches
//! to a shared background service that ignores the profile env, so named
//! profiles add the global `--standalone` flag.

use std::time::Duration;

/// `opencode [--standalone] <rest>`.
pub fn command_line(standalone: bool, rest: &str) -> String {
    if standalone { format!("opencode --standalone {rest}") } else { format!("opencode {rest}") }
}

/// Integration ids in `opencode auth list --format json`, read defensively:
/// an array of strings, an array of objects (`id` / `target` / `provider` /
/// `name`), or an object keyed by id.
fn credential_ids(value: &serde_json::Value) -> Vec<String> {
    use serde_json::Value;
    match value {
        Value::Array(items) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(s) => Some(s.clone()),
                // `connections` (opencode 1.19): only stored credentials can be logged out; env-var ones can't.
                Value::Object(o) if o.get("connections").and_then(|c| c.as_array()).is_some_and(|c| !c.iter().any(|c| c.get("type").and_then(|t| t.as_str()) == Some("credential"))) => None,
                Value::Object(o) => ["id", "target", "provider", "name"].iter().find_map(|k| o.get(*k).and_then(|v| v.as_str()).map(String::from)),
                _ => None,
            })
            .collect(),
        Value::Object(o) => o.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Whether the JSON lists anything at all (any non-empty array / object).
pub fn has_credentials(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(a) => !a.is_empty(),
        serde_json::Value::Object(o) => !o.is_empty(),
        _ => false,
    }
}

fn list_json(envs: &[(String, String)], standalone: bool, timeout: Duration) -> Result<serde_json::Value, String> {
    let out = flowcode_shared::run_command_blocking_timeout(&command_line(standalone, "auth list --format json"), envs, timeout)
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { "`opencode auth list` failed".into() } else { err });
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("unreadable `opencode auth list` output: {e}"))
}

/// `Some(logged in)`, or `None` when the status can't be told.
pub fn is_logged_in(envs: &[(String, String)], standalone: bool, timeout: Duration) -> Option<bool> {
    list_json(envs, standalone, timeout).ok().map(|v| has_credentials(&v))
}

/// Logs out of every saved integration.
pub fn logout(envs: &[(String, String)], standalone: bool, timeout: Duration) -> Result<(), String> {
    let value = list_json(envs, standalone, timeout)?;
    for id in credential_ids(&value) {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
            return Err(format!("unexpected integration id: {id}"));
        }
        let out = flowcode_shared::run_command_blocking_timeout(&command_line(standalone, &format!("auth logout {id}")), envs, timeout)
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() { format!("`opencode auth logout {id}` failed") } else { err });
        }
    }
    Ok(())
}

/// A spending budget of the OpenCode Console workspace, in USD.
#[derive(serde::Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleBudget {
    pub spent: f64,
    pub limit: f64,
    pub resets_at: Option<String>,
}

/// The OpenCode Console (opencode.ai) workspace the CLI is signed in to.
#[derive(serde::Serialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleInfo {
    pub workspace: Option<String>,
    /// The workspace's activity page - only ever an https opencode.ai URL.
    pub usage_url: Option<String>,
    pub budgets: Vec<ConsoleBudget>,
}

/// Reads `opencode api get /api/experimental/usage/limits` defensively: only
/// `workspace` (`name`, `usageURL`) and an empty `budgets` have been seen, so
/// budget fields are looked up under a few likely names and skipped when absent.
fn parse_console(v: &serde_json::Value) -> ConsoleInfo {
    let ws = &v["workspace"];
    let workspace = ws["name"].as_str().map(str::trim).filter(|s| !s.is_empty() && s.len() <= 100).map(String::from);
    let usage_url = ws["usageURL"].as_str().filter(|u| {
        u.parse::<tauri::Url>().is_ok_and(|p| {
            p.scheme() == "https" && p.username().is_empty() && p.password().is_none()
                && p.host_str().is_some_and(|h| h == "opencode.ai" || h.ends_with(".opencode.ai"))
        })
    }).map(String::from);
    let num = |b: &serde_json::Value, keys: &[&str]| keys.iter().find_map(|k| b[*k].as_f64());
    let budgets = v["budgets"].as_array().map(|items| {
        items.iter().filter_map(|b| {
            let limit = num(b, &["limit", "amount", "max", "budget"])?;
            let spent = num(b, &["spent", "used", "usage", "current"])?;
            (limit > 0.0 && spent >= 0.0).then(|| ConsoleBudget {
                spent,
                limit,
                resets_at: ["resetsAt", "resetAt", "periodEnd"].iter().find_map(|k| b[*k].as_str().map(String::from)),
            })
        }).collect()
    }).unwrap_or_default();
    ConsoleInfo { workspace, usage_url, budgets }
}

/// The OpenCode Console workspace and budgets of a profile (`None`: default).
/// Empty when signed in only with another provider's key, or when this
/// OpenCode has no `api` command.
#[tauri::command]
pub async fn opencode_console(app: tauri::AppHandle, profile: Option<String>) -> Result<ConsoleInfo, String> {
    crate::blocking(move || {
        let envs = crate::profiles::env_for_cli(&app, profile.as_deref(), "opencode");
        let line = command_line(profile.is_some(), "api get /api/experimental/usage/limits");
        let out = flowcode_shared::run_command_blocking_timeout(&line, &envs, Duration::from_secs(15)).map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(if err.is_empty() { "`opencode api` failed".into() } else { err });
        }
        let value: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| format!("unreadable `opencode api` output: {e}"))?;
        Ok(parse_console(&value))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn standalone_only_when_asked() {
        assert_eq!(command_line(false, "auth list"), "opencode auth list");
        assert_eq!(command_line(true, "auth list"), "opencode --standalone auth list");
    }

    #[test]
    fn reads_ids_defensively() {
        assert_eq!(credential_ids(&json!(["a", "b"])), vec!["a", "b"]);
        assert_eq!(credential_ids(&json!([{"id": "openai"}, {"provider": "x"}, 3])), vec!["openai", "x"]);
        assert_eq!(credential_ids(&json!({"anthropic": {}})), vec!["anthropic"]);
        let listed = json!([{"id": "openai", "connections": [{"type": "credential"}]}, {"id": "openrouter", "connections": [{"type": "env"}]}]);
        assert_eq!(credential_ids(&listed), vec!["openai"]);
        assert!(credential_ids(&json!("x")).is_empty());
        assert!(has_credentials(&json!([1])) && has_credentials(&json!({"a": 1})));
        assert!(!has_credentials(&json!([])) && !has_credentials(&json!({})) && !has_credentials(&json!(null)));
    }

    #[test]
    fn parses_console_workspace_and_budgets() {
        let seen = json!({"workspace": {"id": "org_1", "name": "Personal", "usageURL": "https://opencode.ai/console/org_1/activity/overview"}, "budgets": []});
        let info = parse_console(&seen);
        assert_eq!(info.workspace.as_deref(), Some("Personal"));
        assert_eq!(info.usage_url.as_deref(), Some("https://opencode.ai/console/org_1/activity/overview"));
        assert!(info.budgets.is_empty());
        let odd = json!({"workspace": {"name": " ", "usageURL": "https://evil.example/opencode.ai"}, "budgets": [{"limit": 20, "spent": 3.2, "resetsAt": "2026-12-01T00:00:00Z"}, {"spent": 1}]});
        let info = parse_console(&odd);
        assert_eq!(info.workspace, None);
        assert_eq!(info.usage_url, None);
        assert_eq!(info.budgets, vec![ConsoleBudget { spent: 3.2, limit: 20.0, resets_at: Some("2026-12-01T00:00:00Z".into()) }]);
        assert_eq!(parse_console(&json!(null)), ConsoleInfo::default());
    }
}
