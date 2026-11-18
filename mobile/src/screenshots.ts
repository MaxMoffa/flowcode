import { createStore } from "./store";

/** MainActivity.kt's bridge; absent off Android, where there is nothing to block. */
type Bridge = { allowed(): boolean };
/** Write side: a WebMessage listener that only accepts the main frame (iframes must not lift FLAG_SECURE). */
type SetBridge = { postMessage(message: string): void };
const bridge = () => (window as { FlowcodeScreenshots?: Bridge }).FlowcodeScreenshots;

function readAllowed(): boolean {
  try {
    return bridge()?.allowed() ?? false;
  } catch {
    return false;
  }
}

const store = createStore<{ allowed: boolean }>({ allowed: readAllowed() });

/** Whether this phone can block screenshots of the app at all. */
export const screenshotsSupported = () => !!bridge();

/** Screenshots, screen recording and the Recents thumbnail are blocked unless allowed here. */
export function setScreenshotsAllowed(allowed: boolean) {
  (window as { FlowcodeScreenshotsSet?: SetBridge }).FlowcodeScreenshotsSet?.postMessage(allowed ? "1" : "0");
  store.set({ allowed });
}

export const useScreenshots = () => store.use();
