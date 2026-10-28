//! Voice dictation for the chat composer. The chat's agents take text, and
//! WebView2 has no Web Speech recognition, so the recognizing is local:
//! Whisper (whisper.cpp) running on the user's machine, on a model they chose
//! to download (models.rs). The microphone is read with cpal and cut into
//! phrases by a voice activity detector (audio.rs); each phrase is transcribed
//! by a worker thread (engine.rs) while the next one is being heard.
//!
//! Events, to the window that started it, each carrying the `session` token the
//! caller gave `dictation_start` (a window may host several chats, only the one
//! that started the session consumes them): `dictation://partial` `{ text }`
//! ("…" while a phrase is being transcribed, "" once it is), `dictation://final`
//! `{ text }` (a phrase settled), `dictation://level` `{ value }` (microphone
//! peak, 0..1) and `dictation://end` `{ reason, message? }` with reason
//! "stopped", "silence" or "error". A stop flushes the phrase being spoken: its
//! `final` comes before the `end`. Model downloads report to every window as
//! `dictation://download` `{ id, received, total }`, and a last time with
//! `done` ("installed", "cancelled" or "error", plus `message`).

mod audio;
mod engine;
mod models;

use flowcode_shared::i18n::tr;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

/// A session with no speech at all for this long ends by itself.
const SILENCE_TIMEOUT: Duration = Duration::from_secs(60);
const LEVEL_EVERY: Duration = Duration::from_millis(50);

/// What the thread of a session is told from outside.
enum Signal {
    /// `notify`: whether the window hears an "end" (not when a new session
    /// replaces this one, or the window is gone).
    Stop { notify: bool },
    /// Microphone audio, 16 kHz mono.
    Audio(Vec<f32>),
    /// The microphone or the recognizing failed.
    Failed(String),
}

/// A running session: the window it reports to and its thread.
struct Session {
    label: String,
    signals: mpsc::Sender<Signal>,
    thread: JoinHandle<()>,
}

impl Session {
    /// Stops the session and waits for its threads to have let go of the
    /// microphone and the model.
    fn finish(self, notify: bool) {
        let _ = self.signals.send(Signal::Stop { notify });
        let _ = self.thread.join();
    }
}

/// The one dictation session of the app, if any, and the model state around it.
#[derive(Default)]
pub struct DictationState {
    session: Mutex<Option<Session>>,
    /// Serialises start and stop: two overlapping starts would fight over
    /// the microphone.
    gate: tokio::sync::Mutex<()>,
    contexts: engine::ContextCache,
    downloads: models::Downloads,
}

impl DictationState {
    fn take(&self) -> Option<Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// A closed window ends its session, silently: nothing is left to tell.
    pub fn forget(&self, label: &str) {
        let mut session = self.session.lock().unwrap_or_else(|e| e.into_inner());
        if session.as_ref().is_some_and(|s| s.label == label) {
            if let Some(session) = session.take() {
                // Not joined: this runs on the event loop.
                let _ = session.signals.send(Signal::Stop { notify: false });
            }
        }
    }
}

/// Whether this platform can dictate at all; the composer hides its mic if not.
#[tauri::command]
pub fn dictation_supported() -> bool {
    true
}

/// The models on offer, which are installed, and the download in progress.
#[tauri::command]
pub fn dictation_models(app: AppHandle, state: State<'_, DictationState>) -> models::DictationModels {
    models::list(&app, &state.downloads)
}

/// Downloads a model; resolves once it is installed. Fails with "cancelled" if
/// `dictation_cancel_download` ended it.
#[tauri::command]
pub async fn dictation_download_model(app: AppHandle, id: String) -> Result<(), String> {
    crate::blocking(move || {
        let state = app.state::<DictationState>();
        models::download(&app, &state.downloads, &id)
    })
    .await
}

#[tauri::command]
pub fn dictation_cancel_download(state: State<'_, DictationState>) {
    state.downloads.cancel();
}

