import { invoke } from "@tauri-apps/api/core";
import { readJson, writeString } from "../lib/storage";
import { sameShell } from "../terminal/wslPath";

const STORAGE_KEY = "flowcode.commandHistory";
const MAX_ENTRIES = 500;

/** A command typed at a shell prompt in one of the app's terminals, and the
 * `pty_spawn` shell id it was typed in (`undefined` = the configured
 * default) - what the New Tab prompt's up arrow walks for shells that keep
 * no history file of their own (cmd) or whose one is costly to reach (WSL). */
interface HistoryEntry {
  command: string;
  shell?: string;
}

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

let cache: HistoryEntry[] | null = null;

function entries(): HistoryEntry[] {
  cache ??= readJson(STORAGE_KEY, isArray, []).filter(
    (e): e is HistoryEntry =>
      typeof (e as HistoryEntry)?.command === "string" && ["string", "undefined"].includes(typeof (e as HistoryEntry).shell),
  );
  return cache;
}

/** Appends `command`, oldest first - skipping a straight repeat of the last
 * one, like a shell's own history does. */
export function recordCommand(shell: string | undefined, command: string) {
  const trimmed = command.trim();
  if (!trimmed) return;
  const list = entries();
  const last = list[list.length - 1];
  if (last && last.command === trimmed && (last.shell ?? "") === (shell ?? "")) return;
  cache = [...list, { command: trimmed, ...(shell ? { shell } : {}) }].slice(-MAX_ENTRIES);
  writeString(STORAGE_KEY, JSON.stringify(cache));
}

/** What the up arrow walks for `shell` (an id, `"system"` for the default),
 * oldest first: PowerShell's own saved history - exactly what its up arrow
 * shows in a fresh session, commands typed elsewhere included - otherwise
 * the commands typed in this app's terminals running that shell. */
export async function historyFor(shell: string, powershell: boolean): Promise<string[]> {
  if (powershell) {
    const saved = await invoke<string[]>("powershell_history").catch(() => [] as string[]);
    if (saved.length > 0) return saved;
  }
  return entries()
    .filter((e) => sameShell(e.shell ?? "system", shell))
    .map((e) => e.command);
}
