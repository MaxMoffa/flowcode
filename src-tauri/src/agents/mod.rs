use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use sysinfo::{Pid, System};
use tauri::{Manager, State};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
use flowcode_shared::CREATE_NO_WINDOW;

use flowcode_shared::i18n::tr;

use crate::pty::PtyState;
use crate::util::{has_bytes, insert_bounded, lock, now_ms, same_dir, wsl_unc};
use crate::windows::WindowTabs;

mod claude;
pub use self::claude::*;
mod codex;
pub use self::codex::*;
pub(crate) use self::codex::find_codex_rollout;
use self::codex::{host_live_threads, rollout_meta, rollout_turn_open, thread_names_in};
mod wsl;
use self::wsl::{find_wsl_client, wsl_agents, wsl_codex_sessions_root, wsl_live_threads, WSL_SCAN_TTL};

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
/// Mistral Vibe's `vibe` is a Python console script: on Windows a `vibe.exe`
/// launcher (uv/pip) starting Python, elsewhere a script whose process takes
/// its name - and `vibe-rs` when it runs its Rust TUI.
const AGENT_BINARIES: &[(&str, &str)] =
    &[("claude", "Claude Code"), ("codex", "Codex CLI"), ("vibe", "Mistral Vibe")];

/// Matches a process name against `AGENT_BINARIES` - the binary itself or a
/// `<bin>-...` variant of it, except for Vibe's editor/desktop servers
/// (`vibe-acp`, `vibe-app-server`), which aren't a session in a terminal.
fn agent_binary(name: &str) -> Option<(&'static str, &'static str)> {
    if name.starts_with("vibe-acp") || name.starts_with("vibe-app") {
        return None;
    }
    AGENT_BINARIES
        .iter()
        .find(|(bin, _)| name.strip_prefix(bin).is_some_and(|rest| rest.is_empty() || rest.starts_with('-')))
        .copied()
}

#[derive(Serialize, Clone, Default)]
pub struct AgentSession {
    /// The app's own pty session id - lets the frontend match this back to
    /// whichever terminal tab owns that pty.
    pub(crate) pty_id: String,
    /// Short id of the matched binary (`"claude"` / `"codex"` / `"vibe"`), for icon/theming.
    pub(crate) cli: String,
    cli_label: String,
    pid: u32,
    /// Unix milliseconds, when the OS exposes a start time - the frontend
    /// uses this to show how long the agent has been running.
    started_at: Option<u64>,
    /// Set when the agent runs inside WSL: the distro, and the agent's own
    /// (Linux) working directory - `pid` is then a Linux pid.
    wsl_distro: Option<String>,
    cwd: Option<String>,
    /// The window and tab showing this session, as that window last reported
    /// them (see windows.rs's `window_report_tabs`) - any window's Agents
    /// panel can list, and jump to, an agent in another window.
    window: Option<String>,
    tab_id: Option<String>,
    tab_label: Option<String>,
    tab_cwd: Option<String>,
    /// The agent's own session, when it can be read (Claude Code's registry
    /// entry - see `claude_registry_entry` - a Codex live thread, or the Vibe
    /// session last written in its folder - see `vibe::live_session_in`): its id,
    /// its name (the title the CLI gave it, or the one the user renamed it
    /// to) and "busy"/"idle" - plus "waiting" (on the user) for Claude Code.
    pub(crate) session_id: Option<String>,
    session_name: Option<String>,
    pub(crate) status: Option<String>,
    /// The account profile the tab runs under (`None`: the default one, and
    /// always for agents inside WSL).
    pub(crate) profile: Option<String>,
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
    // Another Flowcode instance (say `tauri dev` of this very app) is its own
    // world: the `claude` probes and sessions it spawns aren't this tab's agent.
    static OWN_NAME: LazyLock<Option<String>> = LazyLock::new(|| {
        std::env::current_exe().ok().and_then(|p| p.file_stem().map(|s| s.to_string_lossy().to_lowercase()))
    });
    let own_name = OWN_NAME.as_deref();

