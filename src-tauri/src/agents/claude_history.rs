//! Saved Claude Code sessions of a project, for the History panel. Claude
//! keeps one transcript per session at
//! `<claude dir>/projects/<encoded cwd>/<sessionId>.jsonl` (subfolders hold
//! sub-agent transcripts, ignored here). A transcript can run to tens of MB,
//! so only its first and last 256 KB are read, and the result is cached per
//! file until its mtime or size changes - the panel polls every few seconds.
//!
//! Best-effort like the other readers: a file that doesn't parse the way
//! expected is skipped, never surfaced as an error.

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use crate::util::lock;

/// How much of a transcript's head and tail is read.
const HEAD_CHUNK: u64 = 256 * 1024;
const TAIL_CHUNK: u64 = 256 * 1024;
/// Longest line parsed whole when looking for the first prompt.
const MAX_PROMPT_LINE: usize = 64 * 1024;
/// Longest fallback title (the first prompt), in characters.
const TITLE_CHARS: usize = 80;
const MAX_CLAUDE_SESSIONS: usize = 200;

#[derive(Serialize, Clone)]
pub struct ClaudeSessionEntry {
    cwd: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    /// The user's own title (/rename), else Claude's generated one, else the
    /// first prompt (trimmed to ~80 chars).
    title: Option<String>,
    /// First message's timestamp, ms since epoch.
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
    /// The transcript's last write (file mtime), ms since epoch.
    #[serde(rename = "updatedAt")]
    updated_at: Option<u64>,
    /// The account profile whose Claude folder holds it (`None`: the default
    /// one).
    profile: Option<String>,
}

/// What this app needs out of one transcript.
#[derive(Clone)]
struct Transcript {
    cwd: String,
    title: Option<String>,
    started_at: Option<u64>,
}

/// Claude's folder name for a working directory: every character that isn't
/// ASCII alphanumeric becomes `-`.
fn encode_cwd(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Separators unified, trailing ones dropped, case folded on Windows paths -
/// the comparison `same_dir` makes, kept as a string so it can prefix-match.
fn norm_path(p: &str) -> String {
    let p = p.trim_end_matches(['\\', '/']).replace('\\', "/");
    if cfg!(windows) && !p.starts_with('/') { p.to_lowercase() } else { p }
}

/// `cwd` is `root` or somewhere below it.
fn under_root(cwd: &str, root: &str) -> bool {
    let (cwd, root) = (norm_path(cwd), norm_path(root));
    !root.is_empty() && (cwd == root || cwd.strip_prefix(&root).is_some_and(|rest| rest.starts_with('/')))
}

/// RFC3339 (`2026-10-16T15:32:35.323Z`, or with a `+hh:mm` offset) to ms
/// since epoch. No date crate is a dependency, so the calendar maths is here.
fn parse_rfc3339_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = s.get(from..from + len)?;
        if part.bytes().all(|c| c.is_ascii_digit()) { part.parse().ok() } else { None }
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't' | b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hh, mm, ss) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) || hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let mut i = 19;
    let mut millis = 0i64;
    if b.get(i) == Some(&b'.') {
        let digits: String = s[i + 1..].chars().take_while(|c| c.is_ascii_digit()).collect();
        i += 1 + digits.len();
        millis = format!("{digits:0<3}").get(..3)?.parse().ok()?;
    }
    let offset_min = match b.get(i) {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(&sign @ (b'+' | b'-')) => {
            let total = num(i + 1, 2)? * 60 + num(i + 4, 2).unwrap_or(0);
            if sign == b'+' { total } else { -total }
        }
        _ => return None,
    };
    // Days since 1970-01-01 (Howard Hinnant's days-from-civil).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86_400 + hh * 3600 + mm * 60 + ss - offset_min * 60;
    u64::try_from(secs * 1000 + millis).ok()
}

/// A prompt as a one-line title: whitespace collapsed, cut to `TITLE_CHARS`.
fn clip_title(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > TITLE_CHARS {
        format!("{}…", flat.chars().take(TITLE_CHARS).collect::<String>().trim_end())
    } else {
        flat
    }
}

/// The text of a user line's message: a plain string, or the first text block.
fn prompt_text(value: &serde_json::Value) -> Option<&str> {
    match value.get("message")?.get("content")? {
        serde_json::Value::String(s) => Some(s),
        serde_json::Value::Array(blocks) => {
            let first = blocks.first()?;
            if first.get("type")?.as_str()? != "text" {
                return None;
            }
            first.get("text")?.as_str()
        }
        _ => None,
    }
}

