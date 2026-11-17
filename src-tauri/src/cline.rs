use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use crate::usage_limits::{QuotaPeriod, UsageWindow};

const USAGE_URL: &str = "https://api.cline.bot/api/v1/users/me/plan/usage-limits";

#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum ClineUsage {
    MissingCredentials,
    RejectedCredentials,
    NoPlan,
    Available { windows: Vec<UsageWindow> },
}

fn token(raw: &str) -> Option<&str> {
    let raw = raw.trim();
    (!raw.is_empty() && raw.bytes().all(|b| b.is_ascii_graphic())).then_some(raw)
}

fn settings_token(value: &Value) -> Option<String> {
    // Both Cline and ClinePass use the Cline account session.
    let settings = &value["providers"]["cline"]["settings"];
    let auth = &settings["auth"];
    if let Some(access) = auth["accessToken"].as_str().and_then(token) {
        return Some(if access.starts_with("workos:") {
            access.to_owned()
        } else {
            format!("workos:{access}")
        });
    }
    [&settings["apiKey"], &auth["apiKey"]]
        .into_iter()
        .find_map(|key| key.as_str().and_then(token).map(str::to_owned))
}

/// The provider settings file of the Cline folder `dir` (a profile's `CLINE_DIR`). The
/// environment overrides only apply to the default profile.
fn settings_path(dir: &Path, default_profile: bool) -> PathBuf {
    if default_profile {
        let path = |key| std::env::var_os(key).filter(|value| !value.is_empty()).map(PathBuf::from);
        if let Some(file) = path("CLINE_PROVIDER_SETTINGS_PATH") {
            return file;
        }
        if let Some(data_dir) = path("CLINE_DATA_DIR") {
            return data_dir.join("settings").join("providers.json");
        }
    }
    dir.join("data").join("settings").join("providers.json")
}

fn credential(dir: &Path, default_profile: bool) -> Option<String> {
    if default_profile {
        if let Some(key) = ["CLINE_API_KEY", "CLINEPASS_API_KEY"]
            .into_iter()
            .find_map(|key| std::env::var(key).ok().and_then(|value| token(&value).map(str::to_owned)))
        {
            return Some(key);
        }
    }
    let file = std::fs::File::open(settings_path(dir, default_profile)).ok()?;
    let settings = serde_json::from_reader(file).ok()?;
    settings_token(&settings)
}

fn parse_usage(value: &Value) -> Result<ClineUsage, String> {
    if value["success"].as_bool() != Some(true) {
        return Err("Unexpected ClinePass usage response".into());
    }
    if value.get("data").is_some_and(Value::is_null) {
        return Ok(ClineUsage::NoPlan);
    }
    let limits = value["data"]["limits"]
        .as_array()
        .ok_or_else(|| "Unexpected ClinePass usage response".to_string())?;
    if limits.is_empty() {
        return Ok(ClineUsage::NoPlan);
    }
    let windows: Vec<_> = [
        ("five_hour", QuotaPeriod::FiveHours),
        ("weekly", QuotaPeriod::Week),
        ("monthly", QuotaPeriod::Month),
    ]
    .into_iter()
    .filter_map(|(name, period)| {
        limits.iter().filter(|limit| limit["type"].as_str() == Some(name)).find_map(|limit| {
            UsageWindow::new(period, &limit["percentUsed"], &limit["resetsAt"])
        })
    })
    .collect();
    if windows.is_empty() {
        return Err("ClinePass returned no recognized usage windows".into());
    }
    Ok(ClineUsage::Available { windows })
}

#[tauri::command]
pub(crate) async fn cline_usage(app: tauri::AppHandle, profile: Option<String>) -> Result<ClineUsage, String> {
    crate::blocking(move || {
        let Some(dirs) = crate::profiles::dirs(&app, profile.as_deref()) else {
            return Ok(ClineUsage::MissingCredentials);
        };
        let Some(key) = credential(&dirs.cline, profile.is_none()) else {
            return Ok(ClineUsage::MissingCredentials);
        };
        // Cline owns login and refresh of its CLI session. This probe only
        // reads the current token and uses it with Cline's own API.
        let response = ureq::AgentBuilder::new()
            .redirects(0)
            .timeout(Duration::from_secs(12))
            .build()
            .get(USAGE_URL)
            .set("Authorization", &format!("Bearer {key}"))
            .set("Accept", "application/json")
            .call();
        match response {
            Ok(response) if response.status() == 200 => {
                let value = serde_json::from_reader(response.into_reader())
                    .map_err(|_| "Invalid ClinePass usage JSON".to_string())?;
                parse_usage(&value)
            }
            Ok(response) => Err(format!("ClinePass usage returned HTTP {}", response.status())),
            Err(ureq::Error::Status(401 | 403, _)) => Ok(ClineUsage::RejectedCredentials),
            // `{"data":null,"error":"no plan history found for user","success":false}`
            Err(ureq::Error::Status(404, _)) => Ok(ClineUsage::NoPlan),
            Err(ureq::Error::Status(status, _)) => Err(format!("ClinePass usage returned HTTP {status}")),
            Err(ureq::Error::Transport(_)) => Err("Could not reach the ClinePass usage service".into()),
        }
    })
    .await
}

