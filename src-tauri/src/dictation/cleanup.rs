//! Optional post-processing of a dictated phrase: one headless call to an
//! agent CLI (`claude -p` / `codex exec`) that fixes speech-to-text slips. The
//! frontend opts in and falls back to the raw text on any `Err`.

use crate::agents::ProbePids;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::Manager;

const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TEXT: usize = 4000;
const MAX_VOCAB: usize = 300;
const MAX_MODEL: usize = 64;

const PROMPT: &str = "Correct speech-to-text errors in the dictated text below: wrong or split words, homophones, misspelled technical terms/identifiers/file names/English words inside Italian text, punctuation and capitalization. Keep the language, meaning and wording; do not add, remove, summarize, translate or answer anything. Terms that may appear: {vocabulary}. Reply with the corrected text only, nothing else.\n\nText:\n{text}";

fn truncate_chars(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn build_prompt(text: &str, vocabulary: Option<&str>) -> String {
    let vocab = truncate_chars(vocabulary.unwrap_or(""), MAX_VOCAB);
    let vocab = if vocab.is_empty() { "none".to_string() } else { vocab };
    PROMPT.replace("{text}", &truncate_chars(text, MAX_TEXT)).replace("{vocabulary}", &vocab)
}

/// The model ends up in argv: only a conservative character set is allowed.
fn sanitize_model(model: Option<&str>) -> Result<Option<String>, String> {
    let Some(m) = model.map(str::trim).filter(|m| !m.is_empty()) else { return Ok(None) };
    let ok = m.len() <= MAX_MODEL
        && !m.starts_with('-')
        && m.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '-' | '[' | ']'));
    if ok {
        Ok(Some(m.to_string()))
    } else {
        Err("invalid model".to_string())
    }
}

/// Trims, strips surrounding code fences / quotes, rejects suspicious output.
fn postprocess(raw: &str, input: &str) -> Result<String, String> {
    let mut s = raw.trim();
    if let Some(rest) = s.strip_prefix("```") {
        // Drop the fence line (it may carry a language tag) and the closing fence.
        let rest = rest.split_once('\n').map_or("", |(_, r)| r).trim_end();
        s = rest.strip_suffix("```").unwrap_or(rest).trim();
    }
    for (a, b) in [('"', '"'), ('\'', '\''), ('“', '”'), ('«', '»')] {
        if s.chars().count() >= 2 && s.starts_with(a) && s.ends_with(b) {
            s = s[a.len_utf8()..s.len() - b.len_utf8()].trim();
            break;
        }
    }
    if s.is_empty() || s.chars().count() > input.chars().count() * 3 + 200 {
        return Err("suspicious cleanup response".to_string());
    }
    Ok(s.to_string())
}

fn run(agent: &str, model: Option<String>, prompt: String, probe_pids: &ProbePids) -> Result<String, String> {
    let (bin, out_file) = match agent {
        "claude" => ("claude", None),
        "codex" => {
            let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
            ("codex", Some(std::env::temp_dir().join(format!("flowcode-cleanup-{}-{nanos}.txt", std::process::id()))))
        }
        _ => return Err("unknown agent".to_string()),
    };
    // On Windows codex is an npm `.cmd` shim, which Command only finds when named.
    let program = if cfg!(windows) && bin == "codex" { "codex.cmd" } else { bin };
    let mut cmd = Command::new(program);
    if let Some(file) = &out_file {
        cmd.args(["exec", "--skip-git-repo-check", "-s", "read-only", "--ephemeral", "-o"]).arg(file);
        if let Some(m) = &model {
            cmd.arg("-m").arg(m);
        }
        // Neutral cwd; "-" = prompt from stdin.
        cmd.current_dir(std::env::temp_dir()).arg("-");
    } else {
        cmd.args(["-p", "--tools", "", "--no-session-persistence", "--output-format", "text"]);
        if let Some(m) = &model {
            cmd.arg("--model").arg(m);
        }
    }
    cmd.env("DISABLE_AUTOUPDATER", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("{bin} not found on PATH (WSL-only installs are not supported for dictation cleanup)")
        } else {
            e.to_string()
        }
    })?;
    let pid = child.id();
    probe_pids.track(pid);
    if let Some(mut stdin) = child.stdin.take() {
        // A write error (child died early) surfaces through its exit status.
        let _ = stdin.write_all(prompt.as_bytes());
    }
    let result = flowcode_shared::wait_with_timeout(child, TIMEOUT);
    probe_pids.untrack(pid);

    let last_message = out_file.as_ref().map(|f| {
        let r = std::fs::read_to_string(f);
        let _ = std::fs::remove_file(f);
        r
    });
    let output = result.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("{bin}: {}\n{}", output.status, flowcode_shared::combined_output(&output)).trim().to_string());
    }
    match last_message {
        Some(r) => r.map_err(|e| e.to_string()),
        None => Ok(String::from_utf8_lossy(&output.stdout).into_owned()),
    }
}

#[tauri::command]
pub async fn dictation_cleanup(
    app: tauri::AppHandle,
    agent: String,
    model: Option<String>,
    text: String,
    vocabulary: Option<String>,
) -> Result<String, String> {
    let model = sanitize_model(model.as_deref())?;
    if text.trim().is_empty() {
        return Err("empty text".to_string());
    }
    let input = truncate_chars(&text, MAX_TEXT);
    let prompt = build_prompt(&text, vocabulary.as_deref());
    let raw = tauri::async_runtime::spawn_blocking(move || run(&agent, model, prompt, &app.state::<ProbePids>()))
        .await
        .map_err(|e| e.to_string())??;
    postprocess(&raw, &input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_validation() {
        assert_eq!(sanitize_model(None), Ok(None));
        assert_eq!(sanitize_model(Some("  ")), Ok(None));
        assert_eq!(sanitize_model(Some("claude-opus-4.1[1m]")), Ok(Some("claude-opus-4.1[1m]".into())));
        assert!(sanitize_model(Some("a b")).is_err());
        assert!(sanitize_model(Some("a;rm")).is_err());
        assert!(sanitize_model(Some("--x")).is_err());
        assert!(sanitize_model(Some(&"a".repeat(65))).is_err());
    }

    #[test]
    fn postprocess_cases() {
        assert_eq!(postprocess("  ciao mondo \n", "ciao mondo").unwrap(), "ciao mondo");
        assert_eq!(postprocess("```\nciao mondo\n```", "ciao mondo").unwrap(), "ciao mondo");
        assert_eq!(postprocess("```text\nciao\n```", "ciao").unwrap(), "ciao");
        assert_eq!(postprocess("\"ciao mondo\"", "ciao mondo").unwrap(), "ciao mondo");
        assert!(postprocess("  ", "x").is_err());
        assert!(postprocess(&"a".repeat(300), "ab").is_err());
    }

    #[test]
    fn prompt_building() {
        let p = build_prompt("ciao", Some("Tauri, Rust"));
        assert!(p.contains("Terms that may appear: Tauri, Rust."));
        assert!(p.ends_with("Text:\nciao"));
        assert!(build_prompt("x", None).contains("appear: none."));
        assert!(build_prompt(&"a".repeat(5000), None).ends_with(&"a".repeat(4000)));
        assert!(!build_prompt("x", Some(&"v".repeat(500))).contains(&"v".repeat(301)));
    }
}
