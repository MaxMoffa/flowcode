import { useEffect, useRef, useState } from "react";
import { onMessage, send, useRemoteSelector, type LsEntry } from "./remote";

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Folders first, then by name. */
const byKind = (a: LsEntry, b: LsEntry) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * The entries of `path` (relative to the tab's `cwd`) while `enabled`; null while loading.
 * A `cd` moves the root under us, so `setPath("")` is called when `cwd` changes.
 */
export function useListing({ ptyId, cwd, path, setPath, enabled }: { ptyId: string; cwd: string; path: string; setPath: (p: string) => void; enabled: boolean }): LsEntry[] | null {
  const [entries, setEntries] = useState<LsEntry[] | null>(null);
  // Listings asked for and not answered yet: only the last reply is current,
  // and a symlinked folder answers with another path than the one requested.
  const pending = useRef(0);
  const lastCwd = useRef(cwd);

  useEffect(() => {
    if (!enabled) return;
    setEntries(null);
    // A `cd` (or any cwd change) moves the root under us: go back to it, which re-runs this effect.
    if (lastCwd.current !== cwd) {
      lastCwd.current = cwd;
      if (path) {
        setPath("");
        return;
      }
    }
    pending.current++;
    send({ t: "ls", ptyId, path });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ptyId, path, cwd]);

  // Replies of the old connection will never come.
  const status = useRemoteSelector((s) => s.status);
  useEffect(() => {
    if (status !== "online") pending.current = 0;
  }, [status]);

  useEffect(
    () =>
      onMessage((m) => {
        if (m.t === "ls" && m.ptyId === ptyId && pending.current > 0) {
          if (--pending.current === 0) setEntries([...m.entries].sort(byKind));
        }
        // A refused folder (outside the sandbox, gone...) would otherwise spin forever.
        else if (m.t === "error" && m.ptyId === ptyId) {
          if (pending.current > 0) pending.current--;
          if (pending.current === 0) setEntries((e) => e ?? []);
        }
      }),
    [ptyId],
  );

  return entries;
}
