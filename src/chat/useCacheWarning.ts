import { useCallback, useEffect, useState } from "react";
import { cacheWarningDelay } from "./cacheWarning";

/** Whether to show the "prompt cache likely expired" notice: one timeout to the exact moment, re-planned when the
 * activity changes. A dismissal holds for that activity only; any later one makes it eligible again. */
export function useCacheWarning(opts: { agent: string; idle: boolean; items: { type: string }[]; lastActivityAt: number | null; usageTokens: number | null }) {
  const { agent, idle, items, lastActivityAt, usageTokens } = opts;
  const [stale, setStale] = useState(false);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const dismissed = lastActivityAt !== null && dismissedAt === lastActivityAt;

  useEffect(() => {
    setStale(false);
    if (dismissed) return;
    const delay = cacheWarningDelay({ agent, idle, items, lastActivityAt, now: Date.now(), usageTokens });
    if (delay === null) return;
    if (delay === 0) {
      setStale(true);
      return;
    }
    const timer = setTimeout(() => setStale(true), delay);
    return () => clearTimeout(timer);
  }, [agent, idle, items, lastActivityAt, usageTokens, dismissed]);

  const dismiss = useCallback(() => setDismissedAt(lastActivityAt), [lastActivityAt]);
  return { show: stale && !dismissed, dismiss };
}
