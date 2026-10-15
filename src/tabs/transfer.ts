import { invoke } from "@tauri-apps/api/core";
import type { TerminalTransfer } from "../terminal/Terminal";
import type { SavedWindow } from "../session/session";
import type { AppTab } from "./types";

/** A tab on its way to another window: what the receiving window needs to
 * rebuild it - for a terminal its still-running session (see
 * `TerminalHandle.release`), for an editor any unsaved text. */
export interface TabTransfer {
  tab: AppTab;
  terminal?: TerminalTransfer & { shell?: string; fontSize?: number };
  editor?: { content: string; dirty: boolean };
  /** Where it was dropped in the receiving window (CSS px), when it was
   * dropped onto one - picks its slot in that window's tab strip. */
  drop?: { x: number; y: number };
}

/** What a window opened by `window_open` (src-tauri/src/windows.rs) starts
 * with. */
export type WindowInit = { kind: "adopt"; transfer: TabTransfer } | { kind: "restore"; window: SavedWindow };

/** Mirrors `CursorTarget` in src-tauri/src/windows.rs. */
export interface CursorTarget {
  label: string | null;
  x: number;
  y: number;
}

// Taken once per page load, not per effect run: the backend hands it out
// only once, and a remounted effect (StrictMode in dev) must see it too.
let windowInitPromise: Promise<WindowInit | null> | null = null;
export function takeWindowInit(): Promise<WindowInit | null> {
  windowInitPromise ??= invoke<WindowInit | null>("window_take_init").catch(() => null);
  return windowInitPromise;
}

/** Where in this window's tab strip a tab dropped at (x, y) goes - `undefined`
 * (the end) when it wasn't dropped over the strip. */
export function tabStripDropIndex(drop: { x: number; y: number } | undefined): number | undefined {
  const strip = document.querySelector(".tab-strip")?.getBoundingClientRect();
  if (!drop || !strip || drop.y < strip.top - 30 || drop.y > strip.bottom + 30) return undefined;
  return Array.from(document.querySelectorAll(".tab-strip-viewport > .term-tab")).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.left + r.width / 2 < drop.x;
  }).length;
}
