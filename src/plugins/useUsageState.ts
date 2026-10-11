import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { usageFetcherFor, type UsageInfo } from "./usage";
import { profileById, useProfiles, useProfilesLoaded } from "../profiles/profiles";
import { readString, writeString } from "../lib/storage";

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
  pluginId: string;
  profile?: string;
  snapshot: Snapshot;
  lastFetch: number;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setInterval>;
}

const EMPTY: Snapshot = { usage: null, loading: false };

/** One entry per (plugin id, account profile), shared by every component
 * showing that usage (the pinned shortcut-bar button, the "tutti i plugin"
 * menu row) - a single cache, a single in-flight fetch and a single refresh
 * timer, however many of them are mounted. Previously each component kept its own copy, so
 * merely opening the plugin menu spawned a fresh Codex probe session. */
const entries = new Map<string, Entry>();

/** The default profile is the empty string. */
function keyOf(pluginId: string, profile?: string): string {
  return `${pluginId}\u0000${profile ?? ""}`;
}

function entryFor(key: string, pluginId: string, profile?: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { pluginId, profile, snapshot: EMPTY, lastFetch: 0, listeners: new Set() };
    entries.set(key, entry);
  }
  return entry;
}

/** Told about every usage result fetched, whichever plugin, profile and
 * component asked for it - lets the limit-reset notifications (see
 * limitResetWatcher.ts) follow along without fetching anything themselves. */
type FetchedListener = (pluginId: string, usage: UsageInfo, profile?: string) => void;
const fetchedListeners = new Set<FetchedListener>();

export function onUsageFetched(listener: FetchedListener): () => void {
  fetchedListeners.add(listener);
  return () => fetchedListeners.delete(listener);
}

function update(entry: Entry, patch: Partial<Snapshot>) {
  entry.snapshot = { ...entry.snapshot, ...patch };
  entry.listeners.forEach((listener) => listener());
}

function loadUsage(pluginId: string, profile?: string, force = false) {
  const fetcher = usageFetcherFor(pluginId);
  if (!fetcher) return;
  const entry = entryFor(keyOf(pluginId, profile), pluginId, profile);
  // Also de-dupes React StrictMode's dev-only double subscribe on mount -
  // for Codex, two concurrent probes means two real CLI sessions.
  if (entry.snapshot.loading) return;
  if (!force && entry.snapshot.usage && Date.now() - entry.lastFetch < STALE_MS) return;
  entry.lastFetch = Date.now();
  update(entry, { loading: true });
  fetcher(profile)
    .then((usage) => {
      update(entry, { usage });
      fetchedListeners.forEach((listener) => listener(pluginId, usage, profile));
    })
    // The fetchers already turn real failures into an `ok: false` result -
    // this only keeps an unexpected throw from wedging `loading` forever.
    .catch(() => {})
    .finally(() => update(entry, { loading: false }));
}

// The 5-minute timer is skipped while the window is hidden, so coming back
// would show stale numbers until the next tick: refresh what is on screen
// (respecting STALE_MS, so a quick tab flip costs nothing).
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const entry of entries.values()) {
      if (entry.listeners.size > 0) loadUsage(entry.pluginId, entry.profile);
    }
  });
}

function subscribe(pluginId: string, profile: string | undefined, listener: () => void): () => void {
  const entry = entryFor(keyOf(pluginId, profile), pluginId, profile);
  entry.listeners.add(listener);
  if (entry.listeners.size === 1) {
    loadUsage(pluginId, profile);
    entry.timer = setInterval(() => {
      if (document.visibilityState === "visible") loadUsage(pluginId, profile, true);
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

/** Keeps a plugin's usage fetched and refreshed (as if a component showed it)
 * until the returned function is called - for the phone mirror, which has no
 * component of its own on the desktop. */
export function retainUsage(pluginId: string, profile?: string): () => void {
  if (!usageFetcherFor(pluginId)) return noopUnsubscribe;
  return subscribe(pluginId, profile, () => {});
}

/** Fetch/cache/auto-refresh state for a plugin's usage info under an account
 * `profile` (the default account when omitted). `fetcher` is `undefined` for
 * a plugin with no known usage source (most of them) - callers treat that as
 * "render the plain icon/row, no popover". */
export function useUsageState(pluginId: string, profile?: string, enabled = true) {
  const fetcher = usageFetcherFor(pluginId);
  const subscribeToEntry = useCallback(
    (listener: () => void) => (fetcher && enabled ? subscribe(pluginId, profile, listener) : noopUnsubscribe),
    [pluginId, profile, fetcher, enabled],
  );
  const getSnapshot = useCallback(() => entries.get(keyOf(pluginId, profile))?.snapshot ?? EMPTY, [pluginId, profile]);
  const { usage, loading } = useSyncExternalStore(subscribeToEntry, getSnapshot);
  const load = useCallback(() => {
    if (enabled) loadUsage(pluginId, profile);
  }, [pluginId, profile, enabled]);
  return { fetcher, usage, loading, load };
}

const USAGE_PROFILE_KEY = "flowcode.usageProfile.";
const profileListeners = new Set<() => void>();

function subscribeProfile(listener: () => void): () => void {
  profileListeners.add(listener);
  return () => profileListeners.delete(listener);
}

/** Which account's usage a plugin shows: `undefined` is the default account.
 * Remembered per plugin in localStorage (`readString`/`writeString`), and
 * shared live between the shortcut-bar button and the plugin menu row of the
 * same plugin - picking a profile in one popover moves the other too. An id
 * whose profile was deleted since counts as the default one. */
export function useUsageProfile(
  pluginId: string,
): [string | undefined, (next: string | undefined) => void, boolean] {
  const profiles = useProfiles();
  const profilesLoaded = useProfilesLoaded();
  const stored = useSyncExternalStore(subscribeProfile, () => readString(USAGE_PROFILE_KEY + pluginId) || undefined);
  const set = useCallback(
    (next: string | undefined) => {
      writeString(USAGE_PROFILE_KEY + pluginId, next ?? "");
      profileListeners.forEach((listener) => listener());
    },
    [pluginId],
  );
  // A stored profile can only be resolved once the list is in; until then
  // nothing is fetched rather than the default account's usage by mistake.
  const ready = !stored || profilesLoaded;
  return [profileById(profiles, stored) ? stored : undefined, set, ready];
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

  /** Closes at once, with no grace period - for when something else (a
   * context menu) is about to take the popover's place. */
  const hide = () => {
    cancelHide();
    setRect(null);
  };

  useEffect(() => cancelHide, []);

  return { rect, show, scheduleHide, hide };
}
