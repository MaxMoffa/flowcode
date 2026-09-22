use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use flowcode_shared::run_command_blocking;
#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

use crate::pty::PtyState;

/// Pids of this app's own throwaway `claude -p "/usage"` probes (see
/// `run_claude_usage_probe`), live only for the second or two the probe
/// itself is running. `list_claude_agents` excludes them - Claude Code's own
/// registry has no notion of "interactive session" vs. "one-shot -p query",
/// so without this a usage-popover poll would flash a phantom "agent"
/// session into the sidebar for as long as the probe takes to answer.
#[derive(Default)]
pub struct ProbePids(Mutex<HashSet<u32>>);

/// Binary names this recognizes as "an AI coding agent" - matched against a
/// descendant process's own name, not the shell's, so a plain shell with no
/// agent running in it just doesn't show up. Only what's honestly knowable
/// from the outside: which CLI is running, where, since when - no notion of
/// "orchestrator vs sub-agent" (that's internal to the CLI itself and isn't
/// exposed by any process-tree signal).
const AGENT_BINARIES: &[(&str, &str)] = &[("claude", "Claude Code"), ("codex", "Codex CLI")];

#[derive(Serialize, Clone)]
pub struct AgentSession {
    /// The app's own pty session id - lets the frontend match this back to
    /// whichever terminal tab owns that pty.
    pty_id: String,
    /// Short id of the matched binary (`"claude"` / `"codex"`), for icon/theming.
    cli: String,
    cli_label: String,
    pid: u32,
    /// Unix milliseconds, when the OS exposes a start time - the frontend
    /// uses this to show how long the agent has been running.
    started_at: Option<u64>,
}

/// BFS over descendants of `root_pid` (a pty's own shell), returning the
/// first process whose name matches a known agent CLI binary - a plain
/// prefix/equality check on the process name, not a guess at what it's
/// doing, so an unrelated process that happens to also be named "claude"
/// would still show up; that's an acceptable false positive for a dev tool
/// like this one.
fn find_agent(
    sys: &System,
    root_pid: Pid,
    children_of: &HashMap<Pid, Vec<Pid>>,
) -> Option<(&'static str, &'static str, u32, Option<u64>)> {
    let mut queue: VecDeque<Pid> = VecDeque::new();
    queue.push_back(root_pid);
    let mut visited: HashSet<Pid> = HashSet::new();

    while let Some(pid) = queue.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        if pid != root_pid {
            if let Some(process) = sys.process(pid) {
                let name = process.name().to_string_lossy().to_lowercase();
                if let Some(&(bin, label)) = AGENT_BINARIES
                    .iter()
                    .find(|(bin, _)| name == *bin || name.starts_with(&format!("{bin}-")))
                {
                    let started_at = process.start_time().checked_mul(1000);
                    return Some((bin, label, pid.as_u32(), started_at));
                }
            }
        }
        if let Some(children) = children_of.get(&pid) {
            for &child in children {
                queue.push_back(child);
            }
        }
    }
    None
}

/// One entry per terminal tab that currently has a recognized agent CLI
/// running somewhere in its shell's process tree (the agent itself, or any
/// of its own descendants aren't included - just the first match closest to
/// the shell, since that's the process the tab is actually "running").
#[tauri::command]
pub fn list_agent_sessions(pty_state: State<'_, PtyState>) -> Vec<AgentSession> {
    let shell_pids = pty_state.shell_pids();
    if shell_pids.is_empty() {
        return Vec::new();
    }

    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let mut children_of: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            children_of.entry(parent).or_default().push(*pid);
        }
    }

    shell_pids
        .into_iter()
        .filter_map(|(pty_id, shell_pid)| {
            find_agent(&sys, Pid::from_u32(shell_pid), &children_of).map(|(cli, cli_label, pid, started_at)| AgentSession {
                pty_id,
                cli: cli.to_string(),
                cli_label: cli_label.to_string(),
                pid,
                started_at,
            })
        })
        .collect()
}

/// One entry from `claude agents --json` - Claude Code's own registry of
/// every session it knows about on this machine, including ones this app
/// never spawned (another terminal window, a background/headless run, ...).
/// Far richer than the process-tree guess above, but Claude-specific: no
/// equivalent exists for Codex, so this supplements `list_agent_sessions`
/// rather than replacing it - the frontend correlates the two by `pid`.
#[derive(Deserialize, Serialize, Clone)]
pub struct ClaudeAgentEntry {
    pid: u32,
    cwd: String,
    kind: String,
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
    #[serde(rename = "sessionId")]
    session_id: String,
    name: String,
    status: String,
}

