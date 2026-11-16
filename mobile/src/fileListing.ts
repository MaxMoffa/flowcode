import { useEffect, useRef, useState } from "react";
import { onMessage, send, useRemoteSelector, type LsEntry } from "./remote";

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

/** Folders first, then by name. */
const byKind = (a: LsEntry, b: LsEntry) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

export const listingKey = (ptyId: string, path: string, cwd: string) => JSON.stringify([ptyId, path, cwd]);

/** The list is blanked (spinner) when the folder asked for changes, not when the same one is re-requested after a reconnect. */
export const shouldBlankListing = (previousKey: string | null, key: string) => previousKey !== key;

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
  const lastKey = useRef<string | null>(null);
  const status = useRemoteSelector((s) => s.status);
  const online = status === "online";

  // Replies of the old connection will never come.
  useEffect(() => {
    if (!online) pending.current = 0;
  }, [online]);

  useEffect(() => {
    if (!enabled) lastKey.current = null;
    if (!enabled || !online) return;
    // A `cd` (or any cwd change) moves the root under us: go back to it, which re-runs this effect.
    if (lastCwd.current !== cwd) {
      lastCwd.current = cwd;
      if (path) {
        setEntries(null);
        setPath("");
        return;
      }
    }
    // A pure reconnect re-asks for the same folder and keeps showing what was loaded.
    const key = listingKey(ptyId, path, cwd);
    if (shouldBlankListing(lastKey.current, key)) setEntries(null);
    lastKey.current = key;
    pending.current++;
    send({ t: "ls", ptyId, path });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, online, ptyId, path, cwd]);

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
