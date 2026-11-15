//! Dictation for the phone: the phone records and streams 16 kHz mono audio,
//! the desktop's session (mod.rs `run` / `work`) cuts it into phrases and
//! transcribes it exactly as it does for the microphone. This file is only the
//! seam: how a session is started from outside the app's windows, what it
//! reports, and how the phone's bytes become samples. The link side (messages,
//! the audio stream) lives in remote/dictation.rs.
//!
//! One session at a time app-wide, like the microphone's. A phone's start fails
//! with "busy" while a window's session runs; a window's start still takes over
//! from a phone's session (as it does from another window's), which then ends
//! "cancelled".

use flowcode_shared::i18n::tr;
use serde_json::Value;
use std::sync::mpsc;
use tauri::{AppHandle, Manager};
use tokio::sync::mpsc::UnboundedSender;

use super::{engine, models, DictationState, Job, Session, Signal, Sink, Source, VOCABULARY_MAX_CHARS};

/// Longest session: this much audio, then it is dropped and ends with an error.
pub const MAX_SECONDS: usize = 10 * 60;
/// The same limit in bytes of s16le (what the phone sends).
pub const MAX_BYTES: usize = MAX_SECONDS * super::audio::RATE as usize * 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    Done,
    Cancelled,
    Error,
}

/// What a phone's session reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Partial(String),
    Final(String),
    End { reason: EndReason, message: Option<String> },
}

/// A window event of the shared pipeline as the phone sees it: the microphone
/// level means nothing to it, and the way a session ended is folded to done
/// ("stopped", "silence") or error.
pub fn event_of(event: &str, payload: &Value) -> Option<Event> {
    let text = || payload["text"].as_str().unwrap_or_default().to_string();
    match event {
        "dictation://partial" => Some(Event::Partial(text())),
        "dictation://final" => Some(Event::Final(text())),
        "dictation://end" => {
            let error = payload["reason"] == "error";
            Some(Event::End {
                reason: if error { EndReason::Error } else { EndReason::Done },
                message: payload["message"].as_str().map(str::to_string),
            })
        }
        _ => None,
    }
}

/// Why a phone's session couldn't start.
#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    ModelMissing,
    Busy,
    Failed(String),
}

impl StartError {
    /// The protocol's error code.
    pub fn code(&self) -> &'static str {
        match self {
            StartError::ModelMissing => "model-missing",
            StartError::Busy => "busy",
            StartError::Failed(_) => "failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            StartError::ModelMissing => {
                tr("Nessun modello di dettatura installato sul computer.", "No dictation model is installed on the computer.").to_string()
            }
            StartError::Busy => tr("La dettatura è già in uso sul computer.", "Dictation is already in use on the computer.").to_string(),
            StartError::Failed(message) => message.clone(),
        }
    }
}

/// Counts the audio of a session against `MAX_BYTES`.
#[derive(Default)]
pub struct Budget {
    used: usize,
}

impl Budget {
    /// Takes `bytes` from the budget; false once the session is over the limit.
    pub fn take(&mut self, bytes: usize) -> bool {
        self.used = self.used.saturating_add(bytes);
        self.used <= MAX_BYTES
    }
}

/// Turns the phone's bytes (s16le, 16 kHz mono) into the f32 samples the
/// pipeline takes. A sample can be split between two reads: its first byte waits.
#[derive(Default)]
pub struct PcmDecoder {
    carry: Option<u8>,
}

impl PcmDecoder {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<f32> {
        let mut out = Vec::with_capacity(bytes.len() / 2 + 1);
        let mut rest = bytes;
        if let Some(low) = self.carry {
            let Some((&high, tail)) = rest.split_first() else { return out };
            self.carry = None;
            out.push(i16::from_le_bytes([low, high]) as f32 / 32768.0);
            rest = tail;
        }
        let pairs = rest.chunks_exact(2);
        if let [last] = pairs.remainder() {
            self.carry = Some(*last);
        }
        out.extend(pairs.map(|p| i16::from_le_bytes([p[0], p[1]]) as f32 / 32768.0));
        out
    }
}

/// The language a phone's session listens for: the desktop's own setting wins;
/// with none ("" or "auto") the phone's hint is used.
pub fn language_for(pref: &str, hint: Option<&str>) -> Option<String> {
    let pref = pref.trim();
    if !pref.is_empty() && !pref.eq_ignore_ascii_case("auto") {
        return Some(pref.to_string());
    }
    hint.map(str::trim).filter(|h| !h.is_empty()).map(str::to_string)
}

/// A running phone session, as its owner steers it. Dropping it does nothing:
/// say `cancel` (or `stop`) to end the thread.
pub struct Handle {
    signals: mpsc::Sender<Signal>,
}

impl Handle {
    pub fn audio(&self, samples: Vec<f32>) {
        let _ = self.signals.send(Signal::Audio(samples));
    }

    /// End of speech: what was sent is transcribed, then the session ends `Done`.
    pub fn stop(&self) {
        let _ = self.signals.send(Signal::Stop { notify: true });
    }

    /// Drops the session; it ends `Cancelled`.
    pub fn cancel(&self) {
        let _ = self.signals.send(Signal::Stop { notify: false });
    }
}