/// Whether the Cline config folder `dir` holds a saved login (OAuth token or API key).
pub(crate) fn has_login(dir: &Path) -> bool {
    let file = settings_path(dir, false);
    std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).is_some_and(|v| any_login(&v))
}

/// Any provider (not only Cline's own) with an account token or an API key.
fn any_login(value: &Value) -> bool {
    value["providers"].as_object().is_some_and(|providers| {
        providers.values().any(|p| {
            let settings = &p["settings"];
            settings["auth"]["accessToken"].as_str().and_then(token).is_some() || settings["apiKey"].as_str().and_then(token).is_some()
        })
    })
}

/// Removes the saved Cline login of the config folder `dir`.
pub(crate) fn logout(dir: &Path) -> Result<(), String> {
    let file = settings_path(dir, false);
    let Ok(bytes) = std::fs::read(&file) else { return Ok(()) };
    let mut v: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if let Some(providers) = v.get_mut("providers").and_then(Value::as_object_mut) {
        for p in providers.values_mut() {
            if let Some(s) = p.get_mut("settings").and_then(Value::as_object_mut) {
                s.remove("auth");
                s.remove("apiKey");
            }
        }
    }
    std::fs::write(&file, serde_json::to_vec_pretty(&v).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_only_cline_credentials_and_prefixes_oauth_once() {
        let settings = |auth| json!({"providers": {"cline": {"settings": {"auth": auth, "apiKey": "test-key"}}}});
        assert_eq!(settings_token(&settings(json!({"accessToken": " test-token "}))).as_deref(), Some("workos:test-token"));
        assert_eq!(settings_token(&settings(json!({"accessToken": "workos:test-token"}))).as_deref(), Some("workos:test-token"));
        assert_eq!(settings_token(&settings(json!({"refreshToken": "ignored"}))).as_deref(), Some("test-key"));
        assert_eq!(settings_token(&json!({"providers": {"other": {"settings": {"apiKey": "ignored"}}}})), None);
    }

    #[test]
    fn login_is_any_provider_with_token_or_key() {
        assert!(any_login(&json!({"providers": {"anthropic": {"settings": {"apiKey": "test-key"}}}})));
        assert!(any_login(&json!({"providers": {"cline": {"settings": {"auth": {"accessToken": "t"}}}}})));
        assert!(!any_login(&json!({"providers": {"cline": {"settings": {"model": "m"}}}})));
        assert!(!any_login(&json!({})));
    }

    #[test]
    fn settings_path_follows_the_profile_folder() {
        let dir = Path::new("profile-dir");
        assert_eq!(settings_path(dir, false), dir.join("data").join("settings").join("providers.json"));
    }

    #[test]
    fn reads_valid_windows_in_display_order() {
        let result = parse_usage(&json!({"success": true, "data": {"limits": [
            {"type": "monthly", "percentUsed": 77.5, "resetsAt": "2026-12-01T00:00:00Z"},
            {"type": "weekly", "percentUsed": -1},
            {"type": "five_hour", "percentUsed": 0, "resetsAt": null},
            {"type": "unknown", "percentUsed": 5}
        ]}})).unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), json!({
            "status": "available", "windows": [
                {"period": "fiveHours", "percentUsed": 0.0, "resetsAt": null},
                {"period": "month", "percentUsed": 77.5, "resetsAt": "2026-12-01T00:00:00Z"}
            ]
        }));
    }

    #[test]
    fn distinguishes_absent_plan_from_invalid_response() {
        assert_eq!(parse_usage(&json!({"success": true, "data": null})), Ok(ClineUsage::NoPlan));
        assert_eq!(parse_usage(&json!({"success": true, "data": {"limits": []}})), Ok(ClineUsage::NoPlan));
        assert!(parse_usage(&json!({"success": true})).is_err());
        assert!(parse_usage(&json!({"success": false, "data": null})).is_err());
    }
}
