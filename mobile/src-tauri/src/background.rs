//! "Stay connected in the background": the saved setting, and the bridge to the
//! Kotlin side (`BackgroundPlugin`: foreground service, notifications,
//! notification permission). Elsewhere the plugin calls are no-ops.

use serde::{Deserialize, Serialize};
use std::path::Path;
use tauri::plugin::TauriPlugin;
use tauri::{Manager, Wry};

/// Default for "Spegni dopo", in minutes.
const DEFAULT_CAP_MINUTES: u32 = 120;

/// Not a secret, so it is stored in plain text.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    /// The service stops itself after this long in the background; 0 = never.
    pub cap_minutes: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { enabled: false, cap_minutes: DEFAULT_CAP_MINUTES }
    }
}

/// A missing or unreadable file means the defaults (off).
pub fn load(path: &Path) -> Settings {
    std::fs::read(path).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
}

pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let bytes = serde_json::to_vec(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, bytes).map_err(|e| e.to_string())
}

#[derive(Clone)]
pub struct Background {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<Wry>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArmPayload<'a> {
    armed: bool,
    title: &'a str,
    text: &'a str,
    cap_minutes: u32,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NotifyPayload<'a> {
    title: &'a str,
    body: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tab_id: Option<&'a str>,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct GrantedReply {
    granted: bool,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TabReply {
    tab_id: Option<String>,
}

impl Background {
    /// Arms (or disarms) the foreground service for when the app is paused.
    /// `title`/`text` are the ongoing notification's.
    pub fn set_armed(&self, armed: bool, title: &str, text: &str, cap_minutes: u32) -> Result<(), String> {
        #[cfg(target_os = "android")]
        return self
            .handle
            .run_mobile_plugin::<()>("setArmed", ArmPayload { armed, title, text, cap_minutes })
            .map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        {
            let _ = (armed, title, text, cap_minutes);
            Ok(())
        }
    }

    /// Posts an agent notification.
    pub fn notify(&self, title: &str, body: &str, tab_id: Option<&str>) -> Result<(), String> {
        #[cfg(target_os = "android")]
        return self.handle.run_mobile_plugin::<()>("notify", NotifyPayload { title, body, tab_id }).map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        {
            let _ = (title, body, tab_id);
            Ok(())
        }
    }

    pub fn notification_permission(&self) -> Result<bool, String> {
        #[cfg(target_os = "android")]
        return self.handle.run_mobile_plugin::<GrantedReply>("notificationPermission", ()).map(|r| r.granted).map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        Ok(true)
    }

    /// Blocks until the user has answered the system dialog.
    pub fn request_notification_permission(&self) -> Result<bool, String> {
        #[cfg(target_os = "android")]
        return self
            .handle
            .run_mobile_plugin::<GrantedReply>("requestNotificationPermission", ())
            .map(|r| r.granted)
            .map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        Ok(true)
    }

    /// The tab of the notification the app was opened from, once.
    pub fn take_pending_tab(&self) -> Result<Option<String>, String> {
        #[cfg(target_os = "android")]
        return self.handle.run_mobile_plugin::<TabReply>("takePendingTab", ()).map(|r| r.tab_id).map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        Ok(None)
    }
}

pub fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::<Wry>::new("background")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin("com.maxmoffa.flowcode.mobile", "BackgroundPlugin")?;
                app.manage(Background { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(Background {});
            }
            Ok(())
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_to_off_with_a_two_hour_cap() {
        let s = Settings::default();
        assert!(!s.enabled);
        assert_eq!(s.cap_minutes, 120);
    }

    #[test]
    fn missing_or_broken_file_means_defaults() {
        let dir = std::env::temp_dir().join(format!("flowcode-bg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("background.json");
        assert_eq!(load(&path), Settings::default());
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        save(&path, &Settings { enabled: true, cap_minutes: 0 }).unwrap();
        assert_eq!(load(&path), Settings { enabled: true, cap_minutes: 0 });
        let _ = std::fs::remove_dir_all(&dir);
    }
}