#[tauri::command]
pub async fn dictation_delete_model(
    app: AppHandle,
    state: State<'_, DictationState>,
    id: String,
) -> Result<(), String> {
    if state.downloads.is_downloading(&id) {
        return Err(tr("Il modello è in download.", "The model is being downloaded.").to_string());
    }
    state.contexts.forget(&id);
    crate::blocking(move || models::delete(&app, &id)).await
}

/// Starts listening and reports to the calling window. A session already
/// running (in any window) is stopped first. `model` is the id of the model to
/// use (else the best installed one); with none installed this fails with
/// "model-missing". `language` is a code ("it") or BCP 47 tag ("it-IT"); none
/// or "auto" lets Whisper detect it. Resolves once the microphone is listening
/// and the model loaded, or with why it couldn't.
#[tauri::command]
pub async fn dictation_start(
    window: WebviewWindow,
    state: State<'_, DictationState>,
    language: Option<String>,
    session: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let _gate = state.gate.lock().await;
    let app = window.app_handle().clone();
    let (model_id, model_path) = model
        .as_deref()
        .or_else(|| models::first_installed(&app))
        .and_then(|id| models::installed_path(&app, id).map(|path| (id.to_string(), path)))
        .ok_or_else(|| "model-missing".to_string())?;
    let token = session.unwrap_or_default();
    if let Some(previous) = state.take() {
        crate::blocking(move || {
            previous.finish(false);
            Ok(())
        })
        .await?;
    }
    let (signals, inbox) = mpsc::channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let label = window.label().to_string();
    let job = Job {
        window,
        token,
        language: engine::language_code(language.as_deref()),
        model_id,
        model_path,
        contexts: state.contexts.clone(),
        signals: signals.clone(),
    };
    let thread = std::thread::Builder::new()
        .name("dictation".into())
        .spawn(move || run(job, inbox, ready_tx))
        .map_err(|e| e.to_string())?;
    *state.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(Session { label, signals, thread });
    let ready = ready_rx.await.map_err(|e| e.to_string()).and_then(|r| r);
    if ready.is_err() {
        // The thread is gone already: don't keep a dead session around.
        if let Some(dead) = state.take() {
            let _ = dead.thread.join();
        }
    }
    ready
}

