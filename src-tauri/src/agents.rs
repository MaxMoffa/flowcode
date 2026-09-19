use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use sysinfo::{Pid, ProcessesToUpdate, System};
use tauri::State;

use crate::pty::PtyState;

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
