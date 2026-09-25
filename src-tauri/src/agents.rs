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
use crate::windows::WindowTabs;

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

#[derive(Serialize, Clone, Default)]
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
    /// The agent's own session, when it can be read (WSL agents - see
    /// `WSL_AGENT_SCAN`; a Windows Claude Code is matched to `claude agents`
    /// by pid in the frontend instead): its id, its name (the title the CLI
    /// gave it, or the one the user renamed it to) and, for Claude Code,
    /// "busy"/"idle".
    session_id: Option<String>,
    session_name: Option<String>,
    status: Option<String>,
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
///
/// Async: a full process-table refresh takes tens of milliseconds (more on
/// Windows) and this is polled every few seconds - on the UI thread that
/// shows up as periodic stutter.
#[tauri::command]
pub async fn list_agent_sessions(
    pty_state: State<'_, PtyState>,
    window_tabs: State<'_, WindowTabs>,
) -> Result<Vec<AgentSession>, String> {
    let shell_pids = pty_state.shell_pids();
    if shell_pids.is_empty() {
        return Ok(Vec::new());
    }
    let tabs = window_tabs.by_pty();
    let mut sessions = crate::blocking(move || Ok(find_agent_sessions(shell_pids))).await?;
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

/// The WSL client a tab's shell tree leads to, if any - `Some(distro)` where
/// `distro` is the `-d` it was started with (`None`: the default distro).
/// Whatever runs past it lives in the Linux VM, out of Windows' process tree.
fn find_wsl_client(sys: &System, root_pid: Pid, children_of: &HashMap<Pid, Vec<Pid>>) -> Option<Option<String>> {
    let mut queue: VecDeque<Pid> = VecDeque::from([root_pid]);
    let mut visited: HashSet<Pid> = HashSet::new();
    while let Some(pid) = queue.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(process) = sys.process(pid) {
            let name = process.name().to_string_lossy().to_lowercase();
            if name == "wsl.exe" || name == "wsl" {
                let args: Vec<String> = process.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
                let distro = args
                    .iter()
                    .position(|a| a == "-d" || a == "--distribution")
                    .and_then(|i| args.get(i + 1).cloned());
                return Some(distro);
            }
        }
        if let Some(children) = children_of.get(&pid) {
            queue.extend(children.iter().copied());
        }
    }
    None
}

fn find_agent_sessions(shell_pids: Vec<(String, u32)>) -> Vec<AgentSession> {
    let mut sys = System::new();
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::new()
            .with_cmd(sysinfo::UpdateKind::OnlyIfNotSet)
            .with_cwd(sysinfo::UpdateKind::OnlyIfNotSet),
    );

    let mut children_of: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, process) in sys.processes() {
        if let Some(parent) = process.parent() {
            children_of.entry(parent).or_default().push(*pid);
        }
    }

    let mut sessions = Vec::new();
    let mut host_threads: Option<Vec<LiveThread>> = None;
    // Distro -> the tabs whose agent (if any) can only be found inside it.
    let mut wsl_tabs: HashMap<Option<String>, HashSet<String>> = HashMap::new();
    for (pty_id, shell_pid) in shell_pids {
        let root = Pid::from_u32(shell_pid);
        if let Some((cli, cli_label, pid, started_at)) = find_agent(&sys, root, &children_of) {
            let cwd = sys
                .process(Pid::from_u32(pid))
                .and_then(|p| p.cwd())
                .map(|c| c.to_string_lossy().trim_end_matches(['\\', '/']).to_string());
            let mut session = AgentSession {
                pty_id,
                cli: cli.to_string(),
                cli_label: cli_label.to_string(),
                pid,
                started_at,
                cwd: cwd.clone(),
                ..AgentSession::default()
            };
            if cli == "codex" {
                let threads = host_threads.get_or_insert_with(host_live_threads);
                if let Some(thread) = cwd.as_deref().and_then(|c| thread_in(threads, c)) {
                    session.apply_thread(thread);
                }
            }
            sessions.push(session);
        } else if let Some(distro) = find_wsl_client(&sys, root, &children_of) {
            wsl_tabs.entry(distro).or_default().insert(pty_id);
        }
    }
    for (distro, pty_ids) in wsl_tabs {
        sessions.extend(wsl_agents(distro.as_deref(), &pty_ids));
    }
    sessions
}

