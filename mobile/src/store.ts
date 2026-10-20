// Small shared helpers: a guarded localStorage and an external store usable
// with useSyncExternalStore (the phone's analogue of src/lib/externalStore.ts).
import { useSyncExternalStore } from "react";

/** localStorage that never throws: it can be blocked or cleared, and every user treats it as a cache. */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not persisted: only this session follows the value.
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to clean up.
    }
  },
};

interface Store<S> {
  get(): S;
  /** Merges `patch` into the state and notifies subscribers. */
  set(patch: Partial<S>): void;
  subscribe(l: () => void): () => void;
  use(): S;
  /** Re-renders only when the selected slice changes (compared by reference: return existing values, not fresh objects). */
  useSelector<T>(select: (s: S) => T): T;
}

export function createStore<S extends object>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => void listeners.delete(l);
  };
  const get = () => state;
  return {
    get,
    set(patch) {
      state = { ...state, ...patch };
      listeners.forEach((l) => l());
    },
    subscribe,
    use: () => useSyncExternalStore(subscribe, get),
    useSelector: (select) => useSyncExternalStore(subscribe, () => select(state)),
  };
}
