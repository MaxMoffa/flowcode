import { useEffect } from "react";
import { authenticate, checkStatus } from "@tauri-apps/plugin-biometric";
import { t } from "./i18n";
import { appHidden, appResumed, suspendLink } from "./remote";
import { createStore, safeStorage } from "./store";

const KEY = "flowcode.lock";
/** Time in the background after which the app asks again. */
const GRACE_MS = 60_000;

type State = {
  checked: boolean;
  available: boolean;
  enabled: boolean;
  locked: boolean;
  /** The document is hidden (task switcher, background): render a blank screen. */
  hidden: boolean;
};

const store = createStore<State>({ checked: false, available: false, enabled: safeStorage.get(KEY) !== "off", locked: false, hidden: typeof document !== "undefined" && document.hidden });
/** Time in the background after which the link to the PC is dropped to save battery. */
const SUSPEND_MS = 30_000;
let hiddenAt: number | null = null;
let suspendTimer: ReturnType<typeof setTimeout> | undefined;
let probed: Promise<void> | null = null;

/**
 * On desktop the plugin isn't registered: any failure means "unavailable", never locked.
 * `isAvailable` means enrolled biometrics only. The plugin cannot say whether a
 * device PIN/pattern exists, so phones with only a PIN are not locked: assuming
 * one would lock out a phone that has no screen lock at all.
 */
function probe(): Promise<void> {
  probed ??= (async () => {
    try {
      const { isAvailable } = await checkStatus();
      // Locked from the very first render of the session, before app content shows.
      store.set({ checked: true, available: isAvailable, locked: isAvailable && store.get().enabled });
    } catch {
      store.set({ checked: true, available: false, locked: false });
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
  store.set({ locked: false });
}

export function setLockEnabled(enabled: boolean) {
  safeStorage.set(KEY, enabled ? "on" : "off");
  store.set({ enabled });
}

function onVisibility() {
  if (document.hidden) {
    hiddenAt = Date.now();
    store.set({ hidden: true });
    void appHidden();
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => void suspendLink(), SUSPEND_MS);
    return;
  }
  clearTimeout(suspendTimer);
  store.set({ hidden: false });
  void appResumed();
  if (hiddenAt !== null) {
    const away = Date.now() - hiddenAt;
    hiddenAt = null;
    const s = store.get();
    if (away > GRACE_MS && s.available && s.enabled) store.set({ locked: true });
  }
}

// Registered once for the whole session and never removed: screens come and go.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);

export function useLock(): State {
  useEffect(() => {
    void probe();
  }, []);
  return store.use();
}