/// The string value of the first `"key":"..."` in a JSON line, without
/// parsing the line: lines can run to megabytes (attachments carrying whole
/// system prompts) and a full parse of them dominated the scan. Only the
/// value's own slice is decoded.
fn json_str_field(line: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\":");
    let rest = line[line.find(&needle)? + needle.len()..].trim_start_matches(' ');
    let body = rest.strip_prefix('"')?;
    let mut escaped = false;
    for (i, c) in body.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' => escaped = true,
            '"' => return serde_json::from_str::<String>(&rest[..i + 2]).ok(),
            _ => {}
        }
    }
    None
}

/// Up to `size` bytes from `from`, cut to whole lines: the partial line at
/// the start (when `from > 0`) and, for the head, at the end are dropped.
fn read_lines(file: &mut std::fs::File, from: u64, size: u64, len: u64, is_head: bool) -> Option<String> {
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::new();
    file.take(size).read_to_end(&mut buf).ok()?;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if is_head && from + (buf.len() as u64) < len {
        text.truncate(text.rfind('\n').map_or(0, |i| i + 1));
    }
    if from > 0 {
        text = text.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default();
    }
    Some(text)
}

fn read_transcript(path: &Path, len: u64) -> Option<Transcript> {
    let mut file = std::fs::File::open(path).ok()?;
    let head = read_lines(&mut file, 0, HEAD_CHUNK, len, true)?;
    let (mut cwd, mut started_at, mut prompt) = (None, None, None);
    for line in head.lines() {
        if cwd.is_some() && started_at.is_some() && prompt.is_some() {
            break;
        }
        if cwd.is_none() {
            cwd = json_str_field(line, "cwd").filter(|s| !s.is_empty());
        }
        if started_at.is_none() {
            started_at = json_str_field(line, "timestamp").and_then(|t| parse_rfc3339_ms(&t));
        }
        // Only a modest line is parsed whole: a prompt is short, a line of
        // hundreds of KB is an attachment.
        if prompt.is_none()
            && line.len() < MAX_PROMPT_LINE
            && line.contains("\"type\":\"user\"")
            && !line.contains("\"isMeta\":true")
        {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else { continue };
            if value.get("type").and_then(|v| v.as_str()) == Some("user") {
                prompt = prompt_text(&value)
                    .filter(|t| !t.trim().is_empty() && !t.trim_start().starts_with('<'))
                    .map(clip_title);
            }
        }
    }
    let (cwd, prompt) = (cwd?, prompt?);

    let tail = if len > TAIL_CHUNK { read_lines(&mut file, len - TAIL_CHUNK, TAIL_CHUNK, len, false)? } else { head };
    let (mut custom, mut ai, mut summary) = (None, None, None);
    for line in tail.lines() {
        let (slot, key) = if line.contains("\"type\":\"custom-title\"") {
            (&mut custom, "customTitle")
        } else if line.contains("\"type\":\"ai-title\"") {
            (&mut ai, "aiTitle")
        } else if line.contains("\"type\":\"summary\"") {
            (&mut summary, "summary")
        } else {
            continue;
        };
        if let Some(t) = json_str_field(line, key).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
            *slot = Some(t);
        }
    }
    Some(Transcript { cwd, title: Some(custom.or(ai).or(summary).unwrap_or(prompt)), started_at })
}

/// A transcript parsed again only when its mtime or size changes.
fn cached_transcript(path: &Path, mtime: Option<u64>, len: u64) -> Option<Transcript> {
    type Cache = HashMap<PathBuf, (Option<u64>, u64, Option<Transcript>)>;
    static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);
    /// Past this many remembered files the cache is dropped and refilled.
    const MAX_CACHED: usize = 2048;

    if let Some((at, size, parsed)) = lock(&CACHE).get(path) {
        if *at == mtime && *size == len && mtime.is_some() {
            return parsed.clone();
        }
    }
    let parsed = read_transcript(path, len);
    let mut cache = lock(&CACHE);
    if cache.len() >= MAX_CACHED {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), (mtime, len, parsed.clone()));
    parsed
}

