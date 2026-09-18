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
        handler();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts]);

  return shortcuts;
}
