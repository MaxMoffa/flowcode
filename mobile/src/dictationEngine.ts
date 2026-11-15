import { createStore, safeStorage } from "./store";

const KEY = "dictation.desktop";

/** Phone-only setting: dictate through the computer's Whisper when it can. On unless switched off. */
const store = createStore<{ desktop: boolean }>({ desktop: safeStorage.get(KEY) !== "0" });

export const useDesktopDictationPref = () => store.use().desktop;
export const desktopDictationPref = () => store.get().desktop;

export function setDesktopDictationPref(on: boolean) {
  safeStorage.set(KEY, on ? "1" : "0");
  store.set({ desktop: on });
}

/** Whether a dictation should be tried on the computer first (it falls back to the phone if that fails). */
export function desktopDictationUsable(o: { pref: boolean; online: boolean; hostHasCap: boolean }): boolean {
  return o.pref && o.online && o.hostHasCap;
}

/** The speech plugin's error code (what `dictationError` words) for a `dictend` error code of the desktop. */
export function remoteErrorToSpeechCode(code: string | undefined): string {
  return code === "busy" ? "busy" : "unknown";
}
