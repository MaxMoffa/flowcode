import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Mirrors the Rust `AgentSession` struct in src-tauri/src/agents.rs field
 * for field - this app doesn't use serde's camelCase renaming anywhere
 * (see FsEntry/`is_dir` for the same convention), so these stay snake_case
 * on the wire exactly as Rust wrote them. */
export interface AgentSession {
  pty_id: string;
  cli: string;
  cli_label: string;
  pid: number;
  started_at: number | null;
  /** Set for an agent running inside WSL (then `pid` is a Linux pid). */
  wsl_distro: string | null;
  /** The agent's own working directory, when known (a Linux path in WSL). */
  cwd: string | null;
  /** The window and tab showing it - any window's, not just this one's. */
  window: string | null;
  tab_id: string | null;
  tab_label: string | null;
  tab_cwd: string | null;
  /** The agent's own session - id, name (as the CLI titled it, or as the
   * user renamed it) and "busy"/"idle" (plus "waiting", on the user, for
   * Claude Code) - when it could be read. */
  session_id: string | null;
  session_name: string | null;
  status: string | null;
}

/** Often enough for the tab strip's working/waiting indicator to feel live,
 * while a poll still refreshes the whole process table (and, for WSL tabs,
 * spawns `wsl.exe`). */
const POLL_MS = 2000;

/** The agent CLIs running in any Flowcode tab right now (see
 * `list_agent_sessions`), polled while the window is visible (or always, when `pollWhenHidden` - a minimized
 * window still has to notify) - one poll
 * shared by the tab strip and the Agents panel. `null` until the first
 * answer. `refresh` polls right away. */
export function useAgentSessions(pollWhenHidden = false): { sessions: AgentSession[] | null; refresh: () => Promise<void> } {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(
    () =>
      invoke<AgentSession[]>("list_agent_sessions")
        .then((result) => {
          if (mountedRef.current) setSessions(result);
        })
        .catch(() => {
          if (mountedRef.current) setSessions((prev) => prev ?? []);
        }),
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const interval = setInterval(() => {
      if (pollWhenHidden || document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh, pollWhenHidden]);

  return { sessions, refresh };
}

/** What a tab strip entry shows for the agent running in it. */
export interface TabAgent {
  cli: string;
  /** "busy" (working), "waiting" (on the user) or "idle". */
  state: "busy" | "waiting" | "idle";
}

export function tabAgentOf(session: AgentSession): TabAgent {
  const state = session.status === "busy" ? "busy" : session.status === "waiting" ? "waiting" : "idle";
  return { cli: session.cli, state };
}
