// The owner-window side of the context menu popup (see src-tauri/src/menu_popup.rs
// and MenuPopupRoot.tsx). A native browser view always paints above the DOM, so
// when one is live the menu is drawn in a separate transparent window instead.
import { createElement, Fragment, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { hasLiveNativeView } from "../browser/nativeLive";

export interface PopupItem {
  label: string;
  iconHtml?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
}

export interface PopupTheme {
  htmlAttrs: Record<string, string>;
  bodyClass: string;
}

export interface PopupShow {
  id: number;
  x: number;
  y: number;
  items: PopupItem[];
  theme: PopupTheme;
}

/** The popup is up this long after creation at most; past it the DOM menu is used.
 * Generous: it is normally created ahead (prewarmMenuPopup), not when a menu opens. */
const READY_TIMEOUT_MS = 2000;

interface PlainItem {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
  custom?: ReactNode;
  submenu?: unknown[];
}

/** Whether this menu can be drawn in the popup: a native view is live in this
 * window, the platform supports owned popups, and every row is a plain one. */
export function canUsePopup(items: PlainItem[]): boolean {
  const platform = document.documentElement.dataset.platform;
  return (
    (platform === "windows" || platform === "macos") &&
    hasLiveNativeView() &&
    items.every((i) => !i.custom && !i.submenu)
  );
}

const ownLabel = () => getCurrentWindow().label;
const popupLabel = () => `menu-popup-${ownLabel()}`;

let readyPromise: Promise<void> | null = null;

/** Creates the popup window once and waits for its first "ready". Rejects on failure (the caller falls back). */
function ensurePopup(): Promise<void> {
  if (readyPromise) return readyPromise;
  const p = (async () => {
    let off: UnlistenFn | undefined;
    const ready = new Promise<void>((resolve) => {
      void getCurrentWebviewWindow()
        .listen("menu-popup:ready", () => resolve())
        .then((u) => (off = u));
    });
    try {
      await invoke("menu_popup_ensure");
      // The popup may have loaded before we listened (or be a reused one): ask again.
      const ping = setInterval(() => void emitTo(popupLabel(), "menu-popup:ping").catch(() => {}), 100);
      try {
        await Promise.race([
          ready,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("menu popup not ready")), READY_TIMEOUT_MS)),
        ]);
      } finally {
        clearInterval(ping);
      }
    } finally {
      off?.();
    }
  })();
  readyPromise = p;
  // A failure is not cached: the next open tries again.
  p.catch(() => {
    if (readyPromise === p) readyPromise = null;
  });
  return p;
}

/** Creates the popup as soon as a native browser view shows up, so the first
 * menu opens at once instead of waiting for a new webview to boot. */
export function prewarmMenuPopup() {
  const platform = document.documentElement.dataset.platform;
  if (platform !== "windows" && platform !== "macos") return;
  void ensurePopup().catch(() => {});
}

/** Shows the menu in the popup at the given window-relative CSS point. Resolves false when it could not. */
export async function openPopupMenu(
  id: number,
  clientX: number,
  clientY: number,
  items: { label: string; icon?: ReactNode; danger?: boolean; disabled?: boolean; separator?: boolean; checked?: boolean }[],
): Promise<boolean> {
  try {
    await ensurePopup();
    // Loaded on first use: only windows showing a native browser view need it.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const win = getCurrentWindow();
    const [pos, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
    const htmlAttrs: Record<string, string> = {};
    for (const a of Array.from(document.documentElement.attributes)) htmlAttrs[a.name] = a.value;
    const payload: PopupShow = {
      id,
      x: pos.x + clientX * scale,
      y: pos.y + clientY * scale,
      items: items.map((i) => ({
        label: i.label,
        // Our own static svg components: nothing in them needs state or effects.
        iconHtml: i.icon ? renderToStaticMarkup(createElement(Fragment, null, i.icon)) : undefined,
        danger: i.danger,
        disabled: i.disabled,
        separator: i.separator,
        checked: i.checked,
      })),
      theme: { htmlAttrs, bodyClass: document.body.className },
    };
    await emitTo(popupLabel(), "menu-popup:show", payload);
    return true;
  } catch {
    return false;
  }
}

/** Tells the popup to close without reporting back. */
export function hidePopupMenu(id: number) {
  void emitTo(popupLabel(), "menu-popup:hide", { id }).catch(() => {});
}

/** Row picked / popup closed on its own. Returns the unlisten function. */
export async function listenPopupEvents(
  onSelect: (id: number, index: number) => void,
  onClosed: (id: number, refocus: boolean) => void,
): Promise<() => void> {
  const w = getCurrentWebviewWindow();
  const offs = await Promise.all([
    w.listen<{ id: number; index: number }>("menu-popup:select", (e) => onSelect(e.payload.id, e.payload.index)),
    w.listen<{ id: number; refocus?: boolean }>("menu-popup:closed", (e) => onClosed(e.payload.id, !!e.payload.refocus)),
  ]);
  return () => offs.forEach((off) => off());
}

/** Gives the app window back the focus the popup took. */
export function refocusOwner() {
  return getCurrentWindow().setFocus().catch(() => {});
}
