import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentTools, SessionUsage } from "./insightMath";

/** `undefined`: not read yet, `null`: couldn't be. */
export type Loaded<T> = T | null | undefined;

/** Runs `load` now and then every `ms` while `enabled`; the result resets when
 * `key` changes. Polling stops while the window is hidden. */
export function usePolled<T>(load: () => Promise<T>, key: string, ms: number, enabled: boolean): Loaded<T> {
  const [value, setValue] = useState<Loaded<T>>(undefined);
  useEffect(() => {
    setValue(undefined);
    if (!enabled) return;
    let alive = true;
    const run = () =>
      load().then(
        (v) => alive && setValue(v),
        () => alive && setValue(null),
      );
    void run();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void run();
    }, ms);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // `key` stands for everything `load` closes over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ms, enabled]);
  return value;
}

interface AgentRef {
  cli: string;
  sessionId: string | null;
  profile: string | null;
}

export function useSessionUsage(agent: AgentRef, enabled: boolean): Loaded<SessionUsage> {
  const { cli, sessionId, profile } = agent;
  return usePolled(
    () => invoke<SessionUsage>("agent_session_usage", { cli, sessionId, profile }),
    `${cli}|${sessionId}|${profile}`,
    10_000,
    enabled && !!sessionId,
  );
}

/** The agent's MCP servers, skills and memory files for a folder - read when
 * `enabled` turns on and when the agent or folder changes, or on `reload`. */
export function useAgentTools(cli: string, cwd: string, profile: string | null, enabled: boolean) {
  const [tools, setTools] = useState<Loaded<AgentTools>>(undefined);
  const [nonce, setNonce] = useState(0);
  const supported = cli === "claude" || cli === "codex";
  useEffect(() => {
    setTools(undefined);
    if (!enabled || !supported) return;
    let alive = true;
    invoke<AgentTools>("agent_tools", { cli, cwd, profile }).then(
      (v) => alive && setTools(v),
      () => alive && setTools(null),
    );
    return () => {
      alive = false;
    };
  }, [enabled, supported, cli, cwd, profile, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { tools, supported, reload };
}
