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

/// Whisper's language codes for what the frontend asked: a comma-separated list
/// of the primary subtags of BCP 47 tags ("it-IT, en" → ["it", "en"]). Empty
/// ("auto", none, or nothing Whisper knows) means detect among all of them.
pub fn language_codes(requested: Option<&str>) -> Vec<String> {
    let mut codes: Vec<String> = Vec::new();
    for tag in requested.unwrap_or_default().split(',') {
        let primary = tag.trim().split(['-', '_']).next().unwrap_or_default().to_ascii_lowercase();
        // Letters only: get_lang_id panics on a NUL byte.
        if primary.is_empty()
            || primary == "auto"
            || !primary.bytes().all(|b| b.is_ascii_alphabetic())
            || whisper_rs::get_lang_id(&primary).is_none()
        {
            continue;
        }
        if !codes.contains(&primary) {
            codes.push(primary);
        }
    }
    codes
}

fn thread_count() -> i32 {
    std::thread::available_parallelism().map_or(4, |n| n.get()).min(8) as i32
}

/// The allowed language id with the highest probability (the first on a tie),
/// `probs` being indexed by language id.
fn best_allowed(probs: &[f32], allowed: &[i32]) -> Option<i32> {
    let mut best: Option<(i32, f32)> = None;
    for &id in allowed {
        let Some(&p) = usize::try_from(id).ok().and_then(|i| probs.get(i)) else { continue };
        if best.is_none_or(|(_, top)| p > top) {
            best = Some((id, p));
        }
    }
    best.map(|(id, _)| id)
}

/// The language to transcribe `audio` in: "auto" with no `allowed` language, the
/// one there is, or else the most likely of them according to Whisper.
pub fn pick_language(state: &mut WhisperState, audio: &[f32], allowed: &[String]) -> String {
    match allowed {
        [] => return "auto".into(),
        [only] => return only.clone(),
        _ => {}
    }
    let first = allowed[0].clone();
    let threads = thread_count() as usize;
    if state.pcm_to_mel(audio, threads).is_err() {
        return first;
    }
    let Ok((_, probs)) = state.lang_detect(0, threads) else { return first };
    let ids: Vec<i32> = allowed.iter().filter_map(|code| whisper_rs::get_lang_id(code)).collect();
    best_allowed(&probs, &ids)
        .and_then(|id| allowed.iter().find(|code| whisper_rs::get_lang_id(code) == Some(id)).cloned())
        .unwrap_or(first)
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

/// Longest "(...)" or "*...*", in words, still taken for a sound description.
const ANNOTATION_MAX_WORDS: usize = 3;

/// `text` without the sounds Whisper describes instead of words ("[Musica]",
/// "(risate)", "*applausi*", "♪"), with the spacing left behind tidied up.
pub fn strip_annotations(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(c) = rest.chars().next() {
        let close = match c {
            '[' => Some((']', usize::MAX)),
            '(' => Some((')', ANNOTATION_MAX_WORDS)),
            '*' => Some(('*', ANNOTATION_MAX_WORDS)),
            _ => None,
        };
        if let Some((close, max_words)) = close {
            if let Some(end) = rest[1..].find(close) {
                let inner = &rest[1..1 + end];
                if inner.split_whitespace().count() <= max_words {
                    rest = &rest[1 + end + close.len_utf8()..];
                    out.push(' ');
                    continue;
                }
            }
        }
        if !matches!(c, '♪' | '♫') {
            out.push(c);
        }
        rest = &rest[c.len_utf8()..];
    }
    let mut tidy = String::with_capacity(out.len());
    for word in out.split_whitespace() {
        let glued = word.chars().next().is_some_and(|c| matches!(c, ',' | '.' | '!' | '?' | ';' | ':'));
        if !tidy.is_empty() && !glued {
            tidy.push(' ');
        }
        tidy.push_str(word);
    }
    tidy
}

/// The words in `audio` (16 kHz mono), or "" if there are none worth keeping.
pub fn transcribe(state: &mut WhisperState, audio: &[f32], language: &str) -> Result<String, String> {
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    params.set_n_threads(thread_count());
    params.set_no_context(true);
    // Several segments: with one, whisper.cpp drops what follows an early end of text.
    params.set_single_segment(false);
    params.set_suppress_blank(true);
    // No "[Musica]", "(risate)", "♪": sounds aren't words.
    params.set_suppress_nst(true);
    params.set_no_speech_thold(0.6);
    params.set_initial_prompt(initial_prompt(language));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    state.full(params, audio).map_err(|e| e.to_string())?;
    let mut text = String::new();
    for segment in state.as_iter() {
        let piece = segment.to_string();
        let piece = piece.trim();
        if !piece.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(piece);
        }
    }
    let text = strip_annotations(&text);
    Ok(if is_hallucination(&text) { String::new() } else { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes_take_the_primary_subtags() {
        assert_eq!(language_codes(Some("it")), ["it"]);
        assert_eq!(language_codes(Some("it-IT")), ["it"]);
        assert_eq!(language_codes(Some("EN_us")), ["en"]);
        assert_eq!(language_codes(Some("pt-BR")), ["pt"]);
        assert_eq!(language_codes(Some("it, en-US,it,xx")), ["it", "en"]);
        assert!(language_codes(Some("auto")).is_empty());
        assert!(language_codes(Some("  ")).is_empty());
        assert!(language_codes(None).is_empty());
    }

    #[test]
    fn the_likeliest_allowed_language_wins() {
        let probs = [0.1, 0.5, 0.3, 0.05];
        assert_eq!(best_allowed(&probs, &[0, 2, 3]), Some(2));
        assert_eq!(best_allowed(&probs, &[3, 0]), Some(0));
        assert_eq!(best_allowed(&[0.2, 0.2], &[1, 0]), Some(1));
        assert_eq!(best_allowed(&probs, &[9, -1]), None);
        assert_eq!(best_allowed(&probs, &[]), None);
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
    fn sound_descriptions_are_stripped() {
        assert_eq!(strip_annotations("[Musica]"), "");
        assert_eq!(strip_annotations("Apri il file [rumore di sottofondo] di Nginx."), "Apri il file di Nginx.");
        assert_eq!(strip_annotations("Va bene (risate) allora"), "Va bene allora");
        assert_eq!(strip_annotations("Fatto *applausi* ."), "Fatto.");
        assert_eq!(strip_annotations("♪ la la ♪"), "la la");
        assert_eq!(strip_annotations("ciao [musica], come va"), "ciao, come va");
        // Longer parentheses are the speaker's, kept.
        assert_eq!(strip_annotations("usa Docker (o Podman se preferisci)"), "usa Docker (o Podman se preferisci)");
        assert_eq!(strip_annotations("apri ( senza chiudere"), "apri ( senza chiudere");
        assert_eq!(strip_annotations("2 * 3 fa 6"), "2 * 3 fa 6");
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