impl AgentSession {
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
    wsl_distro: Option<String>,
    /// The Flowcode tab running it, when that tab says so (see `PTY_ID_ENV`).
    pty_id: Option<String>,
}

/// How recently a thread must have written its rollout to count as working.
const BUSY_WINDOW_MS: u64 = 8_000;

impl LiveThread {
    fn status(&self) -> &'static str {
        let now = crate::fs::system_time_to_millis(Ok(std::time::SystemTime::now())).unwrap_or(0);
        match self.updated_at {
            Some(at) if now.saturating_sub(at) < BUSY_WINDOW_MS => "busy",
            _ => "idle",
        }
    }
}

/// Paths compared the way the OS would: separators and case (Windows) aside.
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        let p = p.trim_end_matches(['\\', '/']).replace('\\', "/");
        if cfg!(windows) && !p.starts_with('/') { p.to_lowercase() } else { p }
    };
    norm(a) == norm(b)
}

/// The live thread working in `cwd` - the most recently active one, if a
/// folder has several.
fn thread_in<'a>(threads: &'a [LiveThread], cwd: &str) -> Option<&'a LiveThread> {
    threads.iter().filter(|t| same_dir(&t.cwd, cwd)).max_by_key(|t| t.updated_at)
}

/// What a rollout's `session_meta` says - read once per file (it never
/// changes), since live threads are looked up on every poll.
#[derive(Clone)]
struct RolloutMeta {
    id: String,
    cwd: String,
    subagent: bool,
}

fn rollout_meta(path: &Path) -> Option<RolloutMeta> {
    static CACHE: Mutex<Option<HashMap<PathBuf, Option<RolloutMeta>>>> = Mutex::new(None);
    if let Some(hit) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(path) {
        return hit.clone();
    }
    let meta = (|| {
        let file = std::fs::File::open(path).ok()?;
        let line = BufReader::new(file).lines().next()?.ok()?;
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        let payload = value.get("payload")?;
        Some(RolloutMeta {
            id: payload
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or_else(|| uuid_from_filename(path))?,
            cwd: payload.get("cwd")?.as_str()?.to_string(),
            subagent: payload.get("parent_thread_id").is_some_and(|p| !p.is_null())
                || payload.get("source").and_then(|s| s.get("subagent")).is_some(),
        })
    })();
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(path.to_path_buf(), meta.clone());
    meta
}

/// Thread names from a Codex home's `session_index.jsonl` - re-read only
/// when the file changes.
fn thread_names_in(codex_home: &Path) -> HashMap<String, String> {
    static CACHE: Mutex<Option<HashMap<PathBuf, (Option<u64>, HashMap<String, String>)>>> = Mutex::new(None);
    let index = codex_home.join("session_index.jsonl");
    let mtime = crate::fs::system_time_to_millis(std::fs::metadata(&index).and_then(|m| m.modified()));
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if let Some((at, names)) = cache.get(&index) {
        if *at == mtime {
            return names.clone();
        }
    }
    let names = codex_thread_names(&codex_home.join("sessions"));
    cache.insert(index, (mtime, names.clone()));
    names
}

/// Whether another process holds `lock` - how Codex marks the threads it
/// has open (`~/.codex/thread-writer-locks/<id>.lock`). Tried shared and
/// released at once, so it never stands in Codex's way.
fn lock_is_held(lock: &Path) -> bool {
    let file = match std::fs::OpenOptions::new().read(true).open(lock) {
        Ok(file) => file,
        // Windows: opened without sharing by its holder.
        Err(e) => return e.raw_os_error() == Some(32),
    };
    match file.try_lock_shared() {
        Ok(()) => {
            let _ = file.unlock();
            false
        }
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(_) => false,
    }
}

