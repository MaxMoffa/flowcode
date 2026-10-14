//! Agent discovery inside WSL distros: one `/proc` scan per distro, shared by
//! the agents list and the Codex sessions list.

use super::*;

/// The WSL client a tab's shell tree leads to, if any - `Some(distro)` where
/// `distro` is the `-d` it was started with (`None`: the default distro).
/// Whatever runs past it lives in the Linux VM, out of Windows' process tree.
pub(super) fn find_wsl_client(sys: &System, root_pid: Pid, children_of: &HashMap<Pid, Vec<Pid>>) -> Option<Option<String>> {
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

/// Everything the agents panel needs from inside one WSL distro, read in one
/// `wsl.exe` call (see `WSL_SCAN`).
#[derive(Default)]
pub(super) struct WslScan {
    procs: Vec<WslProc>,
    /// Rollout files some Codex process holds open, with their mtime (s).
    rollouts: Vec<(String, Option<u64>)>,
}

pub(super) struct WslProc {
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
pub(super) const WSL_SCAN: &str = r#"for d in /proc/[0-9]*; do
  read -r c < "$d/comm" 2>/dev/null || continue
  case "$c" in claude|codex|codex-*|vibe|vibe-*|node|MainThread) ;; *) continue ;; esac
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
pub(super) const WSL_SCAN_REUSE: std::time::Duration = std::time::Duration::from_millis(1500);

pub(super) fn wsl_scan(distro: Option<&str>) -> std::sync::Arc<WslScan> {
    struct Slot {
        key: Option<String>,
        at: Option<std::time::Instant>,
        scan: std::sync::Arc<WslScan>,
        running: bool,
    }
    static CACHE: Mutex<Vec<Slot>> = Mutex::new(Vec::new());
    let key = distro.map(str::to_string);
    // The lock is not held across the scan (a slow or wedged wsl.exe must not
    // stall every other caller): while one is in flight, others get the last
    // result instead of starting another wsl.exe.
    {
        let mut cache = lock(&CACHE);
        let index = cache.iter().position(|s| s.key == key).unwrap_or_else(|| {
            cache.push(Slot { key: key.clone(), at: None, scan: Default::default(), running: false });
            cache.len() - 1
        });
        let slot = &mut cache[index];
        if slot.running || slot.at.is_some_and(|at| at.elapsed() < WSL_SCAN_REUSE) {
            return slot.scan.clone();
        }
        slot.running = true;
    }
    let guard = crate::util::OnDrop::new(|| {
        if let Some(slot) = lock(&CACHE).iter_mut().find(|s| s.key == key) {
            slot.running = false;
        }
    });
    let scan = run_wsl_scan(distro);
    guard.defuse();
    let mut cache = lock(&CACHE);
    let Some(slot) = cache.iter_mut().find(|s| s.key == key) else { return Default::default() };
    slot.running = false;
    slot.at = Some(std::time::Instant::now());
    // A timed-out scan keeps the last result.
    if let Some(scan) = scan {
        slot.scan = std::sync::Arc::new(scan);
    }
    slot.scan.clone()
}

/// `None` when `wsl.exe` couldn't run or timed out.
pub(super) fn run_wsl_scan(distro: Option<&str>) -> Option<WslScan> {
    let mut cmd = std::process::Command::new("wsl.exe");
    if let Some(distro) = distro {
        cmd.args(["-d", distro]);
    }
    cmd.args(["-e", "sh", "-c", WSL_SCAN]);
    let output = crate::system::run_wsl(cmd)?;
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
    Some(scan)
}

/// The agent CLI a Linux process runs as the user's own session - not
/// Codex's background daemon or its helpers.
pub(super) fn wsl_agent_of(proc_: &WslProc) -> Option<(&'static str, &'static str)> {
    if proc_.argv.contains(" app-server") || proc_.comm.starts_with("codex-code") {
        return None;
    }
    agent_of(&proc_.comm, &proc_.argv)
}

/// Codex threads open right now inside the distro: a rollout some Codex
/// process holds, worked on by a `codex` session running in that same folder
/// (the daemon can keep a thread loaded after its terminal is gone).
pub(super) fn wsl_live_threads(distro: Option<&str>) -> Vec<LiveThread> {
    // Scanning would boot a stopped WSL VM.
    if !crate::util::wsl_running() {
        return Vec::new();
    }
    let Some(distro_name) = distro.map(str::to_string).or_else(crate::util::wsl_default_distro) else { return Vec::new() };
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
                turn_open: rollout_turn_open(&wsl_unc(&distro_name, path)),
                wsl_distro: Some(distro_name.clone()),
                pty_id: terminal.pty_id.clone(),
                profile: None,
            })
        })
        .collect()
}

/// The agents running inside a WSL distro in this app's tabs (`pty_ids`).
pub(super) fn wsl_agents(distro: Option<&str>, pty_ids: &HashSet<String>) -> Vec<AgentSession> {
    let scan = wsl_scan(distro);
    let distro_name = distro.map(str::to_string).or_else(crate::util::wsl_default_distro);
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
                // Its own registry entry - the same kind a Windows session's
                // is read from (see `claude_registry_entry`).
                if let Ok(entry) = serde_json::from_str::<serde_json::Value>(&proc_.claude_json) {
                    session.apply_claude_entry(&entry);
                }
            } else if bin == "vibe" {
                // Vibe's sessions inside the distro, through its file share.
                if let Some(found) = distro_name.as_deref().and_then(|d| wsl_vibe_session(d, proc_)) {
                    session.apply_vibe_session(found);
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

/// The Vibe session a `vibe` inside WSL works on - read from `~/.vibe` of
/// the distro's default user (its home asked once, retried if it failed), through the
/// distro's file share.
pub(super) fn wsl_vibe_session(distro: &str, proc_: &WslProc) -> Option<(String, Option<String>, &'static str)> {
    let home = crate::util::wsl_home(distro)?;
    let root = wsl_unc(distro, &format!("{}/.vibe/logs/session", home.trim_end_matches('/')));
    crate::vibe::live_session_under(&root, &proc_.cwd, proc_.started_at)
}

/// `~/.codex/sessions` of the default WSL distro, through its
/// `\\wsl.localhost` share - where Codex keeps its sessions when it's used
/// from WSL rather than Windows.
pub(super) fn wsl_codex_sessions_root() -> Option<(String, PathBuf)> {
    let (distro, home) = crate::util::wsl_default_home()?;
    let root = wsl_unc(&distro, &home).join(".codex").join("sessions");
    Some((distro, root))
}

/// How long a scan of the WSL sessions folder is reused: every file access
/// crosses into the distro's file share, far slower than a local disk, and
/// the sidebar polls every few seconds.
pub(super) const WSL_SCAN_TTL: std::time::Duration = std::time::Duration::from_secs(20);
