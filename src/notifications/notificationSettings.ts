import { useSyncExternalStore } from "react";
import { readBool, writeBool } from "../lib/storage";

/** What an agent in a tab can notify about - plus `limitReset`, an account's
 * usage limit lifting again (see limitResetWatcher.ts). */
export type NotificationKind = "done" | "input" | "exited" | "limitReset";
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["done", "input", "exited", "limitReset"];

const DEFAULTS: Record<NotificationKind, boolean> = { done: true, input: true, exited: false, limitReset: true };
const key = (kind: NotificationKind) => `flowcode.notify.${kind}`;

type Enabled = Record<NotificationKind, boolean>;

function read(): Enabled {
  return {
    done: readBool(key("done"), DEFAULTS.done),
    input: readBool(key("input"), DEFAULTS.input),
    exited: readBool(key("exited"), DEFAULTS.exited),
    limitReset: readBool(key("limitReset"), DEFAULTS.limitReset),
  };
}

// A tiny external store rather than a context: the Settings tab that flips a
// switch and the App-level watcher that reads it live in the same window but
// nowhere near each other in the tree.
let current = read();
const listeners = new Set<() => void>();

export function getNotificationSettings(): Enabled {
  return current;
}

export function setNotificationEnabled(kind: NotificationKind, enabled: boolean) {
  if (current[kind] === enabled) return;
  writeBool(key(kind), enabled);
  current = { ...current, [kind]: enabled };
  listeners.forEach((l) => l());
}

export function useNotificationSettings(): Enabled {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getNotificationSettings,
  );
}
