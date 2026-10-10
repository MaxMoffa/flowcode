import { useEffect, useRef } from "react";
import { canonicalCombo, eventToShortcutString, type ShortcutAction } from "./shortcuts";
import { useShortcutsConfig } from "./ShortcutsContext";

type Handlers = Partial<Record<ShortcutAction, () => void>>;

/** Whether the key event comes from inside an xterm.js terminal. */
function inTerminal(e: KeyboardEvent): boolean {
  return e.target instanceof Element && e.target.closest(".xterm") !== null;
}

/** Ctrl+<letter> or Ctrl+Alt+<letter>, no Shift/Meta. */
function isTerminalControlKey(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.shiftKey && !e.metaKey && /^Key[A-Z]$/.test(e.code);
}

export function useShortcuts(handlers: Handlers) {
  const { shortcuts, suspended } = useShortcutsConfig();
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (suspended) return;
    const byKey = new Map<string, ShortcutAction>();
    for (const [action, combo] of Object.entries(shortcuts)) {
      if (combo) byKey.set(canonicalCombo(combo), action as ShortcutAction);
    }

    function onKeyDown(e: KeyboardEvent) {
      const action = byKey.get(canonicalCombo(eventToShortcutString(e)));
      const handler = action && handlersRef.current[action];
      // In a terminal, Ctrl+letter (and Ctrl+Alt+letter) without Shift is a
      // control character the running program reads - ^W deletes a word, ^K
      // kills the line, ^T/^B are Claude Code / tmux keys - so those go to the
      // terminal instead of the app. Everything else (Ctrl+Tab, Ctrl+digit,
      // Shift combos, F-keys) stays an app shortcut there too.
      if (handler && inTerminal(e) && isTerminalControlKey(e)) return;
      if (handler) {
        e.preventDefault();
        e.stopPropagation();
        handler();
      }
    }

    // Capture phase: xterm.js cancels (preventDefault + stopPropagation) every
    // keydown it turns into terminal input - Ctrl+K becomes ^K, Ctrl+W ^W -
    // so a bubbling listener never sees app shortcuts while a terminal has
    // focus, which is most of the time.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [shortcuts, suspended]);

  return shortcuts;
}
