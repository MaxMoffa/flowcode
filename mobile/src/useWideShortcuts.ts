import { useEffect, useRef } from "react";

/** What a hardware shortcut does on the tablet layout; the bindings are the desktop's defaults (src/shortcuts/shortcuts.ts). */
export type WideShortcut = "newTab" | "closeTab" | "nextTab" | "prevTab" | "toggleView" | "toggleSidebar" | "toggleAgents" | "toggleBrowser" | `selectTab${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8}` | "lastTab";

/** Where the key went: the page, the terminal's hidden input, or another text field. */
export type KeyTarget = "free" | "xterm" | "editable";

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * The action a key press means, or null. Every binding is a Ctrl chord (the desktop's
 * defaults), so plain keys always reach the terminal. In another text field only Ctrl+`
 * works (the desktop's view switch is bound on the chat view itself); in the terminal's
 * input every chord does, as on the desktop where app shortcuts reach through the terminal.
 */
export function shortcutFor(e: KeyLike, target: KeyTarget): WideShortcut | null {
  if (!e.ctrlKey || e.altKey || e.metaKey) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  let action: WideShortcut | null = null;
  if (k === "`" && !e.shiftKey) action = "toggleView";
  else if (target === "editable") return null;
  else if (k === "Tab") action = e.shiftKey ? "prevTab" : "nextTab";
  else if (e.shiftKey) {
    if (k === "a") action = "toggleAgents";
    else if (k === "b") action = "toggleBrowser";
  } else if (k === "t") action = "newTab";
  else if (k === "w") action = "closeTab";
  else if (k === "b") action = "toggleSidebar";
  else if (k === "9") action = "lastTab";
  else if (/^[1-8]$/.test(k)) action = `selectTab${k}` as WideShortcut;
  return action;
}

/** The index of the tab to show after a tab-switching action, or null when it doesn't apply (no such tab). `current` is -1 when no tab of the list is shown. */
export function tabIndexFor(action: WideShortcut, count: number, current: number): number | null {
  if (count === 0) return null;
  if (action === "nextTab") return current < 0 ? 0 : (current + 1) % count;
  if (action === "prevTab") return current < 0 ? count - 1 : (current - 1 + count) % count;
  if (action === "lastTab") return count - 1;
  const m = /^selectTab(\d)$/.exec(action);
  if (!m) return null;
  const i = Number(m[1]) - 1;
  return i < count ? i : null;
}

const targetOf = (el: EventTarget | null): KeyTarget => {
  const node = el as Element | null;
  if (node?.closest?.(".xterm-helper-textarea")) return "xterm";
  const tag = node?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (node as HTMLElement | null)?.isContentEditable) return "editable";
  return "free";
};

/** Listens for the shortcuts on the window (capture phase, so the terminal doesn't swallow them first). `run` returns whether it handled the action; only then the key is cancelled. */
export function useWideShortcuts(run: (action: WideShortcut) => boolean, enabled: boolean) {
  const ref = useRef(run);
  ref.current = run;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const action = shortcutFor(e, targetOf(e.target));
      if (!action) return;
      // A held key must not close or open a pile of tabs.
      if (e.repeat && (action === "closeTab" || action === "newTab")) {
        e.preventDefault();
        return;
      }
      if (ref.current(action)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [enabled]);
}