/// Stops the session, if there is one; the window still gets its "end".
#[tauri::command]
pub async fn dictation_stop(state: State<'_, DictationState>) -> Result<(), String> {
    let _gate = state.gate.lock().await;
    if let Some(session) = state.take() {
        crate::blocking(move || {
            session.finish(true);
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// Everything the thread of a session needs.
struct Job {
    window: WebviewWindow,
    token: String,
    language: String,
    model_id: String,
    model_path: std::path::PathBuf,
    contexts: engine::ContextCache,
    signals: mpsc::Sender<Signal>,
}

impl Job {
    fn emit(&self, event: &str, mut payload: Value) {
        payload["session"] = json!(self.token);
        let _ = self.window.emit_to(self.window.label(), event, payload);
    }
}

/// Transcribes the phrases it is sent, one at a time, until the channel
/// closes. Loads the model first and reports how that went on `loaded`.
fn work(job: &Job, phrases: mpsc::Receiver<Vec<f32>>, abort: &AtomicBool, loaded: mpsc::Sender<Result<(), String>>) {
    let context = match job.contexts.take(&job.model_id).map(Ok).unwrap_or_else(|| engine::load(&job.model_path)) {
        Ok(context) => context,
        Err(message) => {
            let _ = loaded.send(Err(message));
            return;
        }
    };
    let mut state = match engine::new_state(&context) {
        Ok(state) => state,
        Err(message) => {
            let _ = loaded.send(Err(message));
            return;
        }
    };
    let _ = loaded.send(Ok(()));
    for audio in phrases {
        if abort.load(Ordering::Relaxed) {
            break;
        }
        job.emit("dictation://partial", json!({ "text": "…" }));
        let heard = engine::transcribe(&mut state, &audio, &job.language);
        job.emit("dictation://partial", json!({ "text": "" }));
        match heard {
            Ok(text) if !text.is_empty() => job.emit("dictation://final", json!({ "text": text })),
            Ok(_) => {}
            Err(message) => {
                let base = tr("Il riconoscimento vocale è fallito", "Speech recognition failed");
                let _ = job.signals.send(Signal::Failed(format!("{base}: {message}")));
            }
        }
    }
    drop(state);
    job.contexts.put(&job.model_id, context);
}

/// The thread of a session: opens the microphone and the model, answers
/// `ready`, then cuts the audio into phrases for the worker until told to stop
/// or something ends the session.
fn run(job: Job, inbox: mpsc::Receiver<Signal>, ready: tokio::sync::oneshot::Sender<Result<(), String>>) {
    let audio_tx = job.signals.clone();
    let error_tx = job.signals.clone();
    let capture = audio::open(
        move |samples| {
            let _ = audio_tx.send(Signal::Audio(samples.to_vec()));
        },
        move |message| {
            let _ = error_tx.send(Signal::Failed(message));
        },
    );
    let capture = match capture {
        Ok(capture) => capture,
        Err(message) => {
            let _ = ready.send(Err(message));
            return;
        }
    };

    let abort = Arc::new(AtomicBool::new(false));
    let (phrases_tx, phrases_rx) = mpsc::channel();
    let (loaded_tx, loaded_rx) = mpsc::channel();
    let worker = std::thread::scope(|scope| {
        let worker = scope.spawn(|| work(&job, phrases_rx, &abort, loaded_tx));
        // The audio meanwhile queues up in `inbox`.
        match loaded_rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(message)) => {
                let _ = ready.send(Err(message));
                drop(capture);
                let _ = worker.join();
                return;
            }
            Err(_) => {
                let _ = ready.send(Err(tr("Il riconoscimento vocale non è partito.", "Speech recognition didn't start.").to_string()));
                drop(capture);
                return;
            }
        }
        let _ = ready.send(Ok(()));

        let mut segmenter = audio::Segmenter::default();
        let mut peak = 0f32;
        let mut last_level = Instant::now();
        let mut last_activity = Instant::now();
        // None: the window isn't told (it left, or another session took over).
        let end: Option<(&str, Option<String>)> = loop {
            let signal = inbox.recv_timeout(LEVEL_EVERY);
            match signal {
                Ok(Signal::Stop { notify: true }) => break Some(("stopped", None)),
                Ok(Signal::Stop { notify: false }) | Err(mpsc::RecvTimeoutError::Disconnected) => break None,
                Ok(Signal::Failed(message)) => break Some(("error", Some(message))),
                Ok(Signal::Audio(samples)) => {
                    peak = samples.iter().fold(peak, |p, s| p.max(s.abs()));
                    for phrase in segmenter.push(&samples) {
                        let _ = phrases_tx.send(phrase);
                    }
                    if segmenter.in_phrase() {
                        last_activity = Instant::now();
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if last_level.elapsed() >= LEVEL_EVERY {
                last_level = Instant::now();
                job.emit("dictation://level", json!({ "value": peak.min(1.0) }));
                peak = 0.0;
            }
            if !segmenter.in_phrase() && last_activity.elapsed() >= SILENCE_TIMEOUT {
                break Some(("silence", None));
            }
        };

        drop(capture);
        if end.is_some() {
            // Audio that arrived before the stop still counts.
            for signal in inbox.try_iter() {
                if let Signal::Audio(samples) = signal {
                    for phrase in segmenter.push(&samples) {
                        let _ = phrases_tx.send(phrase);
                    }
                }
            }
            if let Some(phrase) = segmenter.flush() {
                let _ = phrases_tx.send(phrase);
            }
        } else {
            abort.store(true, Ordering::Relaxed);
        }
        // Closing the channel lets the worker finish what it was sent (so every
        // "final" is out) and hand the model back to the cache.
        drop(phrases_tx);
        let _ = worker.join();
        if let Some((reason, message)) = end {
            job.emit("dictation://end", json!({ "reason": reason, "message": message }));
        }
    });
    let _ = worker;
}
