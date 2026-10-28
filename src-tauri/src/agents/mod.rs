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
mod claude_history;
pub use self::claude_history::*;
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
    &[("claude", "Claude Code"), ("codex", "Codex CLI"), ("vibe", "Mistral Vibe"), ("gemini", "Gemini CLI")];

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
                // Gemini CLI is a Node script: its process is `node` (a `gemini.cmd`
                // shim on Windows), told apart by the script on the command line.
                if name == "node" {
                    let args: Vec<String> = process.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
                    if node_runs_gemini(&args) {
                        let started_at = process.start_time().checked_mul(1000);
                        return Some(("gemini", "Gemini CLI", pid.as_u32(), started_at));
                    }
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

/// Ends the agent running in this app's pty `pty_id` (its whole process
/// tree) and resolves once it is gone, or after a few seconds: the
/// terminal-to-chat handoff awaits it so the chat's agent never resumes a
/// session the terminal still holds. Only an agent found under one of our
/// ptys, never an arbitrary pid; not one inside WSL (`pid` is a Linux pid).
#[tauri::command]
pub async fn end_pty_agent(app: tauri::AppHandle, pty_id: String) -> Result<(), String> {
    let sessions = collect_agent_sessions(&app).await?;
    let Some(pid) = sessions.iter().find(|s| s.pty_id == pty_id && s.wsl_distro.is_none()).map(|s| s.pid) else {
        return Ok(());
    };
    crate::blocking(move || {
        crate::chat::kill_tree(pid);
        let target = Pid::from_u32(pid);
        let mut sys = System::new();
        for _ in 0..50 {
            sys.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[target]), true);
            if sys.process(target).is_none() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        Ok(())
    })
    .await
}

/// Whether a session of `cli` has a transcript on disk that `claude --resume` /
/// `codex resume` / an ACP `session/load` can open. A session nobody has
/// prompted yet (a fresh chat, or a terminal agent just started) has none, and
/// resuming it fails: the terminal/chat switch starts a fresh agent instead.
/// Agents other than Claude and Codex report `true` (not checked).
#[tauri::command]
pub async fn agent_session_saved(app: tauri::AppHandle, cli: String, session_id: String, profile: Option<String>) -> Result<bool, String> {
    if !is_safe_session_id(&session_id) {
        return Ok(false);
    }
    let Some(dirs) = crate::profiles::dirs(&app, profile.as_deref()) else { return Ok(true) };
    crate::blocking(move || {
        Ok(match cli.as_str() {
            "claude" => std::fs::read_dir(dirs.claude.join("projects"))
                .map(|folders| folders.flatten().any(|f| f.path().join(format!("{session_id}.jsonl")).is_file()))
                .unwrap_or(false),
            "codex" => codex::find_codex_rollout(&dirs.codex.join("sessions"), &session_id).is_some(),
            _ => true,
        })
    })
    .await
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
    // Threads a chat owns are not a terminal tab's.
    let chat_ids = app.state::<crate::chat::ChatState>().live_session_ids();
    let mut sessions = crate::blocking(move || Ok(find_agent_sessions(shell_pids, &homes, &profiles, &chat_ids))).await?;
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
    chat_ids: &HashSet<String>,
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
        let mut codex_tabs: Vec<usize> = Vec::new();
        let mut vibe_tabs: Vec<usize> = Vec::new();
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
                    // Threads are paired with the tabs below, once all are known.
                    codex_tabs.push(sessions.len());
                } else if cli == "vibe" {
                    vibe_tabs.push(sessions.len());
                } else if let Some(entry) = claude_registry_entry(pid, &homes.claude) {
                    session.apply_claude_entry(&entry);
                }
                sessions.push(session);
            } else if let Some(distro) = find_wsl_client(sys, root, &children_of) {
                wsl_tabs.entry(distro).or_default().insert(pty_id);
            }
        }
        if !codex_tabs.is_empty() {
            assign_codex_threads(&mut sessions, &codex_tabs, &host_live_threads(&homes.codex), chat_ids);
        }
        // Newest process first, so it takes the newest session; each session once.
        vibe_tabs.sort_by_key(|&i| std::cmp::Reverse(sessions[i].started_at));
        let mut claimed = chat_ids.clone();
        for i in vibe_tabs {
            let found = homes.vibe_of(&sessions[i].profile).and_then(|home| {
                let cwd = sessions[i].cwd.as_deref()?;
                crate::vibe::live_session_in(home, cwd, sessions[i].started_at, &claimed)
            });
            if let Some(found) = found {
                claimed.insert(found.0.clone());
                sessions[i].apply_vibe_session(found);
            }
        }
        sessions
    });
    // Outside the process table's lock: this runs `wsl.exe`.
    for (distro, pty_ids) in wsl_tabs {
        sessions.extend(wsl_agents(distro.as_deref(), &pty_ids, chat_ids));
    }
    sessions
}

