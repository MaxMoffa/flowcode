import { basename, trimTrailingSeparators } from "../lib/path";
import { readJson, writeString } from "../lib/storage";

const STORAGE_KEY = "flowcode.recentTerminals";
const MAX_RECENTS = 8;

/** A folder a terminal recently worked in, with the last command typed
 * there - shown on the new tab page so that terminal can be reopened (same
 * folder, same shell) and that command run again. */
export interface RecentTerminal {
  cwd: string;
  name: string;
  /** `pty_spawn` shell id of the terminal the command was typed in, when it
   * wasn't the configured default. */
  shell?: string;
  command: string;
  /** Epoch milliseconds of the last command. */
  at: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

function readFromStorage(): RecentTerminal[] {
  return readJson(STORAGE_KEY, isArray, []).filter(
    (r): r is RecentTerminal =>
      typeof (r as RecentTerminal)?.cwd === "string" &&
      typeof (r as RecentTerminal)?.name === "string" &&
      typeof (r as RecentTerminal)?.command === "string" &&
      typeof (r as RecentTerminal)?.at === "number" &&
      ["string", "undefined"].includes(typeof (r as RecentTerminal).shell),
  );
}

// Same single-cached-reference rule as favoritesStore: `useSyncExternalStore`
// needs `getSnapshot` to return the same array until something changes.
let cache: RecentTerminal[] = readFromStorage();

const sameEntry = (a: { cwd: string; shell?: string }, b: { cwd: string; shell?: string }) =>
  trimTrailingSeparators(a.cwd) === trimTrailingSeparators(b.cwd) && (a.shell ?? "") === (b.shell ?? "");

/** Records `command` as the latest one typed in `cwd` - one entry per
 * folder and shell, most recent first. */
export function recordRecentTerminal(cwd: string, shell: string | undefined, command: string) {
  const trimmed = command.trim();
  if (!cwd || !trimmed) return;
  const entry: RecentTerminal = { cwd, name: basename(cwd) || cwd, command: trimmed, at: Date.now(), ...(shell ? { shell } : {}) };
  cache = [entry, ...cache.filter((r) => !sameEntry(r, entry))].slice(0, MAX_RECENTS);
  writeString(STORAGE_KEY, JSON.stringify(cache));
  listeners.forEach((l) => l());
}

export function listRecentTerminals(): RecentTerminal[] {
  return cache;
}

export function subscribeRecentTerminals(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
