import { useEffect, useRef, useState } from "react";
import { gitRequest } from "./gitRemote";
import type { GitStatus } from "./gitTypes";

const POLL_MS = 15000;

/** Changes in the repository `cwd` is in, polled only while `enabled` (the sidebar, whose Git dock reports them itself, is hidden), for the dot on the sidebar button. 0 when disabled, not a repo or failing. */
export function useGitChangeCount(cwd: string | null, enabled: boolean): number {
  const [count, setCount] = useState(0);
  // The repository root of each folder asked about: it rarely changes, so it is looked up once.
  const toplevelRef = useRef(new Map<string, string | null>());
  // Only the newest request may write the count.
  const requestRef = useRef(0);

  useEffect(() => {
    if (!enabled || !cwd) return;
    let active = true;
    const refresh = async () => {
      const id = ++requestRef.current;
      const current = () => active && id === requestRef.current;
      try {
        let root = toplevelRef.current.get(cwd);
        if (root === undefined) {
          root = await gitRequest<string | null>({ op: "toplevel", path: cwd });
          toplevelRef.current.set(cwd, root);
        }
        if (!current()) return;
        if (!root) return setCount(0);
        const s = await gitRequest<GitStatus>({ op: "status", root });
        if (current()) setCount(s.staged.length + s.unstaged.length + s.untracked.length + s.conflicted.length);
      } catch {
        if (current()) setCount(0);
      }
    };
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [cwd, enabled]);

  return enabled && cwd ? count : 0;
}
