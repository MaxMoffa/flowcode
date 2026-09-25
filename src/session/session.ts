import { invoke } from "@tauri-apps/api/core";

/** What a restart brings back (Impostazioni > Schede all'avvio): which
 * windows were open, which tabs each one had, in order, and what each
 * terminal was showing. Running programs can't survive a restart - a
 * restored terminal gets its old text replayed, then a fresh shell in the
 * same folder. */
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

/** One window's part of the session - what each window reports to the
 * backend (`session_put`, see src-tauri/src/session.rs). */
export interface SavedWindow {
  activeIndex: number;
  tabs: SavedTab[];
  /** Outer position/size in physical pixels - where a restored extra
   * window reopens. The main window keeps its own default placement. */
  bounds?: { x: number; y: number; width: number; height: number };
}

/** The file as written by session.rs; version 1 (single window) is still
 * read, as the main window's part. */
type SavedSessionFile =
  | { version: 1; activeIndex: number; tabs: SavedTab[] }
  | { version: 2; windows: SavedWindow[] };

/** The saved windows, main window first - `null` when there's nothing
 * usable (no file yet, unreadable, or an empty/foreign shape), so callers
 * just fall back to a normal fresh start. */
export async function loadSession(): Promise<SavedWindow[] | null> {
  try {
    const dir = await invoke<string>("config_dir");
    const raw = await invoke<string>("read_text_file", { path: `${dir}/session.json` });
    const parsed = JSON.parse(raw) as SavedSessionFile;
    const windows =
      parsed?.version === 1
        ? [{ activeIndex: parsed.activeIndex, tabs: parsed.tabs }]
        : parsed?.version === 2 && Array.isArray(parsed.windows)
          ? parsed.windows
          : [];
    const usable = windows.filter((w) => Array.isArray(w?.tabs) && w.tabs.length > 0);
    return usable.length > 0 ? usable : null;
  } catch {
    return null;
  }
}

/** Reports this window's part of the session - `null` (session restore
 * switched off) clears the whole file. `flushGen` answers a `session:flush`
 * request from the backend. */
export function saveWindowSession(snapshot: SavedWindow | null, flushGen?: number): Promise<void> {
  return invoke<void>("session_put", { snapshot, flushGen: flushGen ?? null });
}