/// Codex threads open right now on this machine itself (not in WSL): those
/// whose writer lock is held.
fn host_live_threads() -> Vec<LiveThread> {
    let Some(home) = crate::fs::user_home().map(|h| h.join(".codex")) else { return Vec::new() };
    let Ok(locks) = std::fs::read_dir(home.join("thread-writer-locks")) else { return Vec::new() };
    let held: Vec<String> = locks
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "lock")
                && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))
        })
        .filter(|p| lock_is_held(p))
        .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    if held.is_empty() {
        return Vec::new();
    }
    let mut files = Vec::new();
    find_rollout_files(&home.join("sessions"), 5, &mut files);
    let names = thread_names_in(&home);
    held.iter()
        .filter_map(|id| {
            let path = files.iter().find(|f| f.to_string_lossy().contains(id.as_str()))?;
            let meta = rollout_meta(path)?;
            if meta.subagent {
                return None;
            }
            Some(LiveThread {
                name: names.get(&meta.id).cloned(),
                id: meta.id,
                cwd: meta.cwd,
                updated_at: crate::fs::system_time_to_millis(std::fs::metadata(path).and_then(|m| m.modified())),
                wsl_distro: None,
                pty_id: None,
            })
        })
        .collect()
}

/// Everything the agents panel needs from inside one WSL distro, read in one
/// `wsl.exe` call (see `WSL_SCAN`).
#[derive(Default)]
struct WslScan {
    procs: Vec<WslProc>,
    /// Rollout files some Codex process holds open, with their mtime (s).
    rollouts: Vec<(String, Option<u64>)>,
}

struct WslProc {
    pid: u32,
    comm: String,
    /// The Flowcode tab it runs in (`PTY_ID_ENV`) - this app's or another
    /// instance's; absent for anything else.
    pty_id: Option<String>,
    started_at: Option<u64>,
    cwd: String,
    /// Claude Code's registry entry for it, `~/.claude/sessions/<pid>.json`.
    claude_json: String,
    argv: String,
}

/// Inside the distro: every agent CLI process (its tab id from the
/// environment `pty_spawn` gave it, carried across by WSLENV) and every
/// rollout a Codex process has open - with Codex's daemon, that's the daemon,
/// not the `codex` in the terminal. Shell builtins except for the few
/// matching processes, so it stays fast on a busy distro. Lines:
/// `P pid comm tab-id start(s) cwd claude-json argv` and `R path mtime(s)`,
/// tab-separated.
const WSL_SCAN: &str = r#"for d in /proc/[0-9]*; do
  read -r c < "$d/comm" 2>/dev/null || continue
  case "$c" in claude|codex|codex-*|node|MainThread) ;; *) continue ;; esac
  p=${d#/proc/}
  case "$c" in codex*)
    for f in "$d"/fd/*; do
      l=$(readlink "$f" 2>/dev/null) || continue
      case "$l" in */rollout-*.jsonl) printf 'R\t%s\t%s\n' "$l" "$(stat -c %Y "$l" 2>/dev/null)" ;; esac
    done ;;
  esac
  id=$(tr '\0' '\n' < "$d/environ" 2>/dev/null | sed -n 's/^FLOWCODE_PTY_ID=//p')
  j=""; [ -f "$HOME/.claude/sessions/$p.json" ] && j=$(tr -d '\t\n' < "$HOME/.claude/sessions/$p.json")
  printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$c" "$id" "$(stat -c %Y "$d" 2>/dev/null)" "$(readlink "$d/cwd")" "$j" "$(tr '\0' ' ' < "$d/cmdline")"
done"#;

/// How long one scan of a distro serves: the agents list and the Codex
/// sessions list both need it on every poll.
const WSL_SCAN_REUSE: std::time::Duration = std::time::Duration::from_millis(1500);

