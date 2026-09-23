import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { usageFetcherFor, type UsageInfo } from "./usage";

const STALE_MS = 30_000;
/** Usage limits don't move minute to minute, and a Codex refresh in
 * particular spawns a real (if invisible) CLI process for a few seconds -
 * 5 minutes keeps things reasonably fresh without doing that constantly in
 * the background. Skipped while the window isn't visible (e.g. minimized). */
const REFRESH_MS = 5 * 60_000;

interface Snapshot {
  usage: UsageInfo | null;
  loading: boolean;
}

interface Entry {
  snapshot: Snapshot;
  lastFetch: number;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
}

const EMPTY: Snapshot = { usage: null, loading: false };

/** One entry per plugin id, shared by every component showing that plugin's
 * usage (the pinned shortcut-bar button, the "tutti i plugin" menu row) - a
 * single cache, a single in-flight fetch and a single refresh timer, however
 * many of them are mounted. Previously each component kept its own copy, so
 * merely opening the plugin menu spawned a fresh Codex probe session. */
const entries = new Map<string, Entry>();

function entryFor(pluginId: string): Entry {
  let entry = entries.get(pluginId);
  if (!entry) {
    entry = { snapshot: EMPTY, lastFetch: 0, listeners: new Set() };
    entries.set(pluginId, entry);
  }
  return entry;
}

function update(entry: Entry, patch: Partial<Snapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  entry.listeners.forEach((listener) => listener());
}

function loadUsage(pluginId: string, force = false) {
  const fetcher = usageFetcherFor(pluginId);
  if (!fetcher) return;
  const entry = entryFor(pluginId);
  // Also de-dupes React StrictMode's dev-only double subscribe on mount -
  // for Codex, two concurrent probes means two real CLI sessions.
  if (entry.snapshot.loading) return;
  if (!force && entry.snapshot.usage && Date.now() - entry.lastFetch < STALE_MS) return;
  entry.lastFetch = Date.now();
  update(entry, { loading: true });
  fetcher()
    .then((usage) => update(entry, { usage }))
    // The fetchers already turn real failures into an `ok: false` result -
    // this only keeps an unexpected throw from wedging `loading` forever.
    .catch(() => {})
    .finally(() => update(entry, { loading: false }));
}

function subscribe(pluginId: string, listener: () => void): () => void {
  const entry = entryFor(pluginId);
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) {
    loadUsage(pluginId);
    entry.timer = setInterval(() => {
      if (document.visibilityState === "visible") loadUsage(pluginId, true);
    }, REFRESH_MS);
  }
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0 && entry.timer) {
      clearInterval(entry.timer);
      entry.timer = undefined;
    }
  };
}

const noopUnsubscribe = () => {};

/** Fetch/cache/auto-refresh state for a plugin's usage info. `fetcher` is
 * `undefined` for a plugin with no known usage source (most of them) -
 * callers treat that as "render the plain icon/row, no popover". */
export function useUsageState(pluginId: string) {
  const fetcher = usageFetcherFor(pluginId);
  const subscribeToEntry = useCallback(
    (listener: () => void) => (fetcher ? subscribe(pluginId, listener) : noopUnsubscribe),
    [pluginId, fetcher],
  );
  const getSnapshot = useCallback(() => entries.get(pluginId)?.snapshot ?? EMPTY, [pluginId]);
  const { usage, loading } = useSyncExternalStore(subscribeToEntry, getSnapshot);
  const load = useCallback(() => loadUsage(pluginId), [pluginId]);
  return { fetcher, usage, loading, load };
}

/** Hover-driven popover anchoring shared by the shortcut-bar button and the
 * plugin menu rows: `show` (on mouse enter of either the trigger or the
 * popover itself) records the trigger's rect, `scheduleHide` closes after a
 * short grace period so the pointer can travel from trigger to popover. */
export function useHoverPopover(anchorRef: RefObject<HTMLElement | null>, onShow?: () => void) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelHide = () => {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };

  const show = () => {
    cancelHide();
    setRect(anchorRef.current?.getBoundingClientRect() ?? null);
    onShow?.();
  };

  const scheduleHide = () => {
    cancelHide();
    hideTimer.current = setTimeout(() => setRect(null), 160);
  };

  useEffect(() => cancelHide, []);

  return { rect, show, scheduleHide };
}
