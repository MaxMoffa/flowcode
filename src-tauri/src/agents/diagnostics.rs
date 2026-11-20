//! `agent_detection_dump`: a human-readable report of what the agent detection
//! sees per terminal tab (P8 of docs/design/agent-detection-plan.md), so a tester
//! can send evidence when a bar goes missing. Only `FLOWCODE_PTY_ID` is ever read
//! from a process environment; argv items are cut short.

use super::{env_tag_fallback, find_wsl_client, probe_process, tracker, Probe};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Write as _;
use std::io::Write as _;
use sysinfo::Pid;
use tauri::Manager;

const ARGV_ITEM_MAX: usize = 200;
const SUBTREE_MAX: usize = 300;
const LOG_MAX_BYTES: u64 = 1_000_000;

fn clip(text: &str) -> String {
    if text.chars().count() <= ARGV_ITEM_MAX {
        return text.to_string();
    }
    let head: String = text.chars().take(ARGV_ITEM_MAX).collect();
    format!("{head}...")
}

fn verdict(probe: Probe) -> String {
    match probe {
        Probe::Hit(bin, _) => format!("HIT {bin}"),
        Probe::OtherFlowcode => "other-flowcode".to_string(),
        Probe::No => "no".to_string(),
    }
}

#[tauri::command]
pub async fn agent_detection_dump(app: tauri::AppHandle, pty_id: Option<String>) -> Result<String, String> {
    let sessions = super::collect_agent_sessions(&app).await?;
    let shell_pids: Vec<(String, u32)> = app
        .state::<crate::pty::PtyState>()
        .shell_pids()
        .into_iter()
        .filter(|(id, _)| pty_id.as_deref().is_none_or(|want| want == id))
        .collect();
    let log_dir = app.path().app_log_dir().ok();
    crate::blocking(move || {
        let mut out = String::new();
        let _ = writeln!(out, "=== agent detection dump @ {} ms (os {}) ===", crate::util::now_ms(), std::env::consts::OS);
        if shell_pids.is_empty() {
            let _ = writeln!(out, "no terminal tab matches");
        }
        crate::system::with_processes_mut(|sys| {
            // Raw edges (parent() as the OS reports it, stale ones included).
            let mut raw_children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            let mut live_children: HashMap<Pid, Vec<Pid>> = HashMap::new();
            for (pid, p) in sys.processes() {
                if let Some(parent) = p.parent() {
                    raw_children.entry(parent).or_default().push(*pid);
                }
                if let Some(parent) = crate::system::live_parent(sys, p) {
                    live_children.entry(parent).or_default().push(*pid);
                }
            }
            for (tab_pty, shell_pid) in &shell_pids {
                let root = Pid::from_u32(*shell_pid);
                let _ = writeln!(out, "\n--- pty {tab_pty}  shell pid {shell_pid} ---");
                let _ = writeln!(out, "subtree (pid ppid live_parent_ok start | name | exe | argv | verdict):");
                let mut queue: VecDeque<Pid> = VecDeque::from([root]);
                let mut seen: HashSet<Pid> = HashSet::new();
                while let Some(pid) = queue.pop_front() {
                    if !seen.insert(pid) {
                        continue;
                    }
                    if seen.len() > SUBTREE_MAX {
                        let _ = writeln!(out, "  ... subtree truncated at {SUBTREE_MAX} processes");
                        break;
                    }
                    let Some(p) = sys.process(pid) else {
                        let _ = writeln!(out, "  {pid} (not in process table)");
                        continue;
                    };
                    let live_ok = crate::system::live_parent(sys, p) == p.parent();
                    let argv: Vec<String> = p.cmd().iter().map(|a| clip(&a.to_string_lossy())).collect();
                    let _ = writeln!(
                        out,
                        "  {} {} {} {} | {} | {} | {:?} | {}",
                        pid,
                        p.parent().map(|x| x.to_string()).unwrap_or_else(|| "-".into()),
                        live_ok,
                        p.start_time(),
                        clip(&p.name().to_string_lossy()),
                        p.exe().map(|e| clip(&e.to_string_lossy())).unwrap_or_else(|| "-".into()),
                        argv,
                        verdict(probe_process(p, Some(pid))),
                    );
                    if let Some(kids) = raw_children.get(&pid) {
                        queue.extend(kids.iter().copied());
                    }
                }
                let _ = writeln!(out, "wsl client: {:?}", find_wsl_client(sys, root, &live_children));
                let unmatched: HashSet<String> = HashSet::from([tab_pty.clone()]);
                let found = env_tag_fallback(sys, &unmatched, &HashSet::new());
                if found.is_empty() {
                    let _ = writeln!(out, "env-tag fallback: no process tagged FLOWCODE_PTY_ID={tab_pty}");
                } else {
                    for (_, (bin, _, pid, started)) in found {
                        let _ = writeln!(out, "env-tag fallback: {bin} pid {pid} started {started:?}");
                    }
                }
                match tracker::snapshot(tab_pty) {
                    Some(t) => {
                        let _ = writeln!(out, "tracker: {} pid {} held={} misses={}", t.session.cli, t.session.pid, t.held, t.misses);
                    }
                    None => {
                        let _ = writeln!(out, "tracker: empty");
                    }
                }
                match sessions.iter().find(|s| &s.pty_id == tab_pty) {
                    Some(s) => {
                        let _ = writeln!(out, "final session: {}", serde_json::to_string(s).unwrap_or_default());
                    }
                    None => {
                        let _ = writeln!(out, "final session: none");
                    }
                }
            }
        });
        if let Some(dir) = log_dir {
            append_log(&dir, &out);
        }
        Ok(out)
    })
    .await
}

/// Appends to `<dir>/agent-detection.log`; past ~1 MB the old file becomes `.old` (one generation).
fn append_log(dir: &std::path::Path, text: &str) {
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join("agent-detection.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_MAX_BYTES) {
        let _ = std::fs::rename(&path, dir.join("agent-detection.log.old"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "{text}");
    }
}
