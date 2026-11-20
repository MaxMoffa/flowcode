//! Agent discovery inside WSL distros: one `/proc` scan per distro, shared by
//! the agents list and the Codex sessions list.

use super::*;

/// Distro launcher executables (`ubuntu2204.exe`, `debian.exe`...): stem prefixes.
const WSL_LAUNCHER_PREFIXES: &[&str] =
    &["ubuntu", "debian", "kali", "opensuse", "suse", "sles", "oracle", "alpine", "arch", "fedora", "pengwin", "almalinux", "rocky", "nixos"];

/// Pure part of `find_wsl_client`: does a process named `name` (lowercase)
/// run at `exe` (lowercase, `\` separators; `None` when unreadable) with
/// `args` act as a WSL client? `Some(distro)` when it does (`distro`: the
/// distro it targets, `None` for the default one).
fn wsl_client_of(name: &str, exe: Option<&str>, args: &[String], has_wsl_child: bool, distros: &[String]) -> Option<Option<String>> {
    if name == "wsl.exe" || name == "wsl" {
        let distro = args
            .iter()
            .position(|a| a == "-d" || a == "--distribution")
            .and_then(|i| args.get(i + 1).cloned());
        return Some(distro);
    }
    // `wslhost.exe` and friends only serve a client, they are not one.
    let stem = name.strip_suffix(".exe")?;
    if stem == "bash" {
        // Only the System32 one is WSL's; Git Bash's has the same name.
        let exe = exe?;
        let in_system = ["\\windows\\system32\\", "\\windows\\syswow64\\", "\\windows\\sysnative\\"].iter().any(|d| exe.contains(d));
        return in_system.then_some(None);
    }
    let in_apps = exe.is_some_and(|e| e.contains("\\windowsapps\\"));
    let known = WSL_LAUNCHER_PREFIXES.iter().any(|p| stem.starts_with(p));
    if (known && (in_apps || exe.is_none())) || (in_apps && has_wsl_child) {
        return Some(launcher_distro(stem, distros));
    }
    None
}

/// The distro a launcher (`ubuntu2204`) starts: the installed one whose name
/// matches it ignoring case and punctuation (`Ubuntu-22.04`), else the first
/// one starting with the stem (`ubuntu` -> `Ubuntu-24.04`), else the default.
fn launcher_distro(stem: &str, distros: &[String]) -> Option<String> {
    let norm = |s: &str| s.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
    let stem = norm(stem);
    distros
        .iter()
        .find(|d| norm(d) == stem)
        .or_else(|| distros.iter().find(|d| norm(d).starts_with(&stem)))
        .cloned()
}

/// Installed distro names, refreshed in the background (a stale or empty list
/// is returned right away - this runs under the process table's lock).
fn wsl_distro_names() -> Vec<String> {
    struct Names {
        at: Option<std::time::Instant>,
        list: Vec<String>,
        running: bool,
    }
    static NAMES: Mutex<Names> = Mutex::new(Names { at: None, list: Vec::new(), running: false });
    let mut names = lock(&NAMES);
    if !names.running && names.at.is_none_or(|at| at.elapsed() > std::time::Duration::from_secs(60)) {
        names.running = true;
        let spawned = std::thread::Builder::new().name("wsl-distros".into()).spawn(|| {
            let mut cmd = std::process::Command::new("wsl.exe");
            cmd.args(["-l", "-q"]);
            let list: Option<Vec<String>> = crate::system::run_wsl(cmd).map(|o| {
                crate::system::decode_wsl_output(&o.stdout)
                    .lines()
                    .map(|l| l.trim().trim_matches('\u{feff}').to_string())
                    .filter(|l| !l.is_empty())
                    .collect()
            });
            let mut names = lock(&NAMES);
            names.running = false;
            names.at = Some(std::time::Instant::now());
            if let Some(list) = list {
                names.list = list;
            }
        });
        if spawned.is_err() {
            names.running = false;
        }
    }
    names.list.clone()
}

