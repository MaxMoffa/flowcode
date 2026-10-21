//! Voice dictation for the chat box: the bridge to the Kotlin `SpeechPlugin`
//! (Android's speech recognizer). Its `partial` / `final` / `end` events are
//! re-emitted to the webview as `speech://partial`, `speech://final` and
//! `speech://end`. Elsewhere dictation is simply unavailable.

#[cfg(target_os = "android")]
use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{Manager, State, Wry};

#[derive(Clone)]
pub struct Speech {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<Wry>,
}

#[cfg(target_os = "android")]
#[derive(serde::Deserialize)]
struct AvailableReply {
    available: bool,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct StartPayload {
    language: Option<String>,
}

#[cfg(target_os = "android")]
#[derive(Serialize)]
struct ListenerPayload {
    event: &'static str,
    handler: tauri::ipc::Channel<serde_json::Value>,
}

impl Speech {
    pub fn available(&self) -> Result<bool, String> {
        #[cfg(target_os = "android")]
        return self.handle.run_mobile_plugin::<AvailableReply>("isAvailable", ()).map(|r| r.available).map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        Ok(false)
    }

    /// Returns once listening has begun, or, the first time, once the user has
    /// answered the microphone dialog.
    pub fn start(&self, language: Option<String>) -> Result<(), String> {
        #[cfg(target_os = "android")]
        return self.handle.run_mobile_plugin::<()>("start", StartPayload { language }).map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        {
            let _ = language;
            Err("dictation is not available here".to_string())
        }
    }

    /// Ends the phrase; what was heard so far still arrives as `final`.
    pub fn stop(&self) -> Result<(), String> {
        #[cfg(target_os = "android")]
        return self.handle.run_mobile_plugin::<()>("stop", ()).map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        Ok(())
    }

    /// Drops the session without a result.
    pub fn cancel(&self) -> Result<(), String> {
        #[cfg(target_os = "android")]
        return self.handle.run_mobile_plugin::<()>("cancel", ()).map_err(|e| e.to_string());
        #[cfg(not(target_os = "android"))]
        Ok(())
    }
}

// `(async)`: the plugin calls block, `start` until the user answers a dialog.
#[tauri::command(async)]
pub fn speech_available(speech: State<'_, Speech>) -> bool {
    speech.available().unwrap_or(false)
}

#[tauri::command(async)]
pub fn speech_start(speech: State<'_, Speech>, language: Option<String>) -> Result<(), String> {
    speech.start(language)
}

#[tauri::command(async)]
pub fn speech_stop(speech: State<'_, Speech>) -> Result<(), String> {
    speech.stop()
}

#[tauri::command(async)]
pub fn speech_cancel(speech: State<'_, Speech>) -> Result<(), String> {
    speech.cancel()
}

pub fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::<Wry>::new("speech")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::ipc::{Channel, InvokeResponseBody};
                use tauri::Emitter;
                let handle = api.register_android_plugin("com.maxmoffa.flowcode.mobile", "SpeechPlugin")?;
                for event in ["partial", "final", "end"] {
                    let app = app.clone();
                    let handler = Channel::new(move |body| {
                        if let InvokeResponseBody::Json(json) = body {
                            if let Ok(payload) = serde_json::from_str::<serde_json::Value>(&json) {
                                let _ = app.emit(&format!("speech://{event}"), payload);
                            }
                        }
                        Ok(())
                    });
                    handle.run_mobile_plugin::<()>("registerListener", ListenerPayload { event, handler }).map_err(|e| e.to_string())?;
                }
                app.manage(Speech { handle });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(Speech {});
            }
            Ok(())
        })
        .build()
}
