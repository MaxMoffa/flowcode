//! The microphone side of dictation: capture from the default input device,
//! conversion to what Whisper takes (mono, 16 kHz, f32) and the voice activity
//! detector that cuts the stream into phrases.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use flowcode_shared::i18n::tr;
use std::collections::VecDeque;

/// Whisper's sample rate.
pub const RATE: u32 = 16_000;

/// VAD frame: 30 ms.
const FRAME: usize = RATE as usize * 30 / 1000;
/// Audio kept from before the speech onset, so the first syllable isn't cut.
const PRE_ROLL_FRAMES: usize = 15;
/// Silence that closes a phrase.
const END_SILENCE_FRAMES: usize = 24;
/// Less speech than this is a click or a cough, not a phrase.
const MIN_SPEECH_FRAMES: usize = 10;
/// Past this length a phrase ends at the first short pause...
const SOFT_CUT_FRAMES: usize = 20 * 1000 / 30;
/// ...this long (180 ms)...
const SOFT_CUT_SILENCE_FRAMES: usize = 6;
/// ...and here at the latest (Whisper takes 30 s), at the quietest frame of the
/// last `CUT_SEARCH_FRAMES`, the rest carrying on in a new phrase.
const MAX_PHRASE_FRAMES: usize = 28 * 1000 / 30;
const CUT_SEARCH_FRAMES: usize = 3 * 1000 / 30;
/// Speech is louder than this, and than the noise floor times `FLOOR_FACTOR`.
const MIN_SPEECH_RMS: f32 = 0.008;
const FLOOR_FACTOR: f32 = 3.0;
/// Inside a phrase the bar is lowered by this much, so soft syllables and
/// word endings don't count as the pause that closes it.
const KEEP_FACTOR: f32 = 0.6;
/// The noise floor never rises above this: steady quiet speech would
/// otherwise lift it until speech no longer counts.
const MAX_FLOOR: f32 = 0.01;
/// How fast the noise floor follows the quiet frames.
const FLOOR_ALPHA: f32 = 0.02;

/// Streaming converter from a device's mono samples to 16 kHz.
pub struct Resampler {
    /// Input samples per output sample.
    step: f64,
    /// Whole-number ratios (48 kHz → 16 kHz) average their groups; others
    /// interpolate linearly.
    exact: Option<usize>,
    pending: Vec<f32>,
    /// Position of the next output sample in `pending`.
    pos: f64,
}

impl Resampler {
    pub fn new(input_rate: u32) -> Self {
        let exact = (input_rate > RATE && input_rate.is_multiple_of(RATE)).then_some((input_rate / RATE) as usize);
        Resampler { step: input_rate as f64 / RATE as f64, exact, pending: Vec::new(), pos: 0.0 }
    }

    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.step == 1.0 {
            out.extend_from_slice(input);
            return;
        }
        self.pending.extend_from_slice(input);
        if let Some(group) = self.exact {
            let whole = self.pending.len() / group * group;
            out.extend(self.pending[..whole].chunks_exact(group).map(|c| c.iter().sum::<f32>() / group as f32));
            self.pending.drain(..whole);
            return;
        }
        while self.pos + 1.0 < self.pending.len() as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.pending[i] * (1.0 - frac) + self.pending[i + 1] * frac);
            self.pos += self.step;
        }
        let used = (self.pos as usize).min(self.pending.len());
        self.pending.drain(..used);
        self.pos -= used as f64;
    }
}

fn rms(frame: &[f32]) -> f32 {
    (frame.iter().map(|s| s * s).sum::<f32>() / frame.len().max(1) as f32).sqrt()
}

/// Cuts a 16 kHz mono stream into phrases: from the speech onset (with a
/// pre-roll) until a pause. Speech is judged against an adaptive noise floor.
pub struct Segmenter {
    frame: Vec<f32>,
    floor: f32,
    pre_roll: VecDeque<Vec<f32>>,
    /// The phrase being heard, if any.
    phrase: Option<Phrase>,
}

#[derive(Default)]
struct Phrase {
    audio: Vec<f32>,
    frames: usize,
    speech_frames: usize,
    silent_run: usize,
    /// RMS of each frame since the onset.
    levels: Vec<f32>,
}

impl Default for Segmenter {
    fn default() -> Self {
        Segmenter { frame: Vec::new(), floor: 0.003, pre_roll: VecDeque::new(), phrase: None }
    }
}

impl Segmenter {
    /// Whether a phrase is being heard right now.
    pub fn in_phrase(&self) -> bool {
        self.phrase.is_some()
    }