/// Starts a session fed by the phone. Resolves once the model is loaded (the
/// first `Event` can follow right away), or with why it can't be. From then on
/// exactly one `Event::End` comes on `events`.
pub async fn start(
    app: &AppHandle,
    language_hint: Option<&str>,
    events: UnboundedSender<Event>,
) -> Result<Handle, StartError> {
    let state = app.state::<DictationState>();
    let _gate = state.gate.lock().await;
    {
        let mut slot = state.session.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|s| !s.thread.is_finished()) {
            return Err(StartError::Busy);
        }
        // A session that ended by itself leaves its entry behind.
        if let Some(dead) = slot.take() {
            let _ = dead.thread.join();
        }
    }
    let prefs = state.remote_prefs.lock().unwrap_or_else(|e| e.into_inner()).clone();
    // The preferred model if it is installed, else whichever is.
    let (model_id, model_path) = prefs
        .model
        .as_deref()
        .into_iter()
        .chain(models::first_installed(app))
        .find_map(|id| models::installed_path(app, id).map(|path| (id.to_string(), path)))
        .ok_or(StartError::ModelMissing)?;
    let language = language_for(&prefs.language, language_hint);
    let (signals, inbox) = mpsc::channel();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let job = Job {
        sink: Sink::Remote(events),
        source: Source::Remote,
        languages: engine::language_codes(language.as_deref()),
        vocabulary: prefs.vocabulary.chars().take(VOCABULARY_MAX_CHARS).collect(),
        model_id,
        model_path,
        accel: if prefs.accel.is_empty() { "auto".into() } else { prefs.accel },
        gpu: prefs.gpu,
        contexts: state.contexts.clone(),
        signals: signals.clone(),
    };
    let thread = std::thread::Builder::new()
        .name("dictation".into())
        .spawn(move || super::run(job, inbox, ready_tx))
        .map_err(|e| StartError::Failed(e.to_string()))?;
    let thread_id = thread.thread().id();
    *state.session.lock().unwrap_or_else(|e| e.into_inner()) = Some(Session { label: "remote".into(), signals: signals.clone(), thread });
    let ready = ready_rx.await.map_err(|e| e.to_string()).and_then(|r| r);
    match ready {
        Ok(()) => Ok(Handle { signals }),
        Err(message) => {
            // The thread is gone already: don't keep a dead session around.
            if let Some(dead) = state.take_thread(thread_id) {
                let _ = dead.thread.join();
            }
            Err(StartError::Failed(message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_is_scaled_like_the_microphone_path() {
        let mut d = PcmDecoder::default();
        let bytes: Vec<u8> = [0i16, 16384, -32768, 32767].iter().flat_map(|s| s.to_le_bytes()).collect();
        let out = d.push(&bytes);
        assert_eq!(out, vec![0.0, 0.5, -1.0, 32767.0 / 32768.0]);
    }

    #[test]
    fn a_sample_split_between_reads_is_kept_whole() {
        let mut d = PcmDecoder::default();
        let [lo, hi] = 1000i16.to_le_bytes();
        let [lo2, hi2] = (-2i16).to_le_bytes();
        assert!(d.push(&[lo]).is_empty());
        assert_eq!(d.push(&[hi, lo2]), vec![1000.0 / 32768.0]);
        assert_eq!(d.push(&[hi2]), vec![-2.0 / 32768.0]);
        assert!(d.push(&[]).is_empty());
    }

    #[test]
    fn the_session_budget_is_ten_minutes_of_audio() {
        assert_eq!(MAX_BYTES, 19_200_000);
        let mut budget = Budget::default();
        assert!(budget.take(MAX_BYTES - 1));
        assert!(budget.take(1));
        assert!(!budget.take(1));
        assert!(!Budget::default().take(usize::MAX));
    }

    #[test]
    fn the_desktop_language_wins_over_the_phones_hint() {
        assert_eq!(language_for("it,en", Some("fr")).as_deref(), Some("it,en"));
        assert_eq!(language_for("auto", Some("fr-FR")).as_deref(), Some("fr-FR"));
        assert_eq!(language_for("", Some(" ")), None);
        assert_eq!(language_for(" ", None), None);
    }

    #[test]
    fn window_events_map_to_what_the_phone_hears() {
        let say = |text: &str| serde_json::json!({ "text": text });
        assert_eq!(event_of("dictation://partial", &say("a")), Some(Event::Partial("a".into())));
        assert_eq!(event_of("dictation://final", &say("b")), Some(Event::Final("b".into())));
        assert_eq!(event_of("dictation://level", &serde_json::json!({ "value": 0.5 })), None);
        let end = |reason: &str| serde_json::json!({ "reason": reason, "message": null });
        assert_eq!(event_of("dictation://end", &end("stopped")), Some(Event::End { reason: EndReason::Done, message: None }));
        assert_eq!(event_of("dictation://end", &end("silence")), Some(Event::End { reason: EndReason::Done, message: None }));
        let failed = serde_json::json!({ "reason": "error", "message": "boom" });
        assert_eq!(event_of("dictation://end", &failed), Some(Event::End { reason: EndReason::Error, message: Some("boom".into()) }));
    }
}
