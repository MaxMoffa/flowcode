//! The recognizing: whisper.cpp through whisper-rs. A loaded model is kept for
//! a while after a session so the next one starts at once.

use flowcode_shared::i18n::tr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState};

/// How long a model stays loaded once no session uses it.
const KEEP_LOADED: Duration = Duration::from_secs(5 * 60);

/// Steers Whisper towards the vocabulary of the chat (it mangles "Nginx" or
/// "commit" without it). The lead-in is in the language spoken, so it doesn't
/// bias detection or pollute another language.
fn initial_prompt(language: &str) -> &'static str {
    match language {
        "it" => "Programmazione: Nginx, Docker, Git, branch, commit, TypeScript, Rust, npm, API, HTTPS.",
        "en" => "Programming: Nginx, Docker, Git, branch, commit, TypeScript, Rust, npm, API, HTTPS.",
        _ => "Nginx, Docker, Git, branch, commit, TypeScript, Rust, npm, API, HTTPS.",
    }
}

/// Formulas Whisper makes up out of near-silence (its training data is full of
/// subtitle credits); only a short text that opens with one is an invention.
const HALLUCINATIONS: [&str; 4] = ["sottotitoli", "grazie per la visione", "thank you for watching", "subtitles by"];

/// Longest text, in words, still taken for a made-up formula.
const HALLUCINATION_MAX_WORDS: usize = 8;

/// The model most recently used, loaded.
#[derive(Default, Clone)]
pub struct ContextCache(Arc<Mutex<CacheState>>);

#[derive(Default)]
struct CacheState {
    slot: Option<Cached>,
    /// Whether the thread that frees the slot is alive (there is only one).
    reaper_running: bool,
}

struct Cached {
    model: String,
    context: Arc<WhisperContext>,
    /// When the model is let go, unless a later `put` extends it.
    expires_at: Instant,
}

impl ContextCache {
    /// The cached context of `model`, taking it out (a session holds it while
    /// it runs and hands it back with `put`).
    pub fn take(&self, model: &str) -> Option<Arc<WhisperContext>> {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        match state.slot.take() {
            Some(cached) if cached.model == model => Some(cached.context),
            _ => None,
        }
    }

    /// Keeps `context` loaded for the next session, for a few minutes.
    pub fn put(&self, model: &str, context: Arc<WhisperContext>) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.slot = Some(Cached { model: model.to_string(), context, expires_at: Instant::now() + KEEP_LOADED });
        if state.reaper_running {
            return;
        }
        state.reaper_running = true;
        let cache = self.0.clone();
        std::thread::spawn(move || loop {
            let expires_at = {
                let mut state = cache.lock().unwrap_or_else(|e| e.into_inner());
                match state.slot.as_ref().map(|c| c.expires_at) {
                    Some(at) if Instant::now() < at => at,
                    Some(_) => {
                        state.slot = None;
                        state.reaper_running = false;
                        return;
                    }
                    None => {
                        state.reaper_running = false;
                        return;
                    }
                }
            };
            std::thread::sleep(expires_at.saturating_duration_since(Instant::now()));
        });
    }

    /// Lets go of `model` (it's being deleted).
    pub fn forget(&self, model: &str) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if state.slot.as_ref().is_some_and(|c| c.model == model) {
            state.slot = None;
        }
    }
}

pub fn load(path: &Path) -> Result<Arc<WhisperContext>, String> {
    let path = path.to_str().ok_or_else(|| tr("Percorso del modello non valido.", "Invalid model path.").to_string())?;
    WhisperContext::new_with_params(path, WhisperContextParameters::default()).map(Arc::new).map_err(|e| {
        let base = tr("Impossibile caricare il modello vocale", "Couldn't load the speech model");
        format!("{base}: {e}")
    })
}

pub fn new_state(context: &WhisperContext) -> Result<WhisperState, String> {
    context.create_state().map_err(|e| e.to_string())
}

/// Whisper's language code for what the frontend asked: the primary subtag of
/// a BCP 47 tag ("it-IT" → "it"), or "auto" to detect it.
pub fn language_code(requested: Option<&str>) -> String {
    let tag = requested.map(str::trim).unwrap_or_default();
    let primary = tag.split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase();
    if primary.is_empty() || primary == "auto" {
        "auto".into()
    } else {
        primary
    }
}