/// Gives each Codex tab (`tabs`: indexes into `sessions`) its own live thread.
/// Codex doesn't say which process holds which thread, so tabs sharing a
/// folder and profile used to all be handed the folder's latest thread - one
/// working made every one of them look busy. Within such a group the tabs are
/// paired with distinct threads in creation order (process start time against
/// thread id, which Codex generates time-ordered); a tab left without a thread
/// (just started, nothing written yet) is the newest one. Threads in `skip`
/// belong to a chat (codex-acp writes them in the same Codex home) and are left out.
/// Groups with a thread of their own profile go first; the others fall back to
/// any profile's thread in the folder, but never to one already taken.
fn assign_codex_threads(sessions: &mut [AgentSession], tabs: &[usize], threads: &[LiveThread], skip: &HashSet<String>) {
    let mut groups: HashMap<(Option<String>, String), Vec<usize>> = HashMap::new();
    for &i in tabs {
        let key = (sessions[i].profile.clone(), sessions[i].cwd.clone().unwrap_or_default());
        groups.entry(key).or_default().push(i);
    }
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by(|a, b| a.0.cmp(&b.0));
    let mut claimed: HashSet<String> = HashSet::new();
    let mut pending = Vec::new();
    for pass in 0..2 {
        let groups = if pass == 0 { std::mem::take(&mut groups) } else { std::mem::take(&mut pending) };
        for (key, mut members) in groups {
            let (profile, cwd) = &key;
            let in_dir = |own: bool| -> Vec<&LiveThread> {
                threads
                    .iter()
                    .filter(|t| !skip.contains(&t.id) && !claimed.contains(&t.id))
                    .filter(|t| (!own || t.profile == *profile) && same_dir(&t.cwd, cwd))
                    .collect()
            };
            let mut candidates = in_dir(true);
            if candidates.is_empty() {
                if pass == 0 {
                    pending.push((key, members));
                    continue;
                }
                candidates = in_dir(false);
            }
            // More threads than tabs (Codex open elsewhere too): the busiest recent ones.
            candidates.sort_by_key(|t| std::cmp::Reverse(t.updated_at));
            candidates.truncate(members.len());
            candidates.sort_by(|a, b| a.id.cmp(&b.id));
            members.sort_by_key(|&i| sessions[i].started_at);
            let taken: Vec<String> = candidates.iter().map(|t| t.id.clone()).collect();
            for (&i, thread) in members.iter().zip(candidates) {
                sessions[i].apply_thread(thread);
            }
            claimed.extend(taken);
        }
    }
}