    while let Some(pid) = queue.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        if pid != root_pid {
            if let Some(process) = sys.process(pid) {
                // `Process::name()` on Windows is the raw NT image name and
                // keeps its `.exe` suffix (sysinfo never strips it, on any
                // version) - comparing the bare name against "claude"/"codex"
                // silently never matches there, so this strips any extension
                // via `file_stem` first, which is a no-op on Unix where the
                // name never had one.
                let raw_name = process.name().to_string_lossy().to_lowercase();
                let name = Path::new(&raw_name)
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or(raw_name);
                if let Some((bin, label)) = agent_binary(&name) {
                    let started_at = process.start_time().checked_mul(1000);
                    return Some((bin, label, pid.as_u32(), started_at));
                }
                if own_name == Some(name.as_str()) {
                    continue;
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
///
/// Async: a full process-table refresh takes tens of milliseconds (more on
/// Windows) and this is polled every few seconds - on the UI thread that
/// shows up as periodic stutter.
#[tauri::command]
pub async fn list_agent_sessions(app: tauri::AppHandle) -> Result<Vec<AgentSession>, String> {
    collect_agent_sessions(&app).await
}

/// The body of `list_agent_sessions`, also used by the remote-access server
/// (remote.rs) to tell a phone which tab runs which agent.
pub(crate) async fn collect_agent_sessions(app: &tauri::AppHandle) -> Result<Vec<AgentSession>, String> {
    let pty_state = app.state::<PtyState>();
    let window_tabs = app.state::<WindowTabs>();
    let shell_pids = pty_state.shell_pids();
    if shell_pids.is_empty() {
        return Ok(Vec::new());
    }
    let tabs = window_tabs.by_pty();
    let profiles: HashMap<String, Option<String>> = shell_pids
        .iter()
        .map(|(pty_id, _)| (pty_id.clone(), crate::pty::profile_of(&pty_state, pty_id)))
        .collect();
    let homes = ProfileHomes::of(app);
    let mut sessions = crate::blocking(move || Ok(find_agent_sessions(shell_pids, &homes, &profiles))).await?;
    for session in &mut sessions {
        if let Some((window, tab)) = tabs.get(&session.pty_id) {
            session.window = Some(window.clone());
            session.tab_id = Some(tab.tab_id.clone());
            session.tab_label = Some(tab.label.clone());
            session.tab_cwd = Some(tab.cwd.clone());
        }
    }
    Ok(sessions)
}

/// The three CLI folders of every account profile, default first - what the
/// readers below look through so a session of any profile is found.
struct ProfileHomes {
    /// (profile, Claude config dir)
    claude: Vec<(Option<String>, PathBuf)>,
    codex: Vec<(Option<String>, PathBuf)>,
    vibe: Vec<(Option<String>, PathBuf)>,
}

impl ProfileHomes {
    fn of(app: &tauri::AppHandle) -> Self {
        let mut homes = ProfileHomes { claude: Vec::new(), codex: Vec::new(), vibe: Vec::new() };
        for (profile, dirs) in crate::profiles::all_dirs(app) {
            homes.claude.push((profile.clone(), dirs.claude));
            homes.codex.push((profile.clone(), dirs.codex));
            homes.vibe.push((profile, dirs.vibe));
        }
        homes
    }

    fn vibe_of(&self, profile: &Option<String>) -> Option<&Path> {
        self.vibe.iter().find(|(p, _)| p == profile).map(|(_, h)| h.as_path())
    }
}

fn find_agent_sessions(
    shell_pids: Vec<(String, u32)>,
    homes: &ProfileHomes,
    profiles: &HashMap<String, Option<String>>,
) -> Vec<AgentSession> {
    // Distro -> the tabs whose agent (if any) can only be found inside it.
    let mut wsl_tabs: HashMap<Option<String>, HashSet<String>> = HashMap::new();
    let mut sessions = crate::system::with_processes(|sys| {
        let mut children_of: HashMap<Pid, Vec<Pid>> = HashMap::new();
        for (pid, process) in sys.processes() {
            if let Some(parent) = process.parent() {
                children_of.entry(parent).or_default().push(*pid);
            }
        }

        let mut sessions = Vec::new();
        let mut host_threads: Option<Vec<LiveThread>> = None;
        for (pty_id, shell_pid) in shell_pids {
            let root = Pid::from_u32(shell_pid);
            if let Some((cli, cli_label, pid, started_at)) = find_agent(sys, root, &children_of) {
                let cwd = sys
                    .process(Pid::from_u32(pid))
                    .and_then(|p| p.cwd())
                    .map(|c| c.to_string_lossy().trim_end_matches(['\\', '/']).to_string());
                let profile = profiles.get(&pty_id).cloned().flatten();
                let mut session = AgentSession {
                    pty_id,
                    cli: cli.to_string(),
                    cli_label: cli_label.to_string(),
                    pid,
                    started_at,
                    cwd: cwd.clone(),
                    profile: profile.clone(),
                    ..AgentSession::default()
                };
                if cli == "codex" {
                    let threads = host_threads.get_or_insert_with(|| host_live_threads(&homes.codex));
                    // The tab's own profile first: two profiles can have a
                    // thread open in the same folder.
                    let found = cwd.as_deref().and_then(|c| {
                        let mine: Vec<LiveThread> = threads.iter().filter(|t| t.profile == profile).cloned().collect();
                        thread_in(&mine, c).cloned().or_else(|| thread_in(threads, c).cloned())
                    });
                    if let Some(thread) = found {
                        session.apply_thread(&thread);
                    }
                } else if cli == "vibe" {
                    let found = homes.vibe_of(&profile).and_then(|home| {
                        cwd.as_deref().and_then(|c| crate::vibe::live_session_in(home, c, started_at))
                    });
                    if let Some(found) = found {
                        session.apply_vibe_session(found);
                    }
                } else if let Some(entry) = claude_registry_entry(pid, &homes.claude) {
                    session.apply_claude_entry(&entry);
                }
                sessions.push(session);
            } else if let Some(distro) = find_wsl_client(sys, root, &children_of) {
                wsl_tabs.entry(distro).or_default().insert(pty_id);
            }
        }
        sessions
    });
    // Outside the process table's lock: this runs `wsl.exe`.
    for (distro, pty_ids) in wsl_tabs {
        sessions.extend(wsl_agents(distro.as_deref(), &pty_ids));
    }
    sessions
}

impl AgentSession {
    /// Id, name and "busy"/"waiting"/"idle" from a Claude Code registry
    /// entry (see `claude_registry_entry`).
    fn apply_claude_entry(&mut self, entry: &serde_json::Value) {
        let text = |key: &str| entry.get(key).and_then(|v| v.as_str()).map(str::to_string);
        self.session_id = text("sessionId");
        self.session_name = text("name");
        self.status = text("status");
    }

    fn apply_vibe_session(&mut self, (id, name, status): (String, Option<String>, &'static str)) {
        self.session_id = Some(id);
        self.session_name = name;
        self.status = Some(status.to_string());
    }

    fn apply_thread(&mut self, thread: &LiveThread) {
        self.session_id = Some(thread.id.clone());
        self.session_name = thread.name.clone();
        self.status = Some(thread.status().to_string());
    }
}

/// A Codex thread open right now - somewhere: a tab of this window, of
/// another Flowcode, or any other terminal.
#[derive(Clone)]
struct LiveThread {
    id: String,
    cwd: String,
    name: Option<String>,
    /// When its rollout was last written (ms).
    updated_at: Option<u64>,
    /// Whether a turn is under way, from the rollout's own events (see
    /// `rollout_turn_open`) - `None` when they couldn't be read.
    turn_open: Option<bool>,
    wsl_distro: Option<String>,
    /// The Flowcode tab running it, when that tab says so (see `PTY_ID_ENV`).
    pty_id: Option<String>,
    /// The account profile whose Codex home holds it (`None`: default / WSL).
    profile: Option<String>,
}

/// How recently a thread must have written its rollout to count as working,
/// when its turn events can't be read.
const BUSY_WINDOW_MS: u64 = 8_000;

impl LiveThread {
    fn status(&self) -> &'static str {
        if let Some(open) = self.turn_open {
            return if open { "busy" } else { "idle" };
        }
        let now = now_ms();
        match self.updated_at {
            Some(at) if now.saturating_sub(at) < BUSY_WINDOW_MS => "busy",
            _ => "idle",
        }
    }
}

/// Walks a JSONL file's lines from the end, `visit` returning the first
/// `Some` to stop. Reads `chunk` bytes at a time and gives up after
/// `max_scan` bytes, since a transcript can be huge and what's wanted is
/// almost always near the end.
pub(crate) fn scan_lines_backwards<T>(
    path: &Path,
    chunk: u64,
    max_scan: u64,
    mut visit: impl FnMut(&[u8]) -> Option<T>,
) -> Option<T> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut end = len;
    // Bytes of the line cut off at the start of the previous chunk.
    let mut carry: Vec<u8> = Vec::new();
    while end > 0 && len - end < max_scan {
        let start = end.saturating_sub(chunk);
        let mut buf = vec![0u8; (end - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut buf).ok()?;
        buf.extend_from_slice(&carry);
        // Unless this chunk starts the file, its first line may be partial.
        let (head, lines) = match buf.iter().position(|&b| b == b'\n') {
            _ if start == 0 => (Vec::new(), &buf[..]),
            Some(i) => (buf[..i].to_vec(), &buf[i + 1..]),
            None => (buf.clone(), &buf[..0]),
        };
        for line in lines.split(|&b| b == b'\n').rev() {
            if let Some(found) = visit(line) {
                return Some(found);
            }
        }
        carry = head;
        end = start;
    }
    None
}

/// The live thread working in `cwd` - the most recently active one, if a
/// folder has several.
fn thread_in<'a>(threads: &'a [LiveThread], cwd: &str) -> Option<&'a LiveThread> {
    threads.iter().filter(|t| same_dir(&t.cwd, cwd)).max_by_key(|t| t.updated_at)
}

/// Which agent CLI a Linux process is: by its own name, or - for a Node
/// wrapper (`node .../codex.js`, `node .../claude/cli.js`) or Python
/// (`python .../bin/vibe`) - by the script it runs.
fn agent_of(comm: &str, argv: &str) -> Option<(&'static str, &'static str)> {
    if let Some(found) = agent_binary(comm) {
        return Some(found);
    }
    let script = argv.split_whitespace().nth(1)?.to_lowercase();
    script.split('/').find_map(|part| agent_binary(part.trim_end_matches(".js").trim_end_matches(".py")))
}

#[cfg(test)]
mod tests {
    use super::{agent_of, rollout_turn_open};
    use super::codex::read_codex_session;

    #[test]
    fn recognizes_agents_inside_wsl() {
        assert_eq!(agent_of("codex", "codex resume x").map(|a| a.0), Some("codex"));
        assert_eq!(agent_of("claude", "claude").map(|a| a.0), Some("claude"));
        assert_eq!(
            agent_of("node", "node /usr/lib/node_modules/@openai/codex/bin/codex.js").map(|a| a.0),
            Some("codex")
        );
        assert_eq!(
            agent_of("node", "node /home/u/.npm/node_modules/@anthropic-ai/claude-code/cli.js").map(|a| a.0),
            Some("claude")
        );
        assert_eq!(agent_of("vibe", "/home/u/.local/share/uv/tools/mistral-vibe/bin/python /home/u/.local/bin/vibe").map(|a| a.0), Some("vibe"));
        assert_eq!(agent_of("python3", "python3 /home/u/.local/bin/vibe --resume x").map(|a| a.0), Some("vibe"));
        assert_eq!(agent_of("vibe-rs", "vibe-rs").map(|a| a.0), Some("vibe"));
        assert_eq!(agent_of("vibe-app-serv", "/home/u/.local/bin/vibe-app-server"), None);
        assert_eq!(agent_of("node", "node server.js"), None);
        assert_eq!(agent_of("bash", "bash"), None);
    }

    fn rollout(first_line: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "rollout-2026-09-25T20-10-11-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, format!("{first_line}\n")).unwrap();
        path
    }

    #[test]
    fn reads_the_thread_id_of_a_codex_session() {
        let path = rollout(
            r#"{"type":"session_meta","payload":{"session_id":"other","id":"thread-1","cwd":"/home/u/p","source":"cli"}}"#,
        );
        let entry = read_codex_session(&path, Some(1), Some("Ubuntu"), None).unwrap();
        assert_eq!(entry.session_id, "thread-1");
        assert_eq!(entry.cwd, "/home/u/p");
        assert_eq!(entry.wsl_distro.as_deref(), Some("Ubuntu"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn skips_codex_subagent_threads() {
        let path = rollout(
            r#"{"type":"session_meta","payload":{"id":"t","parent_thread_id":"p","cwd":"/x","source":{"subagent":{"other":"guardian"}}}}"#,
        );
        assert!(read_codex_session(&path, None, None, None).is_none());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn tells_an_open_turn_from_a_finished_one() {
        let started = r#"{"type":"event_msg","payload":{"type":"task_started","turn_id":"1"}}"#;
        let complete = r#"{"type":"event_msg","payload":{"type":"task_complete","turn_id":"1"}}"#;
        // A long tool output after the turn started, longer than a read chunk,
        // that only mentions the events inside (escaped) text.
        let filler = format!(
            r#"{{"type":"response_item","payload":{{"type":"function_call_output","output":"{} {{\"type\":\"task_complete\"}}"}}}}"#,
            "x".repeat(100 * 1024)
        );
        let path = rollout(r#"{"type":"session_meta","payload":{"id":"t","cwd":"/x"}}"#);
        let append = |line: &str| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(f, "{line}").unwrap();
        };
        assert_eq!(rollout_turn_open(&path), None);
        append(started);
        append(&filler);
        assert_eq!(rollout_turn_open(&path), Some(true));
        append(complete);
        append(r#"{"type":"event_msg","payload":{"type":"token_count"}}"#);
        assert_eq!(rollout_turn_open(&path), Some(false));
        let _ = std::fs::remove_file(path);
    }
}