/// The WSL client a tab's shell tree leads to, if any - `Some(distro)` where
/// `distro` is the `-d` it was started with (`None`: the default distro).
/// Clients: `wsl.exe`, System32's `bash.exe`, and distro launchers
/// (`ubuntu.exe`...). Whatever runs past it lives in the Linux VM, out of
/// Windows' process tree.
pub(super) fn find_wsl_client(sys: &System, root_pid: Pid, children_of: &HashMap<Pid, Vec<Pid>>) -> Option<Option<String>> {
    let mut queue: VecDeque<Pid> = VecDeque::from([root_pid]);
    let mut visited: HashSet<Pid> = HashSet::new();
    while let Some(pid) = queue.pop_front() {
        if !visited.insert(pid) {
            continue;
        }
        if let Some(process) = sys.process(pid) {
            let name = process.name().to_string_lossy().to_lowercase();
            let exe = process.exe().map(|e| e.to_string_lossy().to_lowercase().replace('/', "\\"));
            let has_wsl_child = children_of.get(&pid).is_some_and(|kids| {
                kids.iter().filter_map(|k| sys.process(*k)).any(|k| k.name().to_string_lossy().to_lowercase().starts_with("wsl"))
            });
            // The distro list is only needed (and only asked for) by launchers.
            let args: Vec<String> = process.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
            let is_launcher_like = name.ends_with(".exe") && name != "wsl.exe" && name != "bash.exe";
            let distros = if is_launcher_like { wsl_distro_names() } else { Vec::new() };
            if let Some(distro) = wsl_client_of(&name, exe.as_deref(), &args, has_wsl_child, &distros) {
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
    /// `(controlling tty, tab id)` of the tagged shells / tmux and screen
    /// clients: lets an untagged agent be tied to the tab its tty belongs to.
    ttys: Vec<(String, String)>,
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
    /// What its stdin is (`/dev/pts/3`), empty when not a terminal / unreadable.
    tty: String,
    argv: String,
}

/// Inside the distro: every process that may be an agent CLI (broad and
/// case-insensitive on purpose - `Vibe CLI`, `opencode.exe`, `.cline`, node /
/// bun / python launchers; `agent_of` makes the final call) with its tab id
/// from the environment `pty_spawn` gave it (carried across by WSLENV) and
/// its tty, the tagged shells / tmux / screen processes' tab id and tty, and
/// every rollout a Codex process has open - with Codex's daemon, that's the
/// daemon, not the `codex` in the terminal. Shell builtins except for the few
/// matching processes, so it stays fast on a busy distro. Lines:
/// `P pid comm tab-id start(s) cwd claude-json tty argv`, `T tty tab-id` and
/// `R path mtime(s)`, tab-separated.
pub(super) const WSL_SCAN: &str = r#"for d in /proc/[0-9]*; do
  read -r c < "$d/comm" 2>/dev/null || continue
  case "$c" in
    *[Cc]laude*|*[Cc]odex*|*[Vv]ibe*|*[Gg]emini*|*[Oo]pen[Cc]ode*|*[Cc]line*|.*|node|bun|deno|python*|MainThread) ;;
    bash|zsh|sh|dash|fish|tmux*|screen|SCREEN)
      id=$({ tr '\0' '\n' < "$d/environ"; } 2>/dev/null | sed -n 's/^FLOWCODE_PTY_ID=//p')
      [ -n "$id" ] && printf 'T\t%s\t%s\n' "$(readlink "$d/fd/0" 2>/dev/null)" "$id"
      continue ;;
    *) continue ;;
  esac
  p=${d#/proc/}
  case "$c" in [Cc]odex*|codex*)
    for f in "$d"/fd/*; do
      l=$(readlink "$f" 2>/dev/null) || continue
      case "$l" in */rollout-*.jsonl) printf 'R\t%s\t%s\n' "$l" "$(stat -c %Y "$l" 2>/dev/null)" ;; esac
    done ;;
  esac
  id=$({ tr '\0' '\n' < "$d/environ"; } 2>/dev/null | sed -n 's/^FLOWCODE_PTY_ID=//p')
  j=""; [ -f "$HOME/.claude/sessions/$p.json" ] && j=$(tr -d '\t\n' < "$HOME/.claude/sessions/$p.json")
  printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$p" "$c" "$id" "$(stat -c %Y "$d" 2>/dev/null)" "$(readlink "$d/cwd")" "$j" "$(readlink "$d/fd/0" 2>/dev/null)" "$(tr '\0' ' ' < "$d/cmdline")"