/// Whether a session id read from disk (a transcript's file name, a field
/// inside it, an agent's registry) is fit to be pasted into a
/// `claude --resume <id>` / `codex resume <id>` command line typed into a
/// shell: a planted `x;calc.jsonl` must not become shell syntax. Real ids are
/// UUIDs or short slugs, so anything outside `[A-Za-z0-9_-]{1,128}` is dropped.
pub(crate) fn is_safe_session_id(id: &str) -> bool {
    (1..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl AgentSession {
    /// Id, name and "busy"/"waiting"/"idle" from a Claude Code registry
    /// entry (see `claude_registry_entry`).
    fn apply_claude_entry(&mut self, entry: &serde_json::Value) {
        let text = |key: &str| entry.get(key).and_then(|v| v.as_str()).map(str::to_string);
        self.session_id = text("sessionId").filter(|id| is_safe_session_id(id));
        self.session_name = text("name");
        self.status = text("status");
    }

    fn apply_vibe_session(&mut self, (id, name, status): (String, Option<String>, &'static str)) {
        self.session_id = Some(id).filter(|id| is_safe_session_id(id));
        self.session_name = name;
        self.status = Some(status.to_string());
    }

    fn apply_thread(&mut self, thread: &LiveThread) {
        self.session_id = Some(thread.id.clone()).filter(|id| is_safe_session_id(id));
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
    // The line cut off at the start of the previous chunk(s), as the pieces it
    // was read in (nearest to the end of the file first), so a line spanning
    // many chunks is joined once instead of copied again for every chunk.
    let mut carry: Vec<Vec<u8>> = Vec::new();
    while end > 0 && len - end < max_scan {
        let start = end.saturating_sub(chunk);
        let mut buf = vec![0u8; (end - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut buf).ok()?;
        // Unless this chunk starts the file, its first line may be partial.
        let first_newline = buf.iter().position(|&b| b == b'\n');
        if start != 0 && first_newline.is_none() {
            carry.push(buf);
            end = start;
            continue;
        }
        for piece in carry.iter().rev() {
            buf.extend_from_slice(piece);
        }
        let (head, lines) = match first_newline {
            Some(i) if start != 0 => (buf[..i].to_vec(), &buf[i + 1..]),
            _ => (Vec::new(), &buf[..]),
        };
        for line in lines.split(|&b| b == b'\n').rev() {
            if let Some(found) = visit(line) {
                return Some(found);
            }
        }
        carry = if head.is_empty() { Vec::new() } else { vec![head] };
        end = start;
    }
    None
}

/// The live thread working in `cwd` - the most recently active one, if a
/// folder has several.
fn thread_in<'a>(threads: &[&'a LiveThread], cwd: &str) -> Option<&'a LiveThread> {
    threads.iter().copied().filter(|t| same_dir(&t.cwd, cwd)).max_by_key(|t| t.updated_at)
}

/// Whether a `node` command line runs Gemini CLI: its script is `gemini` /
/// `gemini.js` or lives in the `@google/gemini-cli` package (either slash).
fn node_runs_gemini(args: &[String]) -> bool {
    args.iter().skip(1).take(3).any(|a| {
        let a = a.to_lowercase().replace('\\', "/");
        a.contains("@google/gemini-cli") || matches!(a.rsplit('/').next(), Some("gemini" | "gemini.js" | "gemini.mjs"))
    })
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
    use super::is_safe_session_id;
    use super::{assign_codex_threads, AgentSession, LiveThread};
    use std::collections::HashSet;

    fn tab(started: u64, cwd: &str) -> AgentSession {
        AgentSession { cli: "codex".into(), started_at: Some(started), cwd: Some(cwd.into()), ..AgentSession::default() }
    }

    fn thread(id: &str, cwd: &str, updated: u64, busy: bool) -> LiveThread {
        LiveThread {
            id: id.into(),
            cwd: cwd.into(),
            name: None,
            updated_at: Some(updated),
            turn_open: Some(busy),
            wsl_distro: None,
            pty_id: None,
            profile: None,
        }
    }

    fn ids(sessions: &[AgentSession]) -> Vec<Option<&str>> {
        sessions.iter().map(|s| s.session_id.as_deref()).collect()
    }

    #[test]
    fn codex_tabs_in_one_folder_get_distinct_threads() {
        let mut s = vec![tab(200, "/p"), tab(100, "/p")];
        let threads = [thread("a", "/p", 5, false), thread("b", "/p", 9, true)];
        assign_codex_threads(&mut s, &[0, 1], &threads, &HashSet::new());
        // Older process, older thread.
        assert_eq!(ids(&s), vec![Some("b"), Some("a")]);
        assert_eq!(s[0].status.as_deref(), Some("busy"));
        assert_eq!(s[1].status.as_deref(), Some("idle"));
    }

    #[test]
    fn extra_threads_keep_the_most_recent() {
        let mut s = vec![tab(100, "/p")];
        let threads = [thread("a", "/p", 1, false), thread("b", "/p", 9, true), thread("c", "/other", 99, true)];
        assign_codex_threads(&mut s, &[0], &threads, &HashSet::new());
        assert_eq!(ids(&s), vec![Some("b")]);
    }

    #[test]
    fn newest_tab_without_thread_gets_none() {
        let mut s = vec![tab(100, "/p"), tab(200, "/p")];
        assign_codex_threads(&mut s, &[0, 1], &[thread("a", "/p", 1, false)], &HashSet::new());
        assert_eq!(ids(&s), vec![Some("a"), None]);
    }

    #[test]
    fn chat_threads_are_left_out() {
        let mut s = vec![tab(100, "/p")];
        let threads = [thread("a", "/p", 1, false), thread("chat", "/p", 9, true)];
        let skip = HashSet::from(["chat".to_string()]);
        assign_codex_threads(&mut s, &[0], &threads, &skip);
        assert_eq!(ids(&s), vec![Some("a")]);
        assert_eq!(s[0].status.as_deref(), Some("idle"));
    }

    #[test]
    fn fallback_never_takes_a_thread_another_group_took() {
        let mut s = vec![tab(100, "/p"), tab(200, "/p")];
        s[1].profile = Some("work".into());
        let mut own = thread("own", "/p", 1, false);
        own.profile = Some("work".into());
        let threads = [own];
        assign_codex_threads(&mut s, &[0, 1], &threads, &HashSet::new());
        assert_eq!(ids(&s), vec![None, Some("own")]);
    }

    #[test]
    fn session_ids_fit_for_a_command_line() {
        for ok in ["0b9c1f0e-8a8e-4c6e-9d1a-2f3b4c5d6e7f", "abc123", "thread_1", &"a".repeat(128)] {
            assert!(is_safe_session_id(ok), "{ok:?}");
        }
        for bad in ["", "x;calc", "a b", "$(rm -rf ~)", "a`b`", "a&b", "a|b", "..", "a/b", "a\\b", "caf\u{e9}", "x\n", &"a".repeat(129)] {
            assert!(!is_safe_session_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn codex_session_with_an_unsafe_id_is_skipped() {
        let dir = std::env::temp_dir().join(format!("flowcode-codex-unsafe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        std::fs::write(
            &path,
            r#"{"type":"session_meta","payload":{"id":"x;calc","cwd":"/home/u/p","source":"cli"}}"#,
        )
        .unwrap();
        assert!(read_codex_session(&path, None, None, None).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

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
        assert_eq!(agent_of("node", "node /usr/lib/node_modules/@google/gemini-cli/dist/index.js").map(|a| a.0), Some("gemini"));
        assert_eq!(agent_of("node", "node /usr/bin/gemini").map(|a| a.0), Some("gemini"));
        assert_eq!(agent_of("gemini", "gemini --resume latest").map(|a| a.0), Some("gemini"));
        assert!(super::node_runs_gemini(&["node".into(), r"C:\Users\u\AppData\Roaming\npm\node_modules\@google\gemini-cli\dist\index.js".into()]));
        assert!(!super::node_runs_gemini(&["node".into(), "server.js".into()]));
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

    #[test]
    fn scans_backwards_across_lines_longer_than_a_chunk() {
        let path = std::env::temp_dir().join(format!("scan-{}.jsonl", uuid::Uuid::new_v4()));
        let long = "x".repeat(1000);
        std::fs::write(&path, format!("first\n{long}\nlast\n")).unwrap();
        for chunk in [7u64, 64, 4096] {
            let mut seen: Vec<Vec<u8>> = Vec::new();
            let none = super::scan_lines_backwards::<()>(&path, chunk, u64::MAX, |l| {
                seen.push(l.to_vec());
                None
            });
            assert!(none.is_none());
            let expected: Vec<&[u8]> = vec![b"", b"last", long.as_bytes(), b"first"];
            assert_eq!(seen.iter().map(Vec::as_slice).collect::<Vec<_>>(), expected, "chunk {chunk}");
        }
        let _ = std::fs::remove_file(path);
    }
}
