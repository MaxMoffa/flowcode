import { t } from "../i18n";
import { createStore } from "../lib/externalStore";
import { readBool, readString, writeBool, writeString } from "../lib/storage";

const ENABLED_KEY = "flowcode.autoResume.enabled";
const MESSAGE_KEY = "flowcode.autoResume.message";

interface AutoResumeSettings {
  enabled: boolean;
  /** What to type once the limit resets; empty means the localized default. */
  message: string;
}

// Settings flips it, the App-level hook reads it, and they sit far apart in the tree.
const store = createStore<AutoResumeSettings>({
  enabled: readBool(ENABLED_KEY, false),
  message: readString(MESSAGE_KEY) ?? "",
});

export const getAutoResumeSettings = store.get;
export const useAutoResumeSettings = store.use;

export function setAutoResumeEnabled(enabled: boolean) {
  if (store.get().enabled === enabled) return;
  writeBool(ENABLED_KEY, enabled);
  store.update((s) => ({ ...s, enabled }));
}

export function setAutoResumeMessage(message: string) {
  if (store.get().message === message) return;
  writeString(MESSAGE_KEY, message);
  store.update((s) => ({ ...s, message }));
}

/** The message that actually gets typed: the user's, or the default when blank. */
export function autoResumeMessage(): string {
  return store.get().message.trim() || t("autoResume.defaultMessage");
}