done"#;

/// How long one scan of a distro serves: the agents list and the Codex
/// sessions list both poll (every ~2 s), so it must outlast a poll - a caller
/// past it gets the previous scan while a new one runs in the background.
pub(super) const WSL_SCAN_REUSE: std::time::Duration = std::time::Duration::from_secs(3);
/// How long a caller with no completed scan at all waits for the first one.
const WSL_FIRST_SCAN_WAIT: std::time::Duration = std::time::Duration::from_millis(1500);

struct ScanSlot {
    key: Option<String>,
    /// When the last scan attempt finished (successful or not).
    at: Option<std::time::Instant>,
    /// The last completed scan; a failed or timed-out one never replaces it.
    scan: Option<std::sync::Arc<WslScan>>,
    running: bool,
}

static SCAN_CACHE: Mutex<Vec<ScanSlot>> = Mutex::new(Vec::new());
static SCAN_DONE: std::sync::Condvar = std::sync::Condvar::new();

/// The latest scan of `distro`. Never runs `wsl.exe` on the caller's thread:
/// scans run in a background thread (one per distro at a time), started here
/// when the last one is older than `WSL_SCAN_REUSE`. With a previous scan the
/// caller returns at once (stale by a few seconds at worst); with none yet it
/// waits up to `WSL_FIRST_SCAN_WAIT` for the in-flight one, and only then (or
/// when the last attempt failed) gets an empty scan.
pub(super) fn wsl_scan(distro: Option<&str>) -> std::sync::Arc<WslScan> {
    let key = distro.map(str::to_string);
    let find = |cache: &mut Vec<ScanSlot>| cache.iter().position(|s| s.key == key);
    let mut cache = lock(&SCAN_CACHE);
    let index = find(&mut cache).unwrap_or_else(|| {
        cache.push(ScanSlot { key: key.clone(), at: None, scan: None, running: false });
        cache.len() - 1
    });
    let slot = &mut cache[index];
    if !slot.running && slot.at.is_none_or(|at| at.elapsed() >= WSL_SCAN_REUSE) {
        slot.running = true;
        let owned = key.clone();
        let spawned = std::thread::Builder::new().name("wsl-scan".into()).spawn(move || {
            let scan = std::panic::catch_unwind(|| run_wsl_scan(owned.as_deref())).ok().flatten();
            let mut cache = lock(&SCAN_CACHE);
            if let Some(slot) = cache.iter_mut().find(|s| s.key == owned) {
                slot.running = false;
                slot.at = Some(std::time::Instant::now());
                if let Some(scan) = scan {
                    slot.scan = Some(std::sync::Arc::new(scan));
                }
            }
            drop(cache);
            SCAN_DONE.notify_all();
        });
        if spawned.is_err() {
            slot.running = false;
        }
    }
    if let Some(scan) = &slot.scan {
        return scan.clone();
    }
    if !slot.running {
        return Default::default();
    }
    let (cache, _) = SCAN_DONE
        .wait_timeout_while(cache, WSL_FIRST_SCAN_WAIT, |c| c.iter().any(|s| s.key == key && s.running && s.scan.is_none()))
        .unwrap_or_else(|e| e.into_inner());
    cache.iter().find(|s| s.key == key).and_then(|s| s.scan.clone()).unwrap_or_default()
}

/// `None` when `wsl.exe` couldn't run or timed out.
pub(super) fn run_wsl_scan(distro: Option<&str>) -> Option<WslScan> {
    let mut cmd = std::process::Command::new("wsl.exe");
    if let Some(distro) = distro {
        cmd.args(["-d", distro]);
    }
    cmd.args(["-e", "sh", "-c", WSL_SCAN]);
    let output = crate::system::run_wsl(cmd)?;
    Some(parse_wsl_scan(&crate::system::decode_wsl_output(&output.stdout)))
}