#[tauri::command]
pub async fn list_claude_agents(probe_pids: State<'_, ProbePids>) -> Result<Vec<ClaudeAgentEntry>, String> {
    let output = tauri::async_runtime::spawn_blocking(|| run_command_blocking("claude agents --json"))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    if !output.status.success() {
        // Not installed, not on PATH, or an old version without this
        // subcommand - all read the same to the frontend: no data, not an
        // error to surface (the usage popover already has its own separate
        // "not installed"/"not logged in" messaging for Claude).
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<ClaudeAgentEntry> = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    let excluded = probe_pids.0.lock().unwrap();
    Ok(entries.into_iter().filter(|e| !excluded.contains(&e.pid)).collect())
}

/// Runs `claude -p "/usage"` for the usage popover (see src/plugins/usage.ts)
/// - a plain-text, client-side-only query, no model call. Spawned directly
/// (no shell) rather than through `run_command_blocking`: that both sidesteps
/// the cmd.exe re-quoting hazard documented on `cli_is_logged_in` and, more
/// importantly, hands back the *actual* `claude` pid - the one `claude agents
/// --json` will report - so it can be tracked in `ProbePids` and filtered out
/// of `list_claude_agents` for the short time it's alive.
#[tauri::command]
pub async fn run_claude_usage_probe(probe_pids: State<'_, ProbePids>) -> Result<String, String> {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("claude");
    cmd.arg("-p")
        .arg("/usage")
        .stdin(std::process::Stdio::null())
        // `wait_with_output` below only captures stdout/stderr that were
        // actually piped - left as the default `Stdio::inherit()`, this
        // process's output goes to the app's own (invisible) console and
        // `Output.stdout` comes back empty every time, which is exactly what
        // broke the usage popover: the probe "succeeded" with zero output.
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    // `claude` resolves to a .cmd shim, which Rust runs via a hidden
    // cmd.exe - without this it flashes a console window open/closed on
    // every poll (this probe fires on a multi-second interval).
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = cmd.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    probe_pids.0.lock().unwrap().insert(pid);

    let result = tauri::async_runtime::spawn_blocking(move || child.wait_with_output()).await;

    probe_pids.0.lock().unwrap().remove(&pid);

    let output = result.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// One saved Codex CLI session, read directly off disk. Codex CLI has no
/// `claude agents --json` equivalent - no daemon, no registry of which
/// sessions are currently alive - only a transcript per session under
/// `~/.codex/sessions`. So this can only ever offer "sessions that exist to
/// resume", not "sessions currently running elsewhere" (`list_agent_sessions`
/// above already covers the one case that's actually knowable: a codex
/// process running inside one of this app's own tabs).
///
/// The on-disk layout is undocumented and has shifted across Codex versions
/// (flat vs. nested by year/month/day) - everything here is best-effort:
/// any file, or any single record inside a file, that doesn't parse the way
/// expected is just skipped rather than surfaced as an error, exactly like
/// `list_claude_agents`'s own "not installed / old version" fallback above.
#[derive(Serialize, Clone)]
pub struct CodexSessionEntry {
    cwd: String,
    #[serde(rename = "sessionId")]
    session_id: String,
    /// The rollout file's own mtime - not a field read out of its content,
    /// which would need trusting a timestamp format that isn't documented
    /// either. Good enough for "how long ago" sorting/display.
    #[serde(rename = "startedAt")]
    started_at: Option<u64>,
}

fn codex_sessions_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))?;
    Some(home.join(".codex").join("sessions"))
}

/// Recursively collects `rollout-*.jsonl` files under `dir` - bounded depth
/// rather than a hardcoded year/month/day nesting, so it survives either
/// layout. Archived sessions (`.jsonl.zst`, zstd-compressed) are skipped:
/// there's no decompression dependency here, and archived history isn't
/// worth pulling into a live sidebar anyway.
fn find_rollout_files(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_dir() {
            find_rollout_files(&path, depth - 1, out);
        } else if path
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.starts_with("rollout-") && n.ends_with(".jsonl"))
        {
            out.push(path);
        }
    }
}

/// Depth-first search through a parsed JSON value for the first string
/// found under a key named `key`, anywhere in the tree - the rollout
/// envelope's exact nesting isn't documented, so this doesn't assume one.
fn find_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(serde_json::Value::String(s)) = map.get(key) {
                return Some(s.clone());
            }
            map.values().find_map(|v| find_string_field(v, key))
        }
        serde_json::Value::Array(items) => items.iter().find_map(|v| find_string_field(v, key)),
        _ => None,
    }
}

/// The uuid embedded in a rollout filename itself
/// (`rollout-2025-10-07T12-34-56-<uuid>.jsonl`) - the fallback session id
/// when the content's own id field isn't where expected, since `codex
/// resume` accepts this same id either way.
fn uuid_from_filename(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    let parts: Vec<&str> = stem.split('-').collect();
    (0..parts.len())
        .map(|start| parts[start..].join("-"))
        .find(|candidate| uuid::Uuid::parse_str(candidate).is_ok())
}

/// Reads just enough of a rollout file (its first handful of lines) to
/// recover the session's cwd and id - never the whole transcript, which can
/// be an arbitrarily long conversation.
fn read_codex_session(path: &Path) -> Option<CodexSessionEntry> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    for line in reader.lines().take(20).filter_map(|l| l.ok()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if cwd.is_none() {
            cwd = find_string_field(&value, "cwd");
        }
        if session_id.is_none() {
            session_id = find_string_field(&value, "session_id").or_else(|| find_string_field(&value, "id"));
        }
        if cwd.is_some() && session_id.is_some() {
            break;
        }
    }
    let cwd = cwd?;
    let session_id = session_id.or_else(|| uuid_from_filename(path))?;
    let started_at = std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Some(CodexSessionEntry {
        cwd,
        session_id,
        started_at,
    })
}

#[tauri::command]
pub fn list_codex_sessions() -> Vec<CodexSessionEntry> {
    let Some(root) = codex_sessions_root() else {
        return Vec::new();
    };
    let mut files = Vec::new();
    find_rollout_files(&root, 5, &mut files);

    let mut sessions: Vec<CodexSessionEntry> = files.iter().filter_map(|p| read_codex_session(p)).collect();
    // Most recent first, capped - a project with years of history shouldn't
    // dump its entire archive into the sidebar, just what's plausibly worth
    // resuming.
    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    sessions.truncate(8);
    sessions
}
