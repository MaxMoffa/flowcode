import { useEffect, useState } from "react";

/** Keeps a panel mounted long enough to animate it in and out. `mounted` says
 * whether to render it at all; `shown` is the target state to drive the CSS
 * transition from. Opening mounts with `shown` still false and flips it two
 * frames later: a single frame is not enough for the browser to have painted
 * the collapsed state, in which case the transition would be skipped. Closing
 * flips `shown` first and unmounts once the transition has had time to run.
 * Starts in its final state, so a panel that is open at launch doesn't slide
 * in from nothing. */
export function usePanelPresence(open: boolean, durationMs = 220): { mounted: boolean; shown: boolean } {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setShown(true));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(timer);
  }, [open, durationMs]);

  return { mounted, shown };
}