    /// The audio of the phrase being heard so far, once it has enough speech to
    /// count as a phrase.
    pub fn current(&self) -> Option<&[f32]> {
        self.phrase.as_ref().filter(|p| p.speech_frames >= MIN_SPEECH_FRAMES).map(|p| p.audio.as_slice())
    }

    /// Feeds samples; returns the phrases they completed.
    pub fn push(&mut self, samples: &[f32]) -> Vec<Vec<f32>> {
        let mut done = Vec::new();
        self.frame.extend_from_slice(samples);
        while self.frame.len() >= FRAME {
            let frame: Vec<f32> = self.frame.drain(..FRAME).collect();
            if let Some(phrase) = self.step(frame) {
                done.push(phrase);
            }
        }
        done
    }

    /// The phrase in progress, cut short (the user stopped).
    pub fn flush(&mut self) -> Option<Vec<f32>> {
        let partial = std::mem::take(&mut self.frame);
        if !partial.is_empty() {
            if let Some(phrase) = &mut self.phrase {
                phrase.audio.extend_from_slice(&partial);
            }
        }
        self.pre_roll.clear();
        self.phrase.take().and_then(Self::finish)
    }

    fn finish(phrase: Phrase) -> Option<Vec<f32>> {
        (phrase.speech_frames >= MIN_SPEECH_FRAMES).then_some(phrase.audio)
    }

    fn step(&mut self, frame: Vec<f32>) -> Option<Vec<f32>> {
        let level = rms(&frame);
        let mut bar = (self.floor * FLOOR_FACTOR).max(MIN_SPEECH_RMS);
        if self.phrase.is_some() {
            bar *= KEEP_FACTOR;
        }
        let speech = level > bar;
        if !speech {
            self.floor = (self.floor + (level - self.floor) * FLOOR_ALPHA).min(MAX_FLOOR);
        }
        let Some(phrase) = &mut self.phrase else {
            if speech {
                let mut audio: Vec<f32> = self.pre_roll.drain(..).flatten().collect();
                audio.extend_from_slice(&frame);
                self.phrase = Some(Phrase { audio, frames: 1, speech_frames: 1, silent_run: 0, levels: vec![level] });
            } else {
                if self.pre_roll.len() == PRE_ROLL_FRAMES {
                    self.pre_roll.pop_front();
                }
                self.pre_roll.push_back(frame);
            }
            return None;
        };
        phrase.audio.extend_from_slice(&frame);
        phrase.frames += 1;
        phrase.levels.push(level);
        if speech {
            phrase.speech_frames += 1;
            phrase.silent_run = 0;
        } else {
            phrase.silent_run += 1;
        }
        if phrase.silent_run >= END_SILENCE_FRAMES
            || (phrase.frames >= SOFT_CUT_FRAMES && phrase.silent_run >= SOFT_CUT_SILENCE_FRAMES)
        {
            return self.phrase.take().and_then(Self::finish);
        }
        if phrase.frames >= MAX_PHRASE_FRAMES {
            // Speech without a pause: cut at its quietest moment and carry on.
            let (head, tail) = Self::split(std::mem::take(phrase));
            *phrase = tail;
            return Self::finish(head);
        }
        None
    }

    /// `phrase` cut after the quietest of its last `CUT_SEARCH_FRAMES` frames.
    fn split(mut phrase: Phrase) -> (Phrase, Phrase) {
        let n = phrase.levels.len();
        let from = n.saturating_sub(CUT_SEARCH_FRAMES);
        let mut quietest = from;
        for i in from..n {
            if phrase.levels[i] < phrase.levels[quietest] {
                quietest = i;
            }
        }
        // Frames after `quietest` are the tail's; the audio ends with them.
        let tail_frames = n - 1 - quietest;
        let cut = phrase.audio.len() - tail_frames * FRAME;
        let tail_levels = phrase.levels.split_off(quietest + 1);
        let tail = Phrase {
            audio: phrase.audio.split_off(cut),
            frames: tail_frames,
            speech_frames: tail_frames,
            silent_run: 0,
            levels: tail_levels,
        };
        phrase.frames -= tail_frames;
        (phrase, tail)
    }
}

/// An open microphone. The stream stops when this is dropped.
pub struct Capture {
    _stream: cpal::Stream,
}

