import { useEffect, useSyncExternalStore } from "react";
import { authenticate, checkStatus } from "@tauri-apps/plugin-biometric";
import { t } from "./i18n";

const KEY = "flowcode.lock";
/** Time in the background after which the app asks again. */
const GRACE_MS = 60_000;

type State = { checked: boolean; available: boolean; enabled: boolean; locked: boolean };

let state: State = { checked: false, available: false, enabled: readEnabled(), locked: false };
const listeners = new Set<() => void>();
let hiddenAt: number | null = null;
let probed: Promise<void> | null = null;

function readEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

function set(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

/** On desktop the plugin isn't registered: any failure means "unavailable", never locked. */
function probe(): Promise<void> {
  probed ??= (async () => {
    try {
      const { isAvailable } = await checkStatus();
      // Locked from the very first render of the session, before app content shows.
      set({ checked: true, available: isAvailable, locked: isAvailable && state.enabled });
    } catch {
      set({ checked: true, available: false, locked: false });
    }
  })();
  return probed;
}

/** Prompts for biometrics, falling back to the device PIN/pattern. */
export async function verify(): Promise<boolean> {
  try {
    await authenticate(t("lockReason"), { allowDeviceCredential: true, title: t("lockReason"), cancelTitle: t("lockCancel") });
    return true;
  } catch {
    return false;
  }
}

export function unlock() {
  set({ locked: false });
}

export function setLockEnabled(enabled: boolean) {
  try {
    localStorage.setItem(KEY, enabled ? "on" : "off");
  } catch {
    // Not persisted: only this session follows the choice.
  }
  set({ enabled });
}

function onVisibility() {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (hiddenAt !== null) {
    const away = Date.now() - hiddenAt;
    hiddenAt = null;
    if (away > GRACE_MS && state.available && state.enabled) set({ locked: true });
  }
}

export function useLock(): State {
  const s = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
  useEffect(() => {
    void probe();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  return s;
}
