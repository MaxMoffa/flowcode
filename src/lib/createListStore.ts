import { readString, writeString } from "./storage";

export interface ListStore<T> {
  /** The cached list - the same reference until something changes, as
   * `useSyncExternalStore`'s `getSnapshot` requires. */
  get: () => T[];
  set: (next: T[]) => void;
  subscribe: (listener: () => void) => () => void;
}

/** A localStorage-backed list shared by every window of the app: a module
 * cache for cheap reads, entries that fail `validate` dropped on load, and a
 * `storage` listener so a write from another window refreshes this one's
 * cache and notifies its subscribers. */
export function createListStore<T>(storageKey: string, validate: (x: unknown) => x is T, max?: number): ListStore<T> {
  const listeners = new Set<() => void>();

  function read(): T[] {
    const raw = readString(storageKey);
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(validate) : [];
    } catch {
      return [];
    }
  }

  let cache = read();

  const notify = () => listeners.forEach((l) => l());

  // `key === null` is localStorage.clear().
  window.addEventListener("storage", (e) => {
    if (e.key !== storageKey && e.key !== null) return;
    cache = read();
    notify();
  });

  return {
    get: () => cache,
    set(next) {
      cache = max !== undefined ? next.slice(0, max) : next;
      writeString(storageKey, JSON.stringify(cache));
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
