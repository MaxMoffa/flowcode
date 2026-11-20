//! Sticky agent identity per terminal tab (P1 of docs/design/agent-detection-plan.md).
//!
//! A poll can miss an agent that is still there (a stale parent edge, a process
//! caught between fork and exec, a slow WSL scan): the tab's bar would vanish
//! and come back. The last confirmed session of every pty is kept with its
//! `(pid, start time)`; what a miss does depends on what is known of that pid:
//! - still alive with the same start time: hold the session indefinitely;
//! - gone (exited, or its pid reused): drop at once - an exit is a strong negative;
//! - unknown (a pid inside WSL can't be checked from the host): two polls of grace.

use super::AgentSession;
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex};
use sysinfo::{Pid, System};

/// Consecutive polls without a detection a session of unknown liveness survives.
const MAX_MISSES: u32 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Liveness {
    Alive,
    Gone,
    Unknown,
}

#[derive(Clone)]
pub(super) struct Tracked {
    pub(super) session: AgentSession,
    pub(super) misses: u32,
    /// Whether the last poll returned this session without detecting it.
    pub(super) held: bool,
}

pub(super) type TrackerState = HashMap<String, Tracked>;

static STATE: LazyLock<Mutex<TrackerState>> = LazyLock::new(Default::default);

/// One poll of the state machine. `detected`: this poll's sessions; `live_ptys`:
/// the ptys that still exist; `liveness`: whether a stored session's process is
/// still the same one. Returns the sessions to report (detected ones, plus held ones).
pub(super) fn step(
    state: &mut TrackerState,
    detected: Vec<AgentSession>,
    live_ptys: &HashSet<String>,
    liveness: impl Fn(&AgentSession) -> Liveness,
) -> Vec<AgentSession> {
    state.retain(|pty, _| live_ptys.contains(pty));
    let mut out = Vec::with_capacity(detected.len());
    let mut seen: HashSet<String> = HashSet::new();
    for session in detected {
        seen.insert(session.pty_id.clone());
        state.insert(session.pty_id.clone(), Tracked { session: session.clone(), misses: 0, held: false });
        out.push(session);
    }
    state.retain(|pty, tracked| {
        if seen.contains(pty) {
            return true;
        }
        let keep = match liveness(&tracked.session) {
            Liveness::Alive => {
                tracked.held = true;
                true
            }
            Liveness::Gone => false,
            Liveness::Unknown => {
                tracked.misses += 1;
                tracked.held = true;
                tracked.misses < MAX_MISSES
            }
        };
        if keep {
            out.push(tracked.session.clone());
        }
        keep
    });
    out
}

/// Whether `session`'s process is still there, as the host process table sees it.
pub(super) fn host_liveness(sys: &System, session: &AgentSession) -> Liveness {
    if session.wsl_distro.is_some() {
        return Liveness::Unknown;
    }
    match sys.process(Pid::from_u32(session.pid)) {
        None => Liveness::Gone,
        Some(p) => match session.started_at {
            Some(at) if p.start_time() != 0 && p.start_time().saturating_mul(1000) != at => Liveness::Gone,
            _ => Liveness::Alive,
        },
    }
}

/// Runs `step` on the app-wide state, against the host process table.
pub(super) fn apply(detected: Vec<AgentSession>, live_ptys: &HashSet<String>) -> Vec<AgentSession> {
    // Lock order: process table, then tracker (the diagnostics dump does the same).
    crate::system::with_processes(|sys| {
        let mut state = crate::util::lock(&STATE);
        step(&mut state, detected, live_ptys, |s| host_liveness(sys, s))
    })
}

/// A copy of the tracker entry of `pty_id`, for the diagnostics dump.
pub(super) fn snapshot(pty_id: &str) -> Option<Tracked> {
    crate::util::lock(&STATE).get(pty_id).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sess(pty: &str, pid: u32, wsl: bool) -> AgentSession {
        AgentSession {
            pty_id: pty.to_string(),
            cli: "codex".into(),
            pid,
            started_at: Some(1000),
            wsl_distro: wsl.then(|| "Ubuntu".to_string()),
            ..AgentSession::default()
        }
    }

    fn ptys(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn alive_pid_is_held_indefinitely() {
        let mut st = TrackerState::new();
        let live = ptys(&["a"]);
        assert_eq!(step(&mut st, vec![sess("a", 5, false)], &live, |_| Liveness::Alive).len(), 1);
        for _ in 0..10 {
            let out = step(&mut st, vec![], &live, |_| Liveness::Alive);
            assert_eq!(out.len(), 1);
            assert_eq!(out[0].pid, 5);
        }
        assert!(st["a"].held);
    }

    #[test]
    fn gone_pid_is_dropped_at_once() {
        let mut st = TrackerState::new();
        let live = ptys(&["a"]);
        step(&mut st, vec![sess("a", 5, false)], &live, |_| Liveness::Alive);
        assert!(step(&mut st, vec![], &live, |_| Liveness::Gone).is_empty());
        assert!(st.is_empty());
        // Never resurrected afterwards.
        assert!(step(&mut st, vec![], &live, |_| Liveness::Alive).is_empty());
    }

    #[test]
    fn unknown_liveness_gets_two_polls_of_grace() {
        let mut st = TrackerState::new();
        let live = ptys(&["a"]);
        step(&mut st, vec![sess("a", 5, true)], &live, |_| Liveness::Unknown);
        assert_eq!(step(&mut st, vec![], &live, |_| Liveness::Unknown).len(), 1);
        assert!(step(&mut st, vec![], &live, |_| Liveness::Unknown).is_empty());
    }

    #[test]
    fn detection_resets_the_miss_count() {
        let mut st = TrackerState::new();
        let live = ptys(&["a"]);
        step(&mut st, vec![sess("a", 5, true)], &live, |_| Liveness::Unknown);
        step(&mut st, vec![], &live, |_| Liveness::Unknown);
        step(&mut st, vec![sess("a", 5, true)], &live, |_| Liveness::Unknown);
        assert_eq!(st["a"].misses, 0);
        assert_eq!(step(&mut st, vec![], &live, |_| Liveness::Unknown).len(), 1);
    }

    #[test]
    fn closed_pty_is_dropped_and_new_detection_replaces() {
        let mut st = TrackerState::new();
        step(&mut st, vec![sess("a", 5, false), sess("b", 6, false)], &ptys(&["a", "b"]), |_| Liveness::Alive);
        let out = step(&mut st, vec![], &ptys(&["b"]), |_| Liveness::Alive);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].pty_id, "b");
        let out = step(&mut st, vec![sess("b", 9, false)], &ptys(&["b"]), |_| Liveness::Alive);
        assert_eq!(out[0].pid, 9);
        assert_eq!(st["b"].session.pid, 9);
    }
}
