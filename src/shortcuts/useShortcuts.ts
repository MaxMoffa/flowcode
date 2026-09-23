import { useEffect, useRef, useState } from "react";
import { eventToShortcutString, loadShortcuts, type ShortcutAction, type ShortcutMap } from "./shortcuts";

type Handlers = Partial<Record<ShortcutAction, () => void>>;

export function useShortcuts(handlers: Handlers) {
  const [shortcuts, setShortcuts] = useState<ShortcutMap>({});
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let cancelled = false;
    loadShortcuts().then((map) => {
      if (!cancelled) setShortcuts(map);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const byKey = new Map<string, ShortcutAction>();
    for (const [action, combo] of Object.entries(shortcuts)) {
      byKey.set(combo, action as ShortcutAction);
    }

    function onKeyDown(e: KeyboardEvent) {
      const combo = eventToShortcutString(e);
      const action = byKey.get(combo);
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
  }, [shortcuts]);

  return shortcuts;
}
