import { useEffect, useState } from "react";

/** One shared 1 s ticker for every running-clock label: a single interval
 * while at least one is mounted, paused while the window is hidden. */
const tickListeners = new Set<() => void>();
let tickTimer: ReturnType<typeof setInterval> | null = null;

function syncTicker() {
  const shouldRun = tickListeners.size > 0 && !document.hidden;
  if (shouldRun && tickTimer === null) {
    tickTimer = setInterval(() => tickListeners.forEach((fn) => fn()), 1000);
  } else if (!shouldRun && tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

function subscribeTick(fn: () => void) {
  if (tickListeners.size === 0) document.addEventListener("visibilitychange", syncTicker);
  tickListeners.add(fn);
  syncTicker();
  return () => {
    tickListeners.delete(fn);
    if (tickListeners.size === 0) document.removeEventListener("visibilitychange", syncTicker);
    syncTicker();
  };
}

/** Re-renders itself every second, so the labels showing a running clock
 * don't cost the whole settings page a render per tick. */
export function useSecondTick() {
  const [, setTick] = useState(0);
  useEffect(() => subscribeTick(() => setTick((n) => n + 1)), []);
}