/// Whether `text` is nothing, punctuation, or one of Whisper's inventions.
pub fn is_hallucination(text: &str) -> bool {
    if !text.chars().any(char::is_alphanumeric) {
        return true;
    }
    let lower = text.to_lowercase();
    if lower.contains("amara.org") {
        return true;
    }
    let normalized = lower.trim_matches(|c: char| !c.is_alphanumeric());
    normalized.split_whitespace().count() <= HALLUCINATION_MAX_WORDS
        && HALLUCINATIONS.iter().any(|h| normalized.starts_with(h))
}

/// The words in `audio` (16 kHz mono), or "" if there are none worth keeping.
pub fn transcribe(state: &mut WhisperState, audio: &[f32], language: &str) -> Result<String, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8);
    params.set_n_threads(threads as i32);
    params.set_no_context(true);
    params.set_single_segment(true);
    params.set_suppress_blank(true);
    params.set_no_speech_thold(0.6);
    params.set_initial_prompt(initial_prompt(language));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    state.full(params, audio).map_err(|e| e.to_string())?;
    let mut text = String::new();
    for segment in state.as_iter() {
        text.push_str(&segment.to_string());
    }
    let text = text.trim();
    Ok(if is_hallucination(text) { String::new() } else { text.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_code_takes_the_primary_subtag() {
        assert_eq!(language_code(Some("it")), "it");
        assert_eq!(language_code(Some("it-IT")), "it");
        assert_eq!(language_code(Some("EN_us")), "en");
        assert_eq!(language_code(Some("pt-BR")), "pt");
        assert_eq!(language_code(Some("auto")), "auto");
        assert_eq!(language_code(Some("  ")), "auto");
        assert_eq!(language_code(None), "auto");
    }

    #[test]
    fn hallucinations_are_recognised() {
        assert!(is_hallucination(""));
        assert!(is_hallucination("  ... "));
        assert!(is_hallucination("."));
        assert!(is_hallucination("Sottotitoli creati dalla comunità Amara.org"));
        assert!(is_hallucination("Grazie per la visione!"));
        assert!(is_hallucination("Thank you for watching."));
        assert!(is_hallucination("Subtitles by the Amara.org community"));
        assert!(!is_hallucination("Apri il file di configurazione di Nginx."));
        assert!(!is_hallucination("42"));
        assert!(!is_hallucination("Aggiungi i sottotitoli al video"));
        assert!(!is_hallucination("Scrivi un test che stampa thank you for watching alla fine del video"));
        assert!(is_hallucination("Sottotitoli a cura di QTSS"));
    }

    #[test]
    fn the_prompt_follows_the_language() {
        assert!(initial_prompt("it").starts_with("Programmazione:"));
        assert!(initial_prompt("en").starts_with("Programming:"));
        assert_eq!(initial_prompt("auto"), initial_prompt("fr"));
        assert!(initial_prompt("auto").starts_with("Nginx"));
    }

    /// Run by hand: `FLOWCODE_WHISPER_MODEL=<ggml .bin> FLOWCODE_WHISPER_WAV=<16 kHz
    /// mono 16-bit wav> cargo test --release transcribes_a_wav -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn transcribes_a_wav() {
        let (Ok(model), Ok(wav)) = (std::env::var("FLOWCODE_WHISPER_MODEL"), std::env::var("FLOWCODE_WHISPER_WAV"))
        else {
            panic!("set FLOWCODE_WHISPER_MODEL and FLOWCODE_WHISPER_WAV");
        };
        let audio = read_wav(&wav);
        println!("audio {:.1}s", audio.len() as f32 / 16_000.0);
        let started = std::time::Instant::now();
        let context = load(Path::new(&model)).unwrap();
        let mut state = new_state(&context).unwrap();
        println!("load {:?}", started.elapsed());
        let started = std::time::Instant::now();
        let text = transcribe(&mut state, &audio, "it").unwrap();
        println!("transcribe {:?}: {text}", started.elapsed());
        assert!(!text.is_empty());
    }

    fn read_wav(path: &str) -> Vec<f32> {
        let bytes = std::fs::read(path).unwrap();
        let mut at = 12;
        while at + 8 <= bytes.len() {
            let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
            if &bytes[at..at + 4] == b"data" {
                return bytes[at + 8..(at + 8 + len).min(bytes.len())]
                    .chunks_exact(2)
                    .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                    .collect();
            }
            at += 8 + len + (len & 1);
        }
        panic!("no data chunk in {path}");
    }
}
