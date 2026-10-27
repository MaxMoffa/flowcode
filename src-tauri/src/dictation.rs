//! Voice dictation for the chat composer. The chat's agents take text, and
//! WebView2 has no Web Speech recognition, so the recognizing is native:
//! Windows.Media.SpeechRecognition, run on a dedicated thread (the WinRT calls
//! block) that owns the recognizer for as long as the session lasts. Other
//! platforms report dictation as unsupported.
//!
//! Events, to the window that started it, each carrying the `session` token the
//! caller gave `dictation_start` (a window may host several chats, only the one
//! that started the session consumes them): `dictation://partial` `{ text }`
//! (the words heard so far in the current phrase), `dictation://final` `{ text }`
//! (a phrase settled), `dictation://level` `{ value }` (microphone peak, 0..1)
//! and `dictation://end` `{ reason, message? }` with reason "stopped",
//! "silence" or "error". A stop flushes the pending phrase: its `final` comes
//! before the `end`.

use flowcode_shared::i18n::tr;
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread::JoinHandle;
use tauri::{State, WebviewWindow};

/// What the thread of a session is told from outside.
enum Signal {
    /// `notify`: whether the window hears an "end" (not when a new session
    /// replaces this one, or the window is gone).
    Stop { notify: bool },
    /// The recognizer ended by itself.
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Ended(End),
}

