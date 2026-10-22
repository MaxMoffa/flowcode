/** Calls back when the page is likely to have been asleep or out of sight:
 * it became visible again, or a heartbeat found a gap far longer than its own
 * period (the machine slept - nothing hides the page then). Timers and frames
 * are throttled or paused meanwhile, so whatever depends on them must catch up. */
const HEARTBEAT_MS = 5000;
/** A heartbeat this late means the page did not run in between. */
export const SLEEP_GAP_MS = 15000;

const listeners = new Set<() => void>();
let beat: ReturnType<typeof setInterval> | null = null;
let last = 0;

function fire() {
  listeners.forEach((fn) => fn());
}

function onVisibility() {
  if (!document.hidden) fire();
}

function tick() {
  const now = Date.now();
  const slept = now - last > SLEEP_GAP_MS;
  last = now;
  if (slept && !document.hidden) fire();
}

export function onResume(fn: () => void): () => void {
  if (listeners.size === 0) {
    last = Date.now();
    beat = setInterval(tick, HEARTBEAT_MS);
    document.addEventListener("visibilitychange", onVisibility);
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      if (beat !== null) clearInterval(beat);
      beat = null;
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}
