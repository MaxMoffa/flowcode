import { useEffect, useRef, useState } from "react";
import { usageFetcherFor, type UsageInfo } from "./usage";

const STALE_MS = 30_000;
/** Usage limits don't move minute to minute, and a Codex refresh in
 * particular spawns a real (if invisible) CLI process for a few seconds -
 * 5 minutes keeps things reasonably fresh without doing that constantly in
 * the background. Skipped while the window isn't visible (e.g. minimized). */
const REFRESH_MS = 5 * 60_000;

/** Shared fetch/cache/auto-refresh state for a plugin's usage info - used
 * by both the pinned shortcut-bar button (PluginUsageButton) and the
 * "tutti i plugin" menu (PluginMenu), so hovering either one shows the same
 * live data instead of two separate caches drifting apart. `fetcher` is
 * `undefined` for a plugin with no known usage source (most of them) - both
 * callers treat that as "render the plain icon/row, no popover". */
export function useUsageState(pluginId: string) {
  const fetcher = usageFetcherFor(pluginId);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [loading, setLoading] = useState(false);
  // Refs, not state: read synchronously inside `load()` itself (no waiting
  // on a re-render), which is what makes `inFlightRef` actually able to
  // de-dupe two calls issued back-to-back in the same tick - see below.
  const lastFetchRef = useRef(0);
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  function load(force = false) {
    // `inFlightRef` also protects against React StrictMode's dev-only
    // double-invoke of this effect on mount: the second invocation runs
    // synchronously right after the first (before the fetch promise can
    // resolve), so without this guard every pinned button would spawn two
    // concurrent real CLI/pty processes on every mount - wasteful, and for
    // Codex (which drives a whole interactive session) a real source of
    // flakiness under load.
    if (!fetcher || inFlightRef.current) return;
    if (!force && usage && Date.now() - lastFetchRef.current < STALE_MS) return;
    inFlightRef.current = true;
    lastFetchRef.current = Date.now();
    setLoading(true);
    fetcher()
      .then((result) => {
        if (aliveRef.current) setUsage(result);
      })
      .catch(() => {
        // fetchClaudeUsage/fetchCodexUsage already turn real failures into
        // an `ok:false` UsageInfo - this only guards against a genuinely
        // unexpected throw so it can't wedge `loading` open forever or
        // surface as an unhandled rejection.
      })
      .finally(() => {
        inFlightRef.current = false;
        if (aliveRef.current) setLoading(false);
      });
  }

  useEffect(() => {
    if (!fetcher) return;
    load(true);
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load(true);
    }, REFRESH_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId]);

  return { fetcher, usage, loading, load };
}