fn scan_project_sessions(
    claude_dir: &Path,
    roots: &[String],
    profile: Option<&str>,
    seen: &mut HashSet<PathBuf>,
) -> Vec<ClaudeSessionEntry> {
    let encoded: Vec<String> = roots.iter().map(|r| encode_cwd(r.trim_end_matches(['\\', '/']))).collect();
    let Ok(folders) = std::fs::read_dir(claude_dir.join("projects")) else { return Vec::new() };
    let mut out = Vec::new();
    for folder in folders.flatten() {
        let name = folder.file_name().to_string_lossy().into_owned();
        let candidate = encoded
            .iter()
            .any(|e| name == *e || name.strip_prefix(e.as_str()).is_some_and(|rest| rest.starts_with('-')));
        if !candidate {
            continue;
        }
        let Ok(files) = std::fs::read_dir(folder.path()) else { continue };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") || !seen.insert(path.clone()) {
                continue;
            }
            let Ok(meta) = file.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let updated_at = crate::fs::system_time_to_millis(meta.modified());
            let Some(t) = cached_transcript(&path, updated_at, meta.len()) else { continue };
            if !roots.iter().any(|r| under_root(&t.cwd, r)) {
                continue;
            }
            let Some(session_id) =
                path.file_stem().and_then(|s| s.to_str()).filter(|s| super::is_safe_session_id(s)).map(str::to_string)
            else {
                continue;
            };
            out.push(ClaudeSessionEntry {
                cwd: t.cwd,
                session_id,
                title: t.title,
                started_at: t.started_at,
                updated_at,
                profile: profile.map(str::to_string),
            });
        }
    }
    out
}

/// Saved Claude sessions whose working directory is one of `roots` or below
/// one (every profile's Claude folder), newest first. Async + blocking pool:
/// it opens files on every panel poll.
#[tauri::command]
pub async fn list_claude_sessions(app: tauri::AppHandle, roots: Vec<String>) -> Result<Vec<ClaudeSessionEntry>, String> {
    crate::blocking(move || {
        let mut seen = HashSet::new();
        let mut sessions: Vec<ClaudeSessionEntry> = crate::profiles::all_dirs(&app)
            .into_iter()
            .flat_map(|(profile, dirs)| scan_project_sessions(&dirs.claude, &roots, profile.as_deref(), &mut seen))
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at));
        sessions.truncate(MAX_CLAUDE_SESSIONS);
        Ok(sessions)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_cwd() {
        assert_eq!(encode_cwd(r"C:\Users\massi\Documents\Progetti\flowcode"), "C--Users-massi-Documents-Progetti-flowcode");
        assert_eq!(encode_cwd("/home/a.b/c d"), "-home-a-b-c-d");
    }

    #[test]
    fn cwd_under_root() {
        assert!(under_root(r"C:\a\b", r"C:\a\b\"));
        assert!(under_root("C:/a/b/sub/deep", r"C:\a\b"));
        assert!(!under_root(r"C:\a\bc", r"C:\a\b"));
        assert!(!under_root(r"C:\a", r"C:\a\b"));
        assert!(!under_root(r"C:\a", ""));
        if cfg!(windows) {
            assert!(under_root(r"c:\A\B\x", r"C:\a\b"));
        }
    }

    #[test]
    fn parses_rfc3339() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2026-10-16T15:32:35.323Z"), Some(1_792_164_755_323));
        assert_eq!(parse_rfc3339_ms("2026-10-16T17:32:35.323+02:00"), Some(1_792_164_755_323));
        assert_eq!(parse_rfc3339_ms("2024-02-29T00:00:00Z"), Some(1_709_164_800_000));
        assert_eq!(parse_rfc3339_ms("nope"), None);
    }

    #[test]
    fn reads_json_string_field() {
        assert_eq!(json_str_field(r#"{"a":1,"cwd":"C:\\x\"y"}"#, "cwd").as_deref(), Some(r#"C:\x"y"#));
        assert_eq!(json_str_field(r#"{"cwd": "caf\u00e9"}"#, "cwd").as_deref(), Some("café"));
        assert_eq!(json_str_field(r#"{"cwd":"a\\","b":"c"}"#, "cwd").as_deref(), Some(r"a\"));
        assert_eq!(json_str_field(r#"{"cwd":"a"}"#, "title"), None);
        assert_eq!(json_str_field(r#"{"cwd":3}"#, "cwd"), None);
        assert_eq!(json_str_field(r#"{"cwd":"unterminated"#, "cwd"), None);
    }

    #[test]
    fn clips_titles() {
        assert_eq!(clip_title("  a \n b  "), "a b");
        assert_eq!(clip_title(&"x".repeat(100)).chars().count(), TITLE_CHARS + 1);
    }
}
