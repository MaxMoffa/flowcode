import { useEffect, useRef } from "react";
import { canonicalCombo, eventToShortcutString, type ShortcutAction } from "./shortcuts";
import { useShortcutsConfig } from "./ShortcutsContext";

type Handlers = Partial<Record<ShortcutAction, () => void>>;

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
