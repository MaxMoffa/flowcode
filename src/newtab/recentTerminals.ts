import { basename, trimTrailingSeparators } from "../lib/path";
import { createListStore } from "../lib/createListStore";

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

const store = createListStore<RecentTerminal>(
  STORAGE_KEY,
  (r): r is RecentTerminal =>
    typeof (r as RecentTerminal)?.cwd === "string" &&
    typeof (r as RecentTerminal)?.name === "string" &&
    typeof (r as RecentTerminal)?.command === "string" &&
    typeof (r as RecentTerminal)?.at === "number" &&
    ["string", "undefined"].includes(typeof (r as RecentTerminal).shell),
  MAX_RECENTS,
);

const sameEntry = (a: { cwd: string; shell?: string }, b: { cwd: string; shell?: string }) =>
  trimTrailingSeparators(a.cwd) === trimTrailingSeparators(b.cwd) && (a.shell ?? "") === (b.shell ?? "");

/** Records `command` as the latest one typed in `cwd` - one entry per
 * folder and shell, most recent first. */
export function recordRecentTerminal(cwd: string, shell: string | undefined, command: string) {
  const trimmed = command.trim();
  if (!cwd || !trimmed) return;
  const entry: RecentTerminal = { cwd, name: basename(cwd) || cwd, command: trimmed, at: Date.now(), ...(shell ? { shell } : {}) };
  store.set([entry, ...store.get().filter((r) => !sameEntry(r, entry))]);
}

export function listRecentTerminals(): RecentTerminal[] {
  return store.get();
}

export const subscribeRecentTerminals = store.subscribe;
