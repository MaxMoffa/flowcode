import { useSyncExternalStore } from "react";
import { t } from "../i18n";
import { readBool, readString, writeBool, writeString } from "../lib/storage";

const ENABLED_KEY = "flowcode.autoResume.enabled";
const MESSAGE_KEY = "flowcode.autoResume.message";

interface AutoResumeSettings {
  enabled: boolean;
  /** What to type once the limit resets; empty means the localized default. */
  message: string;
}

function read(): AutoResumeSettings {
  return { enabled: readBool(ENABLED_KEY, false), message: readString(MESSAGE_KEY) ?? "" };
}

// Same tiny external store as notificationSettings: Settings flips it, the
// App-level hook reads it, and they sit far apart in the tree.
let current = read();
const listeners = new Set<() => void>();

export function getAutoResumeSettings(): AutoResumeSettings {
  return current;
}

export function setAutoResumeEnabled(enabled: boolean) {
  if (current.enabled === enabled) return;
  writeBool(ENABLED_KEY, enabled);
  current = { ...current, enabled };
  listeners.forEach((l) => l());
}

export function setAutoResumeMessage(message: string) {
  if (current.message === message) return;
  writeString(MESSAGE_KEY, message);
  current = { ...current, message };
  listeners.forEach((l) => l());
}

export function useAutoResumeSettings(): AutoResumeSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getAutoResumeSettings,
  );
}

/** The message that actually gets typed: the user's, or the default when blank. */
export function autoResumeMessage(): string {
  return current.message.trim() || t("autoResume.defaultMessage");
}