fn wsl_scan(distro: Option<&str>) -> std::sync::Arc<WslScan> {
    type Cache = Vec<(Option<String>, std::time::Instant, std::sync::Arc<WslScan>)>;
    static CACHE: Mutex<Cache> = Mutex::new(Vec::new());
    // Held for the whole scan: a second caller waits for this one's result
    // instead of starting another wsl.exe.
    let mut cache = CACHE.lock().unwrap();
    let key = distro.map(str::to_string);
    if let Some((_, at, scan)) = cache.iter().find(|(d, _, _)| *d == key) {
        if at.elapsed() < WSL_SCAN_REUSE {
            return scan.clone();
        }
    }
    let scan = std::sync::Arc::new(run_wsl_scan(distro));
    cache.retain(|(d, _, _)| *d != key);
    cache.push((key, std::time::Instant::now(), scan.clone()));
    scan
}

fn run_wsl_scan(distro: Option<&str>) -> WslScan {
    let mut cmd = std::process::Command::new("wsl.exe");
    if let Some(distro) = distro {
        cmd.args(["-d", distro]);
    }
    cmd.args(["-e", "sh", "-c", WSL_SCAN]).stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let Ok(output) = cmd.output() else { return WslScan::default() };
    let text = crate::system::decode_wsl_output(&output.stdout);
    let mut scan = WslScan::default();
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[..] {
            ["R", path, mtime] => {
                if !scan.rollouts.iter().any(|(p, _)| p == path) {
                    scan.rollouts.push((path.to_string(), mtime.trim().parse().ok()));
                }
            }
            ["P", pid, comm, pty_id, started, cwd, claude_json, argv] => scan.procs.push(WslProc {
                pid: pid.parse().unwrap_or(0),
                comm: comm.to_string(),
                pty_id: Some(pty_id.to_string()).filter(|id| !id.is_empty()),
                started_at: started.trim().parse::<u64>().ok().map(|s| s * 1000),
                cwd: cwd.to_string(),
                claude_json: claude_json.to_string(),
                argv: argv.to_string(),
            }),
            _ => {}
        }
    }
    scan
}

/// The agent CLI a Linux process runs as the user's own session - not
/// Codex's background daemon or its helpers.
fn wsl_agent_of(proc_: &WslProc) -> Option<(&'static str, &'static str)> {
    if proc_.argv.contains(" app-server") || proc_.comm.starts_with("codex-code") {
        return None;
    }
    agent_of(&proc_.comm, &proc_.argv)
}

