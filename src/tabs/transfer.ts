import { invoke } from "@tauri-apps/api/core";
import type { TerminalHandle, TerminalTransfer } from "../terminal/terminalTypes";
import type { EditorHandle } from "../editor/EditorView";
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

/** Detach the owned resources before moving a tab. Pending editor buffers count as edits too. */
export async function packTabTransfer(tab: AppTab, resources: {
  terminal?: Pick<TerminalHandle, "release">;
  editor?: Pick<EditorHandle, "getContent" | "isDirty">;
  pendingEditorContent?: string;
  shell?: string;
  fontSize?: number;
}): Promise<TabTransfer | null> {
  if (tab.kind === "terminal") {
    const moved = await resources.terminal?.release();
    return moved ? { tab, terminal: { ...moved, shell: resources.shell, fontSize: resources.fontSize } } : null;
  }
  if (tab.kind === "editor") {
    const editor = resources.editor;
    const pending = resources.pendingEditorContent;
    return { tab, editor: editor ? { content: editor.getContent(), dirty: editor.isDirty() } : pending !== undefined ? { content: pending, dirty: true } : undefined };
  }
  return { tab };
}

/** What a window opened by `window_open` (src-tauri/src/windows.rs) starts
 * with. */
type WindowInit = { kind: "adopt"; transfer: TabTransfer } | { kind: "restore"; window: SavedWindow };

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
