import { createStore } from "./store";

/** MainActivity.kt's bridge; absent off Android, where there is nothing to block. */
type Bridge = { allowed(): boolean; setAllowed(on: boolean): void };
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
  bridge()?.setAllowed(allowed);
  store.set({ allowed });
}

export const useScreenshots = () => store.use();