/// `\\wsl.localhost\<distro>\...` for a Linux path.
fn wsl_unc(distro: &str, path: &str) -> PathBuf {
    PathBuf::from(format!(r"\\wsl.localhost\{distro}{}", path.replace('/', r"\")))
}

/// Codex threads open right now inside the distro: a rollout some Codex
/// process holds, worked on by a `codex` session running in that same folder
/// (the daemon can keep a thread loaded after its terminal is gone).
fn wsl_live_threads(distro: Option<&str>) -> Vec<LiveThread> {
    let Some(distro_name) = distro.map(str::to_string).or_else(default_wsl_distro) else { return Vec::new() };
    let scan = wsl_scan(distro);
    let terminals: Vec<&WslProc> = scan
        .procs
        .iter()
        .filter(|p| wsl_agent_of(p).is_some_and(|(bin, _)| bin == "codex"))
        .collect();
    if terminals.is_empty() {
        return Vec::new();
    }
    scan.rollouts
        .iter()
        .filter_map(|(path, mtime)| {
            let meta = rollout_meta(&wsl_unc(&distro_name, path))?;
            if meta.subagent {
                return None;
            }
            let terminal = terminals.iter().find(|p| same_dir(&p.cwd, &meta.cwd))?;
            let codex_home = path.split("/sessions/").next().unwrap_or_default();
            Some(LiveThread {
                name: thread_names_in(&wsl_unc(&distro_name, codex_home)).get(&meta.id).cloned(),
                id: meta.id,
                cwd: meta.cwd,
                updated_at: mtime.map(|s| s * 1000),
                wsl_distro: Some(distro_name.clone()),
                pty_id: terminal.pty_id.clone(),
            })
        })
        .collect()
}

/// The agents running inside a WSL distro in this app's tabs (`pty_ids`).
fn wsl_agents(distro: Option<&str>, pty_ids: &HashSet<String>) -> Vec<AgentSession> {
    let scan = wsl_scan(distro);
    let distro_name = distro.map(str::to_string).or_else(default_wsl_distro);
    let mut threads: Option<Vec<LiveThread>> = None;

    // The oldest matching process per tab - a CLI's own launcher (a node
    // wrapper spawning the native binary) rather than its helpers.
    let mut best: HashMap<String, &WslProc> = HashMap::new();
    for proc_ in &scan.procs {
        let Some(pty_id) = proc_.pty_id.as_ref().filter(|id| pty_ids.contains(*id)) else { continue };
        if wsl_agent_of(proc_).is_none() {
            continue;
        }
        match best.get(pty_id) {
            Some(existing) if existing.started_at <= proc_.started_at => {}
            _ => {
                best.insert(pty_id.clone(), proc_);
            }
        }
    }
    best.into_iter()
        .filter_map(|(pty_id, proc_)| {
            let (bin, label) = wsl_agent_of(proc_)?;
            let mut session = AgentSession {
                pty_id,
                cli: bin.to_string(),
                cli_label: label.to_string(),
                pid: proc_.pid,
                started_at: proc_.started_at,
                wsl_distro: distro_name.clone(),
                cwd: Some(proc_.cwd.clone()).filter(|c| c.starts_with('/')),
                ..AgentSession::default()
            };
            if bin == "claude" {
                // Its own registry entry - the same kind of Claude Code's
                // Windows sessions are read from (`claude agents`).
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(&proc_.claude_json) {
                    let text = |key: &str| entry.get(key).and_then(|v| v.as_str()).map(str::to_string);
                    session.session_id = text("sessionId");
                    session.session_name = text("name");
                    session.status = text("status");
                }
            } else {
                let threads = threads.get_or_insert_with(|| wsl_live_threads(distro));
                if let Some(thread) = threads
                    .iter()
                    .find(|t| t.pty_id.as_deref() == Some(session.pty_id.as_str()))
                    .or_else(|| thread_in(threads, &proc_.cwd))
                {
                    session.apply_thread(thread);
                }
            }
            Some(session)
        })
        .collect()
}

/// Which agent CLI a Linux process is: by its own name, or - for a Node
/// wrapper (`node .../codex.js`, `node .../claude/cli.js`) - by the script it
/// runs.
fn agent_of(comm: &str, argv: &str) -> Option<(&'static str, &'static str)> {
    let by_name = |name: &str| {
        AGENT_BINARIES
            .iter()
            .find(|(bin, _)| name == *bin || name.starts_with(&format!("{bin}-")))
            .copied()
    };
    if let Some(found) = by_name(comm) {
        return Some(found);
    }
    let script = argv.split_whitespace().nth(1)?.to_lowercase();
    script.split('/').find_map(|part| by_name(part.trim_end_matches(".js")))
}

/// The default WSL distro's name, asked once per app run (a `wsl.exe` call).
fn default_wsl_distro() -> Option<String> {
    static DISTRO: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    DISTRO.get_or_init(crate::system::wsl_default_distro).clone()
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
    /// The app whose terminal it runs in, when recognizable (see
    /// `host_app_of`) - not part of `claude agents`' own output.
    #[serde(rename = "hostApp", default)]
    host_app: Option<String>,
}

/// Whether a `claude agents` entry is a one-shot `claude -p` run rather than
/// a session someone works in - the usage popover's `/usage` probe (this
/// app's, or another Flowcode's: `ProbePids` only knows our own, and only by
/// the pid of the shim it launched), or any other scripted query. Claude
/// Code lists those too; its registry entry (`~/.claude/sessions/<pid>.json`)
/// tells them apart by `entrypoint`: "cli" for an interactive or background
/// session, "sdk-..." for `-p`/SDK runs.
fn is_headless_claude_run(pid: u32) -> bool {
    let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| crate::fs::user_home().map(|h| h.join(".claude")));
    let Some(dir) = dir else { return false };
    let Ok(text) = std::fs::read_to_string(dir.join("sessions").join(format!("{pid}.json"))) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("entrypoint").and_then(|e| e.as_str()).map(|e| e.starts_with("sdk")))
        .unwrap_or(false)
}

/// The terminal app a process runs under, by walking up its parents: this
/// Flowcode, another Flowcode (e.g. an installed one next to a dev build), or
/// a few other well-known terminals.
fn host_app_of(sys: &System, pid: u32) -> Option<String> {
    let own = std::process::id();
    let mut current = sys.process(Pid::from_u32(pid))?.parent();
    for _ in 0..32 {
        let process = sys.process(current?)?;
        let raw = process.name().to_string_lossy().to_lowercase();
        let stem = raw.strip_suffix(".exe").unwrap_or(&raw);
        let app = match stem {
            "flowcode" if process.pid().as_u32() == own => "Flowcode",
            "flowcode" => "altra istanza di Flowcode",
            "windowsterminal" => "Windows Terminal",
            "code" => "VS Code",
            "cursor" => "Cursor",
            "idea64" | "idea" => "IntelliJ IDEA",
            "iterm2" => "iTerm2",
            "terminal" => "Terminale",
            _ => {
                current = process.parent();
                continue;
            }
        };
        return Some(app.to_string());
    }
    None
}

#[tauri::command]
pub async fn list_claude_agents(probe_pids: State<'_, ProbePids>) -> Result<Vec<ClaudeAgentEntry>, String> {
    let output = crate::blocking(|| run_command_blocking("claude agents --json").map_err(|e| e.to_string())).await?;

    if !output.status.success() {
        // Not installed, not on PATH, or an old version without this
        // subcommand - all read the same to the frontend: no data, not an
        // error to surface (the usage popover already has its own separate
        // "not installed"/"not logged in" messaging for Claude).
        return Ok(Vec::new());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<ClaudeAgentEntry> = serde_json::from_str(&stdout).map_err(|e| e.to_string())?;
    let entries: Vec<ClaudeAgentEntry> = {
        let excluded = probe_pids.0.lock().unwrap();
        entries.into_iter().filter(|e| !excluded.contains(&e.pid)).collect()
    };
    if entries.is_empty() {
        return Ok(entries);
    }
    crate::blocking(move || {
        let mut sys = System::new();
        sys.refresh_processes(ProcessesToUpdate::All, true);
        Ok(entries
            .into_iter()
            .filter(|e| !is_headless_claude_run(e.pid))
            .map(|mut e| {
                e.host_app = host_app_of(&sys, e.pid);
                e
            })
            .collect())
    })
    .await
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
    let mut cmd = std::process::Command::new("claude");
    cmd.arg("-p")
        .arg("/usage")
        .stdin(std::process::Stdio::null())
        // This probe runs every few minutes in the background: it has no
        // business starting a self-update of the user's install each time
        // (interactive sessions still update as usual).
        .env("DISABLE_AUTOUPDATER", "1")
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
        // Everything it printed, not just stderr: claude often reports a
        // failure on stdout, and an empty error leaves the popover's debug
        // info with nothing to go on.
        let printed = flowcode_shared::combined_output(&output);
        return Err(format!("claude -p /usage: {}
{printed}", output.status).trim().to_string());
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
    /// Set for a session saved by Codex inside WSL: resuming it means a WSL
    /// tab in that distro, and `cwd` is a Linux path.
    #[serde(rename = "wslDistro")]
    wsl_distro: Option<String>,
    /// The thread's title in Codex (the one it generated, or the name the
    /// user gave it) - see `codex_thread_names`.
    name: Option<String>,
    /// Open right now in some terminal (see `LiveThread`) - not just saved.
    /// `startedAt` is then when it last wrote, `status` "busy"/"idle".
    live: bool,
    status: Option<String>,
    /// Running in a Flowcode tab (this app's or another instance's).
    #[serde(rename = "inFlowcode")]
    in_flowcode: bool,
}

/// Thread id -> its current name, from Codex's `session_index.jsonl` next to
/// the sessions folder: one line per naming, oldest first, so a thread's
/// latest line (a rename included) wins.
fn codex_thread_names(sessions_root: &Path) -> HashMap<String, String> {
    let Some(index) = sessions_root.parent().map(|home| home.join("session_index.jsonl")) else {
        return HashMap::new();
    };
    let Ok(file) = std::fs::File::open(index) else { return HashMap::new() };
    let mut names = HashMap::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
        if let (Some(id), Some(name)) = (
            value.get("id").and_then(|v| v.as_str()),
            value.get("thread_name").and_then(|v| v.as_str()),
        ) {
            names.insert(id.to_string(), name.to_string());
        }
    }
    names
}

fn codex_sessions_root() -> Option<PathBuf> {
    Some(crate::fs::user_home()?.join(".codex").join("sessions"))
}

/// `~/.codex/sessions` of the default WSL distro, through its
/// `\\wsl.localhost` share - where Codex keeps its sessions when it's used
/// from WSL rather than Windows. The distro's home is asked once per run.
#[cfg(target_os = "windows")]
fn wsl_codex_sessions_root() -> Option<(String, PathBuf)> {
    static HOME: std::sync::OnceLock<Option<(String, String)>> = std::sync::OnceLock::new();
    let (distro, home) = HOME
        .get_or_init(|| {
            let distro = default_wsl_distro()?;
            let home = crate::system::wsl_home_dir(distro.clone(), None)?;
            Some((distro, home))
        })
        .clone()?;
    let unc = format!(r"\\wsl.localhost\{distro}{}", home.replace('/', r"\"));
    Some((distro, PathBuf::from(unc).join(".codex").join("sessions")))
}

#[cfg(not(target_os = "windows"))]
fn wsl_codex_sessions_root() -> Option<(String, PathBuf)> {
    None
}

/// Max sessions listed in the sidebar - a project with years of history
/// shouldn't dump its entire archive there, just what's plausibly worth
/// resuming.
const MAX_CODEX_SESSIONS: usize = 8;

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
fn read_codex_session(path: &Path, started_at: Option<u64>, wsl_distro: Option<&str>) -> Option<CodexSessionEntry> {
    let file = std::fs::File::open(path).ok()?;
    let reader = BufReader::new(file);
    let mut cwd: Option<String> = None;
    let mut session_id: Option<String> = None;
    for line in reader.lines().take(20).filter_map(|l| l.ok()) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        // Current Codex: the first record is `session_meta`, whose `id` is
        // the thread `codex resume` takes (its `session_id` can name another
        // thread). Sub-agent threads (a reviewer, a spawned helper) have one
        // too, with a parent - not something to resume on its own.
        if value.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
            let payload = value.get("payload")?;
            let is_subagent = payload.get("parent_thread_id").is_some_and(|p| !p.is_null())
                || payload.get("source").and_then(|s| s.get("subagent")).is_some();
            if is_subagent {
                return None;
            }
            let id = payload.get("id").and_then(|v| v.as_str()).map(str::to_string);
            let meta_cwd = payload.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
            if let (Some(id), Some(cwd)) = (id.or_else(|| uuid_from_filename(path)), meta_cwd) {
                return Some(CodexSessionEntry {
                    cwd,
                    session_id: id,
                    started_at,
                    wsl_distro: wsl_distro.map(str::to_string),
                    name: None,
                    live: false,
                    status: None,
                    in_flowcode: false,
                });
            }
        }
        // Older layouts: no `session_meta` envelope - best-effort search.
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
    Some(CodexSessionEntry {
        cwd,
        session_id,
        started_at,
        wsl_distro: wsl_distro.map(str::to_string),
        name: None,
        live: false,
        status: None,
        in_flowcode: false,
    })
}

/// How long a scan of the WSL sessions folder is reused: every file access
/// crosses into the distro's file share, far slower than a local disk, and
/// the sidebar polls every few seconds.
const WSL_SCAN_TTL: std::time::Duration = std::time::Duration::from_secs(20);

/// Async + blocking pool: walks and opens files under `~/.codex/sessions`
/// (Windows' own, and the default WSL distro's) on every sidebar poll.
#[tauri::command]
pub async fn list_codex_sessions(fresh: Option<bool>) -> Result<Vec<CodexSessionEntry>, String> {
    crate::blocking(move || {
        static WSL_CACHE: Mutex<Option<(std::time::Instant, Vec<CodexSessionEntry>)>> = Mutex::new(None);
        let mut sessions = codex_sessions_root()
            .map(|root| scan_codex_sessions(&root, None))
            .unwrap_or_default();
        let wsl = {
            let mut cache = WSL_CACHE.lock().unwrap();
            match cache.as_ref() {
                Some((at, cached)) if at.elapsed() < WSL_SCAN_TTL && fresh != Some(true) => cached.clone(),
                _ => {
                    let fresh = wsl_codex_sessions_root()
                        .map(|(distro, root)| scan_codex_sessions(&root, Some(&distro)))
                        .unwrap_or_default();
                    *cache = Some((std::time::Instant::now(), fresh.clone()));
                    fresh
                }
            }
        };
        sessions.extend(wsl);
        sessions.sort_by_key(|s| std::cmp::Reverse(s.started_at));

        // Threads open right now go first, marked live - wherever they run -
        // and are left out of the saved ones.
        let mut live: Vec<LiveThread> = host_live_threads();
        if wsl_codex_sessions_root().is_some() {
            live.extend(wsl_live_threads(None));
        }
        sessions.retain(|s| !live.iter().any(|t| t.id == s.session_id));
        sessions.truncate(MAX_CODEX_SESSIONS);
        let mut all: Vec<CodexSessionEntry> = live
            .iter()
            .map(|t| CodexSessionEntry {
                cwd: t.cwd.clone(),
                session_id: t.id.clone(),
                started_at: t.updated_at,
                wsl_distro: t.wsl_distro.clone(),
                name: t.name.clone(),
                live: true,
                status: Some(t.status().to_string()),
                in_flowcode: t.pty_id.is_some(),
            })
            .collect();
        all.extend(sessions);
        Ok(all)
    })
    .await
}

fn scan_codex_sessions(root: &Path, wsl_distro: Option<&str>) -> Vec<CodexSessionEntry> {
    let mut files = Vec::new();
    find_rollout_files(root, 5, &mut files);

    // Sorted by mtime (one cheap stat each) *before* opening anything, so
    // only the newest few files are actually read and parsed - not the whole
    // history just to throw all but a handful away.
    let mut files: Vec<(PathBuf, Option<u64>)> = files
        .into_iter()
        .map(|p| {
            let mtime = crate::fs::system_time_to_millis(std::fs::metadata(&p).and_then(|m| m.modified()));
            (p, mtime)
        })
        .collect();
    files.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));

    let mut sessions: Vec<CodexSessionEntry> = files
        .iter()
        .filter_map(|(path, mtime)| read_codex_session(path, *mtime, wsl_distro))
        .take(MAX_CODEX_SESSIONS)
        .collect();
    if !sessions.is_empty() {
        let names = codex_thread_names(root);
        for session in &mut sessions {
            session.name = names.get(&session.session_id).cloned();
        }
    }
    sessions
}

#[cfg(test)]
mod tests {
    use super::{agent_of, read_codex_session};

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
        let entry = read_codex_session(&path, Some(1), Some("Ubuntu")).unwrap();
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
        assert!(read_codex_session(&path, None, None).is_none());
        let _ = std::fs::remove_file(path);
    }
}
