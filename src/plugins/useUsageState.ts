import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { usageFetcherFor, type UsageInfo } from "./usage";
import { profileById, useProfiles, useProfilesLoaded } from "../profiles/profiles";
import { createStore } from "../lib/externalStore";
import { cliOfPlugin } from "../agents/cliInfo";
import { activeTabProfile } from "../profiles/activeTabProfile";

const STALE_MS = 30_000;
/** Usage limits don't move minute to minute, and a Codex refresh in
 * particular spawns a real (if invisible) CLI process for a few seconds -
 * 5 minutes keeps things reasonably fresh without doing that constantly in
 * the background. Skipped while the window isn't visible (e.g. minimized), except for
 * entries retained for the phone mirror. */
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
  /** Holders that keep it fresh for the phone mirror: they refresh on the
   * timer even while the window is hidden (a minimized desktop is the usual
   * case with a phone connected). */
  retained: number;
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
    entry = { pluginId, profile, snapshot: EMPTY, lastFetch: 0, listeners: new Set(), retained: 0 };
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

function subscribe(pluginId: string, profile: string | undefined, listener: () => void, retain = false): () => void {
  const entry = entryFor(keyOf(pluginId, profile), pluginId, profile);
  entry.listeners.add(listener);
  if (retain) entry.retained++;
  if (entry.listeners.size === 1) {
    loadUsage(pluginId, profile);
    entry.timer = setInterval(() => {
      if (entry.retained > 0 || document.visibilityState === "visible") loadUsage(pluginId, profile, true);
    }, REFRESH_MS);
  }
  return () => {
    entry.listeners.delete(listener);
    if (retain) entry.retained--;
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
  return subscribe(pluginId, profile, () => {}, true);
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

/** Per-plugin profile picked in a usage popover, shared live between the
 * shortcut-bar button and the plugin menu row of the same plugin. `{ id }`
 * boxes it so "picked the default profile" (`undefined`) differs from "no
 * pick". Dropped whenever the active terminal tab changes. */
const overrides = createStore<Record<string, { id: string | undefined }>>({});
activeTabProfile.subscribe(() => overrides.set({}));

/** Which account's usage a plugin shows: `undefined` is the default account.
 * Starts on the active terminal tab's profile; a choice made in the popover
 * wins until the active tab changes. An id whose profile was deleted since
 * counts as the default one. */
export function useUsageProfile(
  pluginId: string,
): [string | undefined, (next: string | undefined) => void, boolean] {
  const profiles = useProfiles();
  const profilesLoaded = useProfilesLoaded();
  const picked = overrides.use()[pluginId];
  const { profileId: tabProfile } = activeTabProfile.use();
  const wanted = picked ? picked.id : tabProfile;
  // A CLI's usage only exists for profiles it is signed in under; others
  // (e.g. the active tab's) fall back to the default account.
  const cli = cliOfPlugin(pluginId);
  const profile = profileById(profiles, wanted);
  const usable = !!profile && (!cli || profile.logged_in[cli]);
  const set = useCallback(
    (next: string | undefined) => overrides.update((prev) => ({ ...prev, [pluginId]: { id: next } })),
    [pluginId],
  );
  // A profile id can only be resolved once the list is in; until then
  // nothing is fetched rather than the default account's usage by mistake.
  const ready = !wanted || profilesLoaded;
  return [usable ? wanted : undefined, set, ready];
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
