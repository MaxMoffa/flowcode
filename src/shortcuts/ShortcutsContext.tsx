import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  FALLBACK_DEFAULTS,
  SHORTCUT_ACTIONS,
  loadShortcutDefaults,
  loadShortcutOverrides,
  saveShortcutOverrides,
  type ShortcutAction,
  type ShortcutMap,
} from "./shortcuts";

interface ShortcutsValue {
  /** The combo bound to each action ("" = unassigned). */
  shortcuts: ShortcutMap;
  defaults: ShortcutMap;
  /** `combo` "" unassigns the action. */
  setShortcut: (action: ShortcutAction, combo: string) => void;
  resetShortcut: (action: ShortcutAction) => void;
  resetAll: () => void;
  /** While true the global handler ignores every key - set by the settings
   * recorder, which needs to see combos that would otherwise run. */
  suspended: boolean;
  setSuspended: (suspended: boolean) => void;
}

const ShortcutsCtx = createContext<ShortcutsValue | null>(null);

export function useShortcutsConfig(): ShortcutsValue {
  const ctx = useContext(ShortcutsCtx);
  if (!ctx) throw new Error("useShortcutsConfig must be used within ShortcutsProvider");
  return ctx;
}

/** Keeps only the actions that differ from their default - the file the user
 * can open from Settings then reads as "what I changed". */
function diffFromDefaults(shortcuts: ShortcutMap, defaults: ShortcutMap): ShortcutMap {
  const overrides: ShortcutMap = {};
  for (const action of SHORTCUT_ACTIONS) {
    if (shortcuts[action] !== defaults[action]) overrides[action] = shortcuts[action] ?? "";
  }
  return overrides;
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
  const [defaults, setDefaults] = useState<ShortcutMap>(FALLBACK_DEFAULTS);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(FALLBACK_DEFAULTS);
  const [suspended, setSuspended] = useState(false);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;

  useEffect(() => {
    let cancelled = false;
    Promise.all([loadShortcutDefaults(), loadShortcutOverrides()]).then(([d, overrides]) => {
      if (cancelled) return;
      setDefaults(d);
      setShortcuts({ ...d, ...overrides });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const commit = useCallback((next: ShortcutMap) => {
    setShortcuts(next);
    saveShortcutOverrides(diffFromDefaults(next, defaultsRef.current)).catch(() => {});
  }, []);

  const value = useMemo<ShortcutsValue>(
    () => ({
      shortcuts,
      defaults,
      setShortcut: (action, combo) => commit({ ...shortcuts, [action]: combo }),
      resetShortcut: (action) => commit({ ...shortcuts, [action]: defaults[action] ?? "" }),
      resetAll: () => commit({ ...defaults }),
      suspended,
      setSuspended,
    }),
    [shortcuts, defaults, suspended, commit],
  );

  return <ShortcutsCtx.Provider value={value}>{children}</ShortcutsCtx.Provider>;
}