fn open_failure(error: &cpal::Error) -> String {
    match error.kind() {
        cpal::ErrorKind::PermissionDenied => tr(
            "Accesso al microfono negato. Consentilo in Impostazioni di Windows → Privacy e sicurezza → Microfono (su macOS: Impostazioni di Sistema → Privacy e sicurezza → Microfono).",
            "Microphone access denied. Allow it in Windows Settings → Privacy & security → Microphone (on macOS: System Settings → Privacy & Security → Microphone).",
        )
        .to_string(),
        cpal::ErrorKind::DeviceNotAvailable | cpal::ErrorKind::HostUnavailable => {
            tr("Nessun microfono disponibile.", "No microphone available.").to_string()
        }
        _ => {
            let base = tr("Impossibile aprire il microfono", "Couldn't open the microphone");
            format!("{base}: {error}")
        }
    }
}

/// Opens the default input device. `on_samples` gets its audio as mono 16 kHz
/// (on the audio thread: keep it quick); `on_error` is told once if the
/// device fails later.
pub fn open(
    mut on_samples: impl FnMut(&[f32]) + Send + 'static,
    on_error: impl Fn(String) + Send + 'static,
) -> Result<Capture, String> {
    let device = cpal::default_host()
        .default_input_device()
        .ok_or_else(|| tr("Nessun microfono disponibile.", "No microphone available.").to_string())?;
    let supported = device.default_input_config().map_err(|e| open_failure(&e))?;
    let channels = supported.channels() as usize;
    let mut resampler = Resampler::new(supported.sample_rate());
    let mut mono: Vec<f32> = Vec::new();
    let mut converted: Vec<f32> = Vec::new();
    let mut deliver = move |frames: &mut dyn Iterator<Item = f32>| {
        // Downmix: the average of each frame's channels.
        mono.clear();
        let mut sum = 0.0;
        let mut n = 0;
        for s in frames {
            sum += s;
            n += 1;
            if n == channels {
                mono.push(sum / channels as f32);
                sum = 0.0;
                n = 0;
            }
        }
        converted.clear();
        resampler.process(&mono, &mut converted);
        if !converted.is_empty() {
            on_samples(&converted);
        }
    };
    let on_error = move |e: cpal::Error| {
        // Hiccups and route changes don't end the stream.
        if !matches!(
            e.kind(),
            cpal::ErrorKind::Xrun
                | cpal::ErrorKind::DeviceChanged
                | cpal::ErrorKind::DeviceBusy
                | cpal::ErrorKind::RealtimeDenied
        ) {
            on_error(open_failure(&e));
        }
    };
    let config = supported.config();
    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| deliver(&mut data.iter().copied()),
            on_error,
            None,
        ),
        cpal::SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                deliver(&mut data.iter().map(|s| *s as f32 / 32768.0))
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                deliver(&mut data.iter().map(|s| (*s as f32 - 32768.0) / 32768.0))
            },
            on_error,
            None,
        ),
        cpal::SampleFormat::I32 => device.build_input_stream(
            config,
            move |data: &[i32], _: &cpal::InputCallbackInfo| {
                deliver(&mut data.iter().map(|s| *s as f32 / 2_147_483_648.0))
            },
            on_error,
            None,
        ),
        other => {
            return Err(format!(
                "{} ({other:?})",
                tr("Formato audio del microfono non supportato", "Unsupported microphone audio format")
            ))
        }
    }
    .map_err(|e| open_failure(&e))?;
    stream.play().map_err(|e| open_failure(&e))?;
    Ok(Capture { _stream: stream })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(seconds: f32, amplitude: f32) -> Vec<f32> {
        (0..(RATE as f32 * seconds) as usize)
            .map(|i| amplitude * (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / RATE as f32).sin())
            .collect()
    }

    fn silence(seconds: f32) -> Vec<f32> {
        vec![0.0; (RATE as f32 * seconds) as usize]
    }

    fn run(audio: &[f32]) -> Vec<Vec<f32>> {
        let mut segmenter = Segmenter::default();
        let mut phrases = segmenter.push(audio);
        phrases.extend(segmenter.flush());
        phrases
    }

    #[test]
    fn resampling_48k_averages_groups_of_three() {
        let mut r = Resampler::new(48_000);
        let mut out = Vec::new();
        r.process(&[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0], &mut out);
        assert_eq!(out, vec![2.0, 5.0]);
        r.process(&[8.0, 9.0], &mut out);
        assert_eq!(out, vec![2.0, 5.0, 8.0]);
    }

    #[test]
    fn resampling_16k_is_a_passthrough() {
        let mut out = Vec::new();
        Resampler::new(16_000).process(&[0.1, 0.2], &mut out);
        assert_eq!(out, vec![0.1, 0.2]);
    }

    #[test]
    fn resampling_44k1_interpolates_to_the_right_length() {
        let input = tone(1.0, 0.5);
        let input: Vec<f32> = (0..44_100).map(|i| input[i * 16_000 / 44_100]).collect();
        let mut whole = Vec::new();
        Resampler::new(44_100).process(&input, &mut whole);
        assert!((whole.len() as i32 - 16_000).abs() <= 2, "{}", whole.len());
        // Chunked input gives the same samples as one block.
        let mut chunked = Vec::new();
        let mut r = Resampler::new(44_100);
        for c in input.chunks(441) {
            r.process(c, &mut chunked);
        }
        assert!((chunked.len() as i32 - whole.len() as i32).abs() <= 1);
        assert!(chunked.iter().zip(&whole).all(|(a, b)| (a - b).abs() < 1e-4));
    }

    #[test]
    fn a_tone_burst_between_silences_is_one_phrase_with_pre_roll() {
        let mut audio = silence(1.0);
        audio.extend(tone(1.0, 0.3));
        audio.extend(silence(2.0));
        let phrases = run(&audio);
        assert_eq!(phrases.len(), 1);
        let len = phrases[0].len();
        let burst = RATE as usize;
        let pre_roll = PRE_ROLL_FRAMES * FRAME;
        assert!(len >= burst + pre_roll, "{len}");
        // pre-roll + burst + the closing silence, not the whole 3 s tail
        assert!(len <= burst + pre_roll + (END_SILENCE_FRAMES + 2) * FRAME, "{len}");
        // the pre-roll is silence
        assert!(phrases[0][..pre_roll - FRAME].iter().all(|s| *s == 0.0));
    }

    #[test]
    fn long_speech_is_cut_at_the_cap_and_nothing_is_lost() {
        let audio = tone(45.0, 0.3);
        let phrases = run(&audio);
        assert!(phrases.len() >= 2);
        assert!(phrases.iter().all(|p| p.len() <= MAX_PHRASE_FRAMES * FRAME));
        let total: usize = phrases.iter().map(Vec::len).sum();
        assert_eq!(total, audio.len() / FRAME * FRAME);
    }

    #[test]
    fn long_speech_is_cut_at_its_quietest_moment() {
        // 26.5 s of speech with a soft dip (too short to be a pause) at 26 s.
        let mut audio = tone(26.0, 0.3);
        audio.extend(tone(0.06, 0.004));
        audio.extend(tone(10.0, 0.3));
        let phrases = run(&audio);
        assert!(phrases.len() >= 2);
        let first = phrases[0].len();
        let dip = 26 * RATE as usize;
        assert!(first >= dip && first <= dip + 4 * FRAME, "{first}");
    }

    #[test]
    fn past_the_soft_cap_a_short_pause_ends_the_phrase() {
        let mut audio = tone(21.0, 0.3);
        audio.extend(silence(0.3));
        audio.extend(tone(2.0, 0.3));
        let phrases = run(&audio);
        assert_eq!(phrases.len(), 2);
        assert!(phrases[0].len() < 22 * RATE as usize);
    }

    #[test]
    fn soft_syllables_keep_the_phrase_alive() {
        // A long stretch at RMS 0.0075: below the onset bar, above the bar inside a phrase.
        let mut audio = tone(1.0, 0.3);
        audio.extend(tone(1.5, 0.0075 * std::f32::consts::SQRT_2));
        audio.extend(tone(1.0, 0.3));
        audio.extend(silence(2.0));
        assert_eq!(run(&audio).len(), 1);
    }

    #[test]
    fn a_short_blip_is_dropped() {
        let mut audio = silence(1.0);
        audio.extend(tone(0.12, 0.3));
        audio.extend(silence(2.0));
        assert!(run(&audio).is_empty());
    }

    #[test]
    fn a_stop_flushes_the_phrase_being_spoken() {
        let mut audio = silence(0.5);
        audio.extend(tone(1.0, 0.3));
        let mut segmenter = Segmenter::default();
        assert!(segmenter.push(&audio).is_empty());
        assert!(segmenter.in_phrase());
        assert!(segmenter.flush().is_some_and(|p| p.len() >= RATE as usize));
    }

    #[test]
    fn the_phrase_in_progress_is_visible_once_it_has_enough_speech() {
        let mut segmenter = Segmenter::default();
        assert!(segmenter.current().is_none());
        segmenter.push(&tone(0.12, 0.3));
        assert!(segmenter.in_phrase());
        assert!(segmenter.current().is_none());
        segmenter.push(&tone(0.5, 0.3));
        assert!(segmenter.current().is_some_and(|p| p.len() >= RATE as usize / 2));
        segmenter.push(&silence(1.0));
        assert!(segmenter.current().is_none());
    }

    #[test]
    fn quiet_noise_is_not_speech() {
        assert!(run(&tone(5.0, 0.004)).is_empty());
    }
}
