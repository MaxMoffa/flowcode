import { useEffect, useRef, useState } from "react";
import { useGitBackend } from "./gitStatus";

const POLL_MS = 15000;

/** Changes in the repository `cwd` is in, polled only while `enabled` (the sidebar - whose Git drawer reports them itself - is hidden), for the dot on the sidebar button. 0 when disabled, not a repo or failing. */
export function useGitChangeCount(cwd: string, enabled: boolean): number {
  const git = useGitBackend();
  const [count, setCount] = useState(0);
  // The repository root of each folder asked about: it rarely changes, so it is looked up once.
  const toplevelRef = useRef(new Map<string, string | null>());
  // Only the newest request may write the count: an older answer that arrives late is dropped.
  const requestRef = useRef(0);

  useEffect(() => {
    if (!enabled || !cwd) return;
    let active = true;
    let polling = false;

    const refresh = async () => {
      if (polling) return;
      polling = true;
      try {
        await refreshOnce();
      } finally {
        polling = false;
      }
    };
    const refreshOnce = async () => {
      const id = ++requestRef.current;
      const stillCurrent = () => active && id === requestRef.current;
      try {
        let root = toplevelRef.current.get(cwd);
        if (root === undefined) {
          root = await git.toplevel(cwd);
          toplevelRef.current.set(cwd, root);
        }
        if (!stillCurrent()) return;
        if (!root) {
          setCount(0);
          return;
        }
        const status = await git.status(root);
        if (!stillCurrent()) return;
        setCount(status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length);
      } catch {
        if (stillCurrent()) setCount(0);
      }
    };

    const onFocus = () => void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible" && document.hasFocus()) void refresh();
    }, POLL_MS);
    void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [cwd, enabled, git]);

  return enabled && cwd ? count : 0;
}
