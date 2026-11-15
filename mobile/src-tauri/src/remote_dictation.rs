//! Remote dictation, phone side of the audio: the Kotlin `AudioCapturePlugin`
//! records 16 kHz mono PCM16 and this module streams it to the desktop on a
//! `dictaudio` stream (see docs/design/remote-dictation-protocol.md). The
//! control messages (`dictstart`, `dictready`, partials...) are the page's
//! business: it already receives and sends them (`remote.ts`). A stream or
//! capture failure is reported as the `dictaudio://error` event.

use crate::state::Remote;
use flowcode_remote_proto::{preview_header, PreviewTarget};
use std::sync::{Arc, Mutex};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, State, Wry};
use tokio::sync::mpsc;

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
enum Msg {
    Chunk(Vec<u8>),
    /// End of speech: the stream is finished cleanly.
    Finish,
    /// Dropped session: the stream is reset.
    Abort,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct Active {
    session: String,
    tx: mpsc::UnboundedSender<Msg>,
}

type Shared = Arc<Mutex<Option<Active>>>;

#[derive(Clone)]
pub struct DictAudio {
    #[cfg(target_os = "android")]
    handle: tauri::plugin::PluginHandle<Wry>,
    active: Shared,
}

#[derive(serde::Serialize, Clone)]
struct ErrorEvent {
    session: String,
    message: String,
}

fn report(app: &AppHandle, session: &str, message: impl Into<String>) {
    let _ = app.emit("dictaudio://error", ErrorEvent { session: session.to_string(), message: message.into() });
}

/// Writes the header and then the chunks as they come, queued from the moment
/// the capture starts, so nothing said while the stream opens is lost.
async fn pump(conn: iroh::endpoint::Connection, session: String, mut rx: mpsc::UnboundedReceiver<Msg>) -> Result<(), String> {
    let (mut send, _recv) = conn.open_bi().await.map_err(|e| e.to_string())?;
    send.write_all(preview_header(&PreviewTarget::DictAudio(session)).as_bytes()).await.map_err(|e| e.to_string())?;
    loop {
        match rx.recv().await {
            Some(Msg::Chunk(bytes)) => send.write_all(&bytes).await.map_err(|e| e.to_string())?,
            Some(Msg::Finish) | None => {
                send.finish().map_err(|e| e.to_string())?;
                return Ok(());
            }
            Some(Msg::Abort) => {
                let _ = send.reset(0u32.into());
                return Ok(());
            }
        }
    }
}

impl DictAudio {
    #[cfg(target_os = "android")]
    fn capture_start(&self) -> Result<(), String> {
        self.handle.run_mobile_plugin::<()>("start", ()).map_err(|e| e.to_string())
    }

    #[cfg(not(target_os = "android"))]
    fn capture_start(&self) -> Result<(), String> {
        Err("audio capture is not available here".to_string())
    }

    /// Flushes the last chunk into the queue before returning.
    fn capture_stop(&self) {
        #[cfg(target_os = "android")]
        let _ = self.handle.run_mobile_plugin::<()>("stop", ());
    }

    /// Ends the current session, if any, with `msg` for its stream.
    fn finish(&self, msg: Msg) {
        self.capture_stop();
        if let Some(active) = self.active.lock().unwrap().take() {
            let _ = active.tx.send(msg);
        }
    }
}

/// Starts capturing and streaming for `session`. Returns once the microphone
/// is recording (the first time, once the user answered the permission dialog);
/// the stream opens in the background.
// `(async)`: the plugin call blocks, until the user answers a dialog.
#[tauri::command(async)]
pub fn dict_audio_start(app: AppHandle, remote: State<'_, Arc<Remote>>, audio: State<'_, DictAudio>, session: String) -> Result<(), String> {
    let conn = remote.lock().conn.clone().ok_or_else(|| "not connected".to_string())?;
    let (tx, rx) = mpsc::unbounded_channel();
    // A leftover session of ours is replaced.
    audio.finish(Msg::Abort);
    *audio.active.lock().unwrap() = Some(Active { session: session.clone(), tx });
    let task_app = app.clone();
    let task_session = session.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = pump(conn, task_session.clone(), rx).await {
            report(&task_app, &task_session, e);
        }
    });
    if let Err(e) = audio.capture_start() {
        audio.finish(Msg::Abort);
        return Err(e);
    }
    Ok(())
}

/// End of speech: stops the microphone and finishes the stream after the last chunk.
#[tauri::command(async)]
pub fn dict_audio_stop(audio: State<'_, DictAudio>) {
    audio.finish(Msg::Finish);
}

/// Drops the session: stops the microphone and resets the stream.
#[tauri::command(async)]
pub fn dict_audio_cancel(audio: State<'_, DictAudio>) {
    audio.finish(Msg::Abort);
}

pub fn init() -> TauriPlugin<Wry> {
    tauri::plugin::Builder::<Wry>::new("audiocapture")
        .setup(|app, api| {
            let active: Shared = Arc::new(Mutex::new(None));
            #[cfg(target_os = "android")]
            {
                use base64::Engine;
                use tauri::ipc::{Channel, InvokeResponseBody};

                #[derive(serde::Serialize)]
                struct ListenerPayload {
                    event: &'static str,
                    handler: Channel<serde_json::Value>,
                }
                let handle = api.register_android_plugin("com.maxmoffa.flowcode.mobile", "AudioCapturePlugin")?;
                let json_of = |body: InvokeResponseBody| match body {
                    InvokeResponseBody::Json(json) => serde_json::from_str::<serde_json::Value>(&json).ok(),
                    _ => None,
                };
                let chunks = active.clone();
                let on_chunk = Channel::new(move |body| {
                    let data = json_of(body).and_then(|v| v.get("data").and_then(|d| d.as_str()).and_then(|d| base64::engine::general_purpose::STANDARD.decode(d).ok()));
                    if let (Some(bytes), Some(active)) = (data, chunks.lock().unwrap().as_ref()) {
                        let _ = active.tx.send(Msg::Chunk(bytes));
                    }
                    Ok(())
                });
                let errors = active.clone();
                let app_for_errors = app.clone();
                let on_error = Channel::new(move |body| {
                    let message = json_of(body).and_then(|v| v.get("message").and_then(|m| m.as_str()).map(str::to_string)).unwrap_or_else(|| "capture".into());
                    if let Some(active) = errors.lock().unwrap().as_ref() {
                        report(&app_for_errors, &active.session, message);
                    }
                    Ok(())
                });
                for (event, handler) in [("chunk", on_chunk), ("error", on_error)] {
                    handle.run_mobile_plugin::<()>("registerListener", ListenerPayload { event, handler }).map_err(|e| e.to_string())?;
                }
                app.manage(DictAudio { handle, active });
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = api;
                app.manage(DictAudio { active });
            }
            Ok(())
        })
        .build()
}