/// How a session ended, as the "end" event words it.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
struct End {
    reason: &'static str,
    message: Option<String>,
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
impl End {
    fn stopped() -> Self {
        End { reason: "stopped", message: None }
    }
    fn failed(message: String) -> Self {
        End { reason: "error", message: Some(message) }
    }
}

/// A running session: the window it reports to and its thread.
struct Session {
    label: String,
    signals: mpsc::Sender<Signal>,
    thread: JoinHandle<()>,
}

impl Session {
    /// Stops the recognizer and waits for the thread to have let go of it.
    fn finish(self, notify: bool) {
        let _ = self.signals.send(Signal::Stop { notify });
        let _ = self.thread.join();
    }
}

/// The one dictation session of the app, if any.
#[derive(Default)]
pub struct DictationState {
    session: Mutex<Option<Session>>,
    /// Serialises start and stop: two overlapping starts make WinRT fail.
    gate: tokio::sync::Mutex<()>,
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
    cfg!(target_os = "windows")
}

/// Starts listening and reports to the calling window. A session already
/// running (in any window) is stopped first. Resolves once the recognizer is
/// listening, or with why it couldn't.
#[tauri::command]
pub async fn dictation_start(
    window: WebviewWindow,
    state: State<'_, DictationState>,
    language: Option<String>,
    session: Option<String>,
) -> Result<(), String> {
    let _gate = state.gate.lock().await;
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
    let language = language_tag(language.as_deref());
    let thread = {
        let signals = signals.clone();
        std::thread::Builder::new()
            .name("dictation".into())
            .spawn(move || imp::run(window, language, token, signals, inbox, ready_tx))
            .map_err(|e| e.to_string())?
    };
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

/// The BCP 47 tag to recognize in: the requested one, a bare language code
/// widened to the region Windows ships its speech for, or the UI language.
fn language_tag(requested: Option<&str>) -> String {
    match requested.map(str::trim).filter(|l| !l.is_empty()) {
        Some(tag) if tag.eq_ignore_ascii_case("it") => "it-IT".into(),
        Some(tag) if tag.eq_ignore_ascii_case("en") => "en-US".into(),
        Some(tag) => tag.into(),
        None if flowcode_shared::i18n::is_italian() => "it-IT".into(),
        None => "en-US".into(),
    }
}

/// The user-facing wording of the failures with a known fix, from the HRESULT
/// Windows reports them with.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn failure_message(code: u32) -> Option<&'static str> {
    match code {
        // SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED
        0x8004_5509 => Some(tr(
            "Il riconoscimento vocale online è disattivato. Attivalo in Impostazioni di Windows → Privacy e sicurezza → Voce.",
            "Online speech recognition is turned off. Turn it on in Windows Settings → Privacy & security → Speech.",
        )),
        // E_ACCESSDENIED
        0x8007_0005 => Some(tr(
            "Accesso al microfono negato. Consentilo in Impostazioni di Windows → Privacy e sicurezza → Microfono.",
            "Microphone access denied. Allow it in Windows Settings → Privacy & security → Microphone.",
        )),
        // No usable audio input device
        0x8004_503A | 0xC00D_3704 | 0x8889_0004 => {
            Some(tr("Nessun microfono disponibile.", "No microphone available."))
        }
        // The speech language pack isn't installed
        0x8004_55BC | 0x8004_5003 => Some(tr(
            "La lingua del riconoscimento vocale non è installata. Aggiungila in Impostazioni di Windows → Ora e lingua → Lingua e area geografica.",
            "The speech recognition language isn't installed. Add it in Windows Settings → Time & language → Language & region.",
        )),
        // COR_E_INVALIDOPERATION: a previous recognizer was still shutting down
        0x8013_1509 => Some(tr(
            "Il riconoscimento vocale era ancora occupato: riprova.",
            "Speech recognition was still busy: try again.",
        )),
        _ => None,
    }
}

/// What the user reads for a failed start: the known wording of the code, else
/// the system's text, else (when Windows has none, or only its "cannot find
/// the text for this error code") a generic line with the hex code.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn describe_failure(code: u32, system_message: &str) -> String {
    if let Some(known) = failure_message(code) {
        return known.to_string();
    }
    let message = system_message.trim();
    let lower = message.to_lowercase();
    let generic = message.is_empty()
        || lower.contains("cannot find the text")
        || lower.contains("impossibile trovare il testo")
        || lower.contains("text associated with this error code");
    if generic {
        let base = tr(
            "Il riconoscimento vocale non è riuscito ad avviarsi",
            "Speech recognition couldn't start",
        );
        format!("{base} ({code:#010X}).")
    } else {
        message.to_string()
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::{describe_failure, failure_message, End, Signal};
    use flowcode_shared::i18n::tr;
    use serde_json::json;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
    use std::time::Duration;
    use tauri::{Emitter, WebviewWindow};
    use tokio::sync::oneshot;
    use windows::{
        core::{Interface, HSTRING},
        Foundation::{IClosable, TypedEventHandler},
        Globalization::Language,
        Media::SpeechRecognition::{
            SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
            SpeechContinuousRecognitionSession, SpeechRecognitionHypothesisGeneratedEventArgs,
            SpeechRecognitionResultStatus, SpeechRecognitionScenario, SpeechRecognitionTopicConstraint,
            SpeechRecognizer,
        },
        Win32::{
            Media::Audio::{
                eCapture, eConsole, Endpoints::IAudioMeterInformation, IMMDeviceEnumerator, MMDeviceEnumerator,
            },
            System::{
                Com::{CoCreateInstance, CLSCTX_ALL},
                WinRT::{RoInitialize, RO_INIT_MULTITHREADED},
            },
        },
    };

    fn describe(error: &windows::core::Error) -> String {
        describe_failure(error.code().0 as u32, &error.message())
    }

    /// COR_E_INVALIDOPERATION: what a start racing a recognizer still shutting
    /// down fails with.
    const BUSY: u32 = 0x8013_1509;
    const START_RETRIES: u32 = 2;

    /// The peak meter of the default microphone, if Windows gives one.
    fn open_meter() -> Option<IAudioMeterInformation> {
        unsafe {
            let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = enumerator.GetDefaultAudioEndpoint(eCapture, eConsole).ok()?;
            device.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok()
        }
    }

    /// A recognizer for `language`, or else for what Windows listens in by default.
    fn recognizer_for(language: &str) -> windows::core::Result<SpeechRecognizer> {
        Language::CreateLanguage(&HSTRING::from(language))
            .and_then(|l| SpeechRecognizer::Create(&l))
            .or_else(|_| SpeechRecognizer::new())
    }

    /// The thread of a session: sets the recognizer up, answers `ready`, then
    /// holds it until told to stop or it ends by itself.
    pub fn run(
        window: WebviewWindow,
        language: String,
        token: String,
        signals: Sender<Signal>,
        inbox: Receiver<Signal>,
        ready: oneshot::Sender<Result<(), String>>,
    ) {
        // Speech recognition lives in the multithreaded apartment; a new
        // thread starts in none.
        let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
        let mut attempt = 0;
        let (recognizer, session) = loop {
            match listen(&window, &language, &token, signals.clone()) {
                Ok(started) => break started,
                Err(error) if error.code().0 as u32 == BUSY && attempt < START_RETRIES => {
                    attempt += 1;
                    std::thread::sleep(Duration::from_millis(250));
                }
                Err(error) => {
                    let _ = ready.send(Err(describe(&error)));
                    return;
                }
            }
        };
        let _ = ready.send(Ok(()));
        let meter = open_meter();
        let end = loop {
            match inbox.recv_timeout(Duration::from_millis(50)) {
                Ok(Signal::Stop { notify: true }) => break Some(End::stopped()),
                Ok(Signal::Ended(end)) => break Some(end),
                Ok(Signal::Stop { notify: false }) | Err(RecvTimeoutError::Disconnected) => break None,
                Err(RecvTimeoutError::Timeout) => {
                    if let Some(meter) = &meter {
                        if let Ok(peak) = unsafe { meter.GetPeakValue() } {
                            let _ = window.emit_to(
                                window.label(),
                                "dictation://level",
                                json!({ "session": token, "value": peak }),
                            );
                        }
                    }
                }
            }
        };
        // Stopping flushes the pending phrase through ResultGenerated; give
        // that callback (on another thread) a moment so its "final" goes out
        // before the "end".
        if let Ok(stopping) = session.StopAsync() {
            let _ = stopping.get();
        }
        std::thread::sleep(Duration::from_millis(150));
        if let Ok(closable) = recognizer.cast::<IClosable>() {
            let _ = closable.Close();
        }
        if let Some(end) = end {
            let _ = window.emit_to(
                window.label(),
                "dictation://end",
                json!({ "session": token, "reason": end.reason, "message": end.message }),
            );
        }
    }

    fn listen(
        window: &WebviewWindow,
        language: &str,
        token: &str,
        signals: Sender<Signal>,
    ) -> windows::core::Result<(SpeechRecognizer, SpeechContinuousRecognitionSession)> {
        let recognizer = recognizer_for(language)?;
        let constraint =
            SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::new())?;
        recognizer.Constraints()?.Append(&constraint)?;
        let compiled = recognizer.CompileConstraintsAsync()?.get()?;
        if compiled.Status()? != SpeechRecognitionResultStatus::Success {
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x8004_55BCu32 as i32),
                failure_message(0x8004_55BC).unwrap_or_default(),
            ));
        }

        let target = window.clone();
        let tag = token.to_string();
        recognizer.HypothesisGenerated(&TypedEventHandler::new(
            move |_, args: windows::core::Ref<SpeechRecognitionHypothesisGeneratedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let text = args.Hypothesis()?.Text()?.to_string();
                    let _ = target.emit_to(target.label(), "dictation://partial", json!({ "session": tag, "text": text }));
                }
                Ok(())
            },
        ))?;

        let session = recognizer.ContinuousRecognitionSession()?;
        let target = window.clone();
        let tag = token.to_string();
        session.ResultGenerated(&TypedEventHandler::new(
            move |_, args: windows::core::Ref<SpeechContinuousRecognitionResultGeneratedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let result = args.Result()?;
                    let text = result.Text()?.to_string();
                    if result.Status()? == SpeechRecognitionResultStatus::Success && !text.trim().is_empty() {
                        let _ = target.emit_to(target.label(), "dictation://final", json!({ "session": tag, "text": text }));
                    }
                }
                Ok(())
            },
        ))?;
        session.Completed(&TypedEventHandler::new(
            move |_, args: windows::core::Ref<SpeechContinuousRecognitionCompletedEventArgs>| {
                if let Some(args) = args.as_ref() {
                    let _ = signals.send(Signal::Ended(end_of(args.Status()?)));
                }
                Ok(())
            },
        ))?;
        session.StartAsync()?.get()?;
        Ok((recognizer, session))
    }

    /// How the recognizer's own ending reads to the user.
    fn end_of(status: SpeechRecognitionResultStatus) -> End {
        match status {
            SpeechRecognitionResultStatus::Success | SpeechRecognitionResultStatus::UserCanceled => End::stopped(),
            SpeechRecognitionResultStatus::TimeoutExceeded | SpeechRecognitionResultStatus::PauseLimitExceeded => {
                End { reason: "silence", message: None }
            }
            SpeechRecognitionResultStatus::MicrophoneUnavailable => {
                End::failed(failure_message(0x8004_503A).unwrap_or_default().to_string())
            }
            SpeechRecognitionResultStatus::TopicLanguageNotSupported => {
                End::failed(failure_message(0x8004_55BC).unwrap_or_default().to_string())
            }
            SpeechRecognitionResultStatus::NetworkFailure => End::failed(
                tr(
                    "Rete non raggiungibile per il riconoscimento vocale.",
                    "The network is unreachable for speech recognition.",
                )
                .to_string(),
            ),
            _ => End::failed(
                tr("Il riconoscimento vocale si è interrotto.", "Speech recognition stopped unexpectedly.").to_string(),
            ),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// Run by hand (`cargo test dictation -- --ignored`): whether WinRT
        /// speech works on this machine. It needs a speech language installed
        /// and, to compile the dictation constraint, "Online speech
        /// recognition" turned on.
        #[test]
        #[ignore]
        fn recognizer_compiles_dictation_constraints() {
            let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
            let recognizer = recognizer_for("en-US").map_err(|e| describe(&e)).unwrap();
            let constraint =
                SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &HSTRING::new())
                    .unwrap();
            recognizer.Constraints().unwrap().Append(&constraint).unwrap();
            let compiled = recognizer
                .CompileConstraintsAsync()
                .unwrap()
                .get()
                .map_err(|e| describe(&e))
                .unwrap();
            assert_eq!(compiled.Status().unwrap(), SpeechRecognitionResultStatus::Success);
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use super::Signal;
    use flowcode_shared::i18n::tr;
    use std::sync::mpsc::{Receiver, Sender};
    use tauri::WebviewWindow;
    use tokio::sync::oneshot;

    pub fn run(
        _window: WebviewWindow,
        _language: String,
        _session: String,
        _signals: Sender<Signal>,
        _inbox: Receiver<Signal>,
        ready: oneshot::Sender<Result<(), String>>,
    ) {
        let _ = ready.send(Err(tr(
            "Il dettato vocale non è supportato su questa piattaforma.",
            "Dictation isn't supported on this platform.",
        )
        .to_string()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tag_widens_bare_codes_and_keeps_full_tags() {
        assert_eq!(language_tag(Some("it")), "it-IT");
        assert_eq!(language_tag(Some("EN")), "en-US");
        assert_eq!(language_tag(Some("fr-FR")), "fr-FR");
        assert_eq!(language_tag(Some("  ")), language_tag(None));
    }

    #[test]
    fn failure_message_knows_the_privacy_and_microphone_codes() {
        assert!(failure_message(0x8004_5509).is_some_and(|m| m.contains("Privacy")));
        assert!(failure_message(0x8007_0005).is_some());
        assert!(failure_message(0x8000_4005).is_none());
        assert!(failure_message(0x8013_1509).is_some());
    }

    #[test]
    fn describe_failure_never_shows_an_empty_text() {
        assert!(describe_failure(0x8000_4005, "").contains("0x80004005"));
        assert!(describe_failure(0x8000_4005, "  ").contains("0x80004005"));
        assert!(describe_failure(0x8000_4005, "Impossibile trovare il testo associato a questo codice di errore.")
            .contains("0x80004005"));
        assert!(describe_failure(0x8000_4005, "Cannot find the text for this error code").contains("0x80004005"));
        assert_eq!(describe_failure(0x8000_4005, "Boom"), "Boom");
        assert_eq!(describe_failure(0x8013_1509, ""), failure_message(0x8013_1509).unwrap());
    }
}