fn parse_wsl_scan(text: &str) -> WslScan {
    let mut scan = WslScan::default();
    for line in text.lines() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields[..] {
            ["R", path, mtime] => {
                if !scan.rollouts.iter().any(|(p, _)| p == path) {
                    scan.rollouts.push((path.to_string(), mtime.trim().parse().ok()));
                }
            }
            ["T", tty, id] if !tty.is_empty() && !id.is_empty() => scan.ttys.push((tty.to_string(), id.to_string())),
            ["P", pid, comm, pty_id, started, cwd, claude_json, tty, argv] => scan.procs.push(WslProc {
                pid: pid.parse().unwrap_or(0),
                comm: comm.to_string(),
                pty_id: Some(pty_id.to_string()).filter(|id| !id.is_empty()),
                started_at: started.trim().parse::<u64>().ok().map(|s| s * 1000),
                cwd: cwd.to_string(),
                claude_json: claude_json.to_string(),
                tty: tty.to_string(),
                argv: argv.to_string(),
            }),
            _ => {}
        }
    }
    scan
}

/// The agent process of each of this app's tabs (`pty_ids`) among `procs`:
/// by the tab id in its environment, else - for tmux / screen / sudo / env -i
/// that dropped it - by its tty (a terminal `/dev/pts/N`): the tab whose tagged
/// shell has that tty (never "the only tab": agents run in WSL outside
/// Flowcode too). Tagged beats tty-matched; then the oldest process wins (a
/// CLI's launcher, not its helpers).
/// Limit: an agent inside tmux sits on tmux's own pts, so
/// it stays unattributed unless something on that pts carries the tag.
fn attribute_agents<'a>(
    procs: &'a [WslProc],
    ttys: &[(String, String)],
    pty_ids: &HashSet<String>,
    is_agent: impl Fn(&WslProc) -> bool,
) -> HashMap<String, &'a WslProc> {
    let mut best: HashMap<String, (bool, &WslProc)> = HashMap::new();
    for proc_ in procs.iter().filter(|p| is_agent(p)) {
        let (pty_id, tagged) = match &proc_.pty_id {
            Some(id) if pty_ids.contains(id) => (id.clone(), true),
            // Another instance's tab.
            Some(_) => continue,
            None => {
                if !proc_.tty.starts_with("/dev/pts/") {
                    continue;
                }
                match ttys.iter().find(|(t, _)| *t == proc_.tty) {
                    Some((_, id)) if pty_ids.contains(id) => (id.clone(), false),
                    Some(_) => continue,
                    // No guess by "the only tab": the user also runs agents in WSL outside Flowcode.
                    None => continue,
                }
            }
        };
        let better = match best.get(&pty_id) {
            None => true,
            Some((was_tagged, existing)) => (tagged, std::cmp::Reverse(proc_.started_at)) > (*was_tagged, std::cmp::Reverse(existing.started_at)),
        };
        if better {
            best.insert(pty_id, (tagged, proc_));
        }
    }
    best.into_iter().map(|(id, (_, p))| (id, p)).collect()
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
pub(super) fn wsl_agents(distro: Option<&str>, pty_ids: &HashSet<String>, chat_ids: &HashSet<String>) -> Vec<AgentSession> {
    let scan = wsl_scan(distro);
    let distro_name = distro.map(str::to_string).or_else(crate::util::wsl_default_distro);

    // One process per tab: tagged first, then the oldest (see `attribute_agents`).
    let best = attribute_agents(&scan.procs, &scan.ttys, pty_ids, |p| wsl_agent_of(p).is_some());
    // Sessions already spoken for: a chat's, and what a tab is certain of; the
    // guesses below (by folder) each take one more, newest process first, so
    // two tabs in a folder never share a session.
    let mut claimed: HashSet<String> = chat_ids.clone();
    let needs_threads = best.values().any(|p| wsl_agent_of(p).is_some_and(|(bin, _)| bin != "claude" && bin != "vibe"));
    let threads: Vec<LiveThread> = if needs_threads { wsl_live_threads(distro) } else { Vec::new() };
    claimed.extend(threads.iter().filter(|t| t.pty_id.as_ref().is_some_and(|p| pty_ids.contains(p))).map(|t| t.id.clone()));
    let mut ordered: Vec<_> = best.into_iter().collect();
    ordered.sort_by_key(|(_, p)| std::cmp::Reverse(p.started_at));
    ordered
        .into_iter()
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
                if let Some(found) = distro_name.as_deref().and_then(|d| wsl_vibe_session(d, proc_, &claimed)) {
                    claimed.insert(found.0.clone());
                    session.apply_live_session(found);
                }
            } else {
                let free: Vec<&LiveThread> = threads.iter().filter(|t| !claimed.contains(&t.id)).collect();
                if let Some(thread) = threads
                    .iter()
                    .find(|t| t.pty_id.as_deref() == Some(session.pty_id.as_str()))
                    .or_else(|| thread_in(&free, &proc_.cwd))
                {
                    claimed.insert(thread.id.clone());
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
pub(super) fn wsl_vibe_session(distro: &str, proc_: &WslProc, skip: &HashSet<String>) -> Option<(String, Option<String>, &'static str)> {
    let home = crate::util::wsl_home(distro)?;
    let root = wsl_unc(distro, &format!("{}/.vibe/logs/session", home.trim_end_matches('/')));
    crate::vibe::live_session_under(&root, &proc_.cwd, proc_.started_at, skip)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn proc_(pid: u32, comm: &str, pty: Option<&str>, started: u64, tty: &str) -> WslProc {
        WslProc {
            pid,
            comm: comm.into(),
            pty_id: pty.map(str::to_string),
            started_at: Some(started),
            cwd: "/home/u".into(),
            claude_json: String::new(),
            tty: tty.into(),
            argv: comm.into(),
        }
    }
    fn ids(list: &[&str]) -> HashSet<String> {
        list.iter().map(|s| s.to_string()).collect()
    }
    fn is_claude(p: &WslProc) -> bool {
        p.comm == "claude"
    }
    fn distros() -> Vec<String> {
        vec!["Debian".into(), "Ubuntu-22.04".into(), "Ubuntu-24.04".into()]
    }

    #[test]
    fn client_detection() {
        let none: Vec<String> = Vec::new();
        let args: Vec<String> = ["wsl.exe", "-d", "Debian"].iter().map(|s| s.to_string()).collect();
        assert_eq!(wsl_client_of("wsl.exe", None, &args, false, &none), Some(Some("Debian".into())));
        assert_eq!(wsl_client_of("wsl.exe", None, &none, false, &none), Some(None));
        assert_eq!(wsl_client_of("wslhost.exe", None, &none, false, &none), None);
        assert_eq!(wsl_client_of("bash.exe", Some(r"c:\windows\system32\bash.exe"), &none, false, &none), Some(None));
        assert_eq!(wsl_client_of("bash.exe", Some(r"c:\program files\git\usr\bin\bash.exe"), &none, false, &none), None);
        assert_eq!(wsl_client_of("bash.exe", None, &none, false, &none), None);
        let apps = r"c:\users\u\appdata\local\microsoft\windowsapps\ubuntu2204.exe";
        assert_eq!(wsl_client_of("ubuntu2204.exe", Some(apps), &none, false, &distros()), Some(Some("Ubuntu-22.04".into())));
        assert_eq!(wsl_client_of("ubuntu.exe", Some(apps), &none, false, &distros()), Some(Some("Ubuntu-22.04".into())));
        assert_eq!(wsl_client_of("kali.exe", Some(apps), &none, false, &distros()), Some(None));
        assert_eq!(wsl_client_of("archiver.exe", Some(r"c:\tools\archiver.exe"), &none, false, &none), None);
        // Unknown launcher under WindowsApps, recognised by its wsl child.
        assert_eq!(wsl_client_of("mydistro.exe", Some(apps), &none, true, &none), Some(None));
        assert_eq!(wsl_client_of("mydistro.exe", Some(apps), &none, false, &none), None);
        assert_eq!(wsl_client_of("node.exe", Some(r"c:\nodejs\node.exe"), &none, false, &none), None);
    }

    #[test]
    fn launcher_distro_matching() {
        assert_eq!(launcher_distro("debian", &distros()), Some("Debian".into()));
        assert_eq!(launcher_distro("ubuntu2404", &distros()), Some("Ubuntu-24.04".into()));
        assert_eq!(launcher_distro("kali", &distros()), None);
    }

    #[test]
    fn parses_scan_output() {
        let text = "R\t/h/.codex/sessions/rollout-1.jsonl\t100\n\
                    T\t/dev/pts/1\ttab-a\n\
                    T\t\ttab-b\n\
                    P\t42\tVibe CLI\t\t1000\t/home/u\t\t/dev/pts/2\tVibe CLI\n\
                    P\t43\tclaude\ttab-a\t2000\t/home/u\t{}\t\tclaude --x\n";
        let scan = parse_wsl_scan(text);
        assert_eq!(scan.rollouts.len(), 1);
        assert_eq!(scan.ttys, vec![("/dev/pts/1".to_string(), "tab-a".to_string())]);
        assert_eq!(scan.procs.len(), 2);
        assert_eq!(scan.procs[0].comm, "Vibe CLI");
        assert_eq!(scan.procs[0].pty_id, None);
        assert_eq!(scan.procs[0].tty, "/dev/pts/2");
        assert_eq!(scan.procs[0].started_at, Some(1_000_000));
        assert_eq!(scan.procs[1].pty_id.as_deref(), Some("tab-a"));
    }

    #[test]
    fn tagged_agent_beats_untagged_and_oldest_wins() {
        let procs = [
            proc_(1, "claude", None, 10, "/dev/pts/1"),
            proc_(2, "claude", Some("a"), 50, "/dev/pts/1"),
            proc_(3, "claude", Some("a"), 40, "/dev/pts/1"),
            proc_(4, "claude", Some("other"), 5, "/dev/pts/9"),
        ];
        let got = attribute_agents(&procs, &[], &ids(&["a"]), is_claude);
        assert_eq!(got.len(), 1);
        assert_eq!(got["a"].pid, 3);
    }

    #[test]
    fn untagged_agent_never_guessed_for_single_tab() {
        let procs = [proc_(1, "claude", None, 10, "/dev/pts/3")];
        assert!(attribute_agents(&procs, &[], &ids(&["a"]), is_claude).is_empty());
        let piped = [proc_(1, "claude", None, 10, "pipe:[123]")];
        assert!(attribute_agents(&piped, &[], &ids(&["a"]), is_claude).is_empty());
        let no_tty = [proc_(1, "claude", None, 10, "")];
        assert!(attribute_agents(&no_tty, &[], &ids(&["a"]), is_claude).is_empty());
    }

    #[test]
    fn untagged_agent_matched_by_tty() {
        let procs = [proc_(1, "claude", None, 10, "/dev/pts/4"), proc_(2, "claude", None, 11, "/dev/pts/7")];
        let ttys = vec![("/dev/pts/4".to_string(), "b".to_string()), ("/dev/pts/9".to_string(), "other".to_string())];
        let got = attribute_agents(&procs, &ttys, &ids(&["a", "b"]), is_claude);
        assert_eq!(got.len(), 1);
        assert_eq!(got["b"].pid, 1);
        // Several tabs and an unknown tty: left alone. A tty of another instance's tab too.
        let other = [proc_(3, "claude", None, 10, "/dev/pts/9")];
        assert!(attribute_agents(&other, &ttys, &ids(&["a", "b"]), is_claude).is_empty());
        assert!(attribute_agents(&other, &ttys, &ids(&["a"]), is_claude).is_empty());
    }
}
