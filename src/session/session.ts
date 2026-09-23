import { invoke } from "@tauri-apps/api/core";

/** What a restart brings back (Impostazioni > Schede all'avvio): which tabs
 * were open, in order, and what each terminal was showing. Running programs
 * can't survive a restart - a restored terminal gets its old text replayed,
 * then a fresh shell in the same folder. */
export type SavedTab =
  | {
      kind: "terminal";
      cwd: string;
      label: string;
      customLabel?: boolean;
      /** `pty_spawn` shell id when the tab was opened with a specific one
       * (e.g. "wsl"), otherwise the configured default applies. */
      shell?: string;
      /** xterm serialize-addon output: text plus colors/styles, replayed
       * verbatim into the new terminal. */
      content?: string;
    }
  | { kind: "editor"; path: string; label: string }
  | { kind: "settings" };

export interface SavedSession {
  version: 1;
  activeIndex: number;
  tabs: SavedTab[];
}

async function sessionPath(): Promise<string> {
  const dir = await invoke<string>("config_dir");
  return `${dir}/session.json`;
}

/** `null` when there's nothing usable - no file yet, unreadable, or an
 * empty/foreign shape - so callers just fall back to a normal fresh start. */
export async function loadSession(): Promise<SavedSession | null> {
  try {
    const raw = await invoke<string>("read_text_file", { path: await sessionPath() });
    const parsed = JSON.parse(raw) as SavedSession;
    if (parsed?.version !== 1 || !Array.isArray(parsed.tabs) || parsed.tabs.length === 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveSession(session: SavedSession | null): Promise<void> {
  const contents = session ? JSON.stringify(session) : "{}";
  await invoke("write_text_file", { path: await sessionPath(), contents });
}
