import { useSyncExternalStore } from "react";

/** A tiny module-level store for state read far from where it is set (a
 * Settings switch and an App-level watcher, a popover in a portal): cheaper
 * than a context, and readable outside React through `get`. `set` skips the
 * notification when `equals` says nothing changed. */
export function createStore<T>(initial: T, equals: (a: T, b: T) => boolean = Object.is) {
  let current = initial;
  const listeners = new Set<() => void>();
  const get = () => current;
  const set = (next: T) => {
    if (equals(current, next)) return;
    current = next;
    listeners.forEach((l) => l());
  };
  const update = (fn: (prev: T) => T) => set(fn(current));
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  const use = () => useSyncExternalStore(subscribe, get);
  return { get, set, update, subscribe, use };
}
