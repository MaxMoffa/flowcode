import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { readBool, readNumber, readString, usePersistentState, writeBool, writeString } from "../lib/storage";

const STORAGE_KEY = "flowcode.terminalFontSize";
const BANNER_KEY = "flowcode.terminalBannerEnabled";
const SHELL_KEY = "flowcode.terminalShell";
const START_PATH_KEY = "flowcode.terminalStartPath";
const MIN_SIZE = 9;
const MAX_SIZE = 28;
const DEFAULT_SIZE = 13;
/** Matches `pty_spawn`'s own default when no `shell` id is passed at all -
 * "system" is a real, always-first choice in `list_shell_options` too, so
 * this is just what a fresh install (nothing in localStorage yet) starts
 * pre-selected on. */
const DEFAULT_SHELL_ID = "system";

interface TerminalSettingsValue {
  /** The default font size, set from Settings - what a brand-new tab starts
   * at, and what a tab's own zoom (below) is compared against/reset to.
   * Mirrors a browser's "default zoom level" setting. */
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  /** Per-tab zoom overrides, keyed by tab id - a tab only appears here once
   * its own zoom has been changed away from `fontSize` (see `zoomTabIn`).
   * Mirrors a browser's per-tab zoom: changing it from the terminal's own
   * context menu affects only that tab, not the app-wide default. */
  tabFontSizeOverrides: Record<string, number>;
  /** `tabFontSizeOverrides[tabId] ?? fontSize` - what a given tab should
   * actually render at right now. */
  getTabFontSize: (tabId: string) => number;
  zoomTabIn: (tabId: string) => void;
  zoomTabOut: (tabId: string) => void;
  /** Sets a tab's zoom directly (the context menu's editable px box) -
   * clamped like the +/- steps, and drops the override entirely if it's set
   * back to exactly the app-wide default, same as `resetTabZoom`. */
  setTabFontSize: (tabId: string, size: number) => void;
  /** Drops the tab's override, falling back to the app-wide default again -
   * also called when a tab closes, so the map doesn't grow unbounded. */
  resetTabZoom: (tabId: string) => void;
  /** Whether a fresh terminal tab writes the ASCII "Flowcode" splash before
   * the shell's own output. */
  bannerEnabled: boolean;
  setBannerEnabled: (enabled: boolean) => void;
  /** A `ShellOption.id` from `list_shell_options` (Rust), or `"system"` for
   * "whatever the OS/environment default is" - never a raw program path, so
   * a stale value from an older install never points at something that no
   * longer makes sense. */
  shellId: string;
  setShellId: (id: string) => void;
  /** Cwd a brand-new terminal tab starts in, when there's no other tab's cwd
   * to inherit - empty string means "use the OS home dir" (the old, only
   * behavior). Not validated here; App.tsx checks it's still a real
   * directory before ever using it, so a path that got deleted/unmounted
   * since it was set just falls back to home instead of breaking. */
  startPath: string;
  setStartPath: (path: string) => void;
}

/** Plain (non-hook) read of the same value `shellId` above holds - for the
 * headless probes (`usage.ts`'s Codex status check) that spawn a pty from
 * outside any React component and so can't call `useTerminalSettings()`.
 * Reads localStorage directly rather than caching: negligible cost, and
 * guarantees it never drifts from whatever the Settings page just wrote. */
export function getConfiguredShell(): string {
  return readString(SHELL_KEY) || DEFAULT_SHELL_ID;
}

const TerminalSettingsContext = createContext<TerminalSettingsValue | null>(null);

function clamp(size: number): number {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
}

const readFontSize = (key: string) => clamp(readNumber(key, DEFAULT_SIZE, 1));
const writeNumber = (key: string, value: number) => writeString(key, String(value));
const readBanner = (key: string) => readBool(key, true);
const readShell = () => getConfiguredShell();
const readStartPath = (key: string) => readString(key) ?? "";

/** Drops `tabId` from the overrides map (same reference if it isn't there). */
function withoutTab(prev: Record<string, number>, tabId: string): Record<string, number> {
  if (!(tabId in prev)) return prev;
  const next = { ...prev };
  delete next[tabId];
  return next;
}

export function TerminalSettingsProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSize] = usePersistentState(STORAGE_KEY, readFontSize, writeNumber);
  const [tabFontSizeOverrides, setTabFontSizeOverrides] = useState<Record<string, number>>({});
  const [bannerEnabled, setBannerEnabled] = usePersistentState(BANNER_KEY, readBanner, writeBool);
  const [shellId, setShellId] = usePersistentState(SHELL_KEY, readShell, writeString);
  const [startPath, setStartPath] = usePersistentState(START_PATH_KEY, readStartPath, writeString);

  const getTabFontSize = useCallback(
    (tabId: string) => tabFontSizeOverrides[tabId] ?? fontSize,
    [tabFontSizeOverrides, fontSize],
  );
  const setTabFontSize = useCallback(
    (tabId: string, size: number) => {
      const clamped = clamp(size);
      setTabFontSizeOverrides((prev) =>
        clamped === fontSize ? withoutTab(prev, tabId) : { ...prev, [tabId]: clamped },
      );
    },
    [fontSize],
  );

  const value = useMemo<TerminalSettingsValue>(
    () => ({
      fontSize,
      zoomIn: () => setFontSize((s) => clamp(s + 1)),
      zoomOut: () => setFontSize((s) => clamp(s - 1)),
      resetZoom: () => setFontSize(DEFAULT_SIZE),
      tabFontSizeOverrides,
      getTabFontSize,
      zoomTabIn: (tabId) => setTabFontSize(tabId, (tabFontSizeOverrides[tabId] ?? fontSize) + 1),
      zoomTabOut: (tabId) => setTabFontSize(tabId, (tabFontSizeOverrides[tabId] ?? fontSize) - 1),
      setTabFontSize,
      resetTabZoom: (tabId) => setTabFontSizeOverrides((prev) => withoutTab(prev, tabId)),
      bannerEnabled,
      setBannerEnabled,
      shellId,
      setShellId,
      startPath,
      setStartPath,
    }),
    [
      fontSize,
      setFontSize,
      tabFontSizeOverrides,
      getTabFontSize,
      setTabFontSize,
      bannerEnabled,
      setBannerEnabled,
      shellId,
      setShellId,
      startPath,
      setStartPath,
    ],
  );

  return <TerminalSettingsContext.Provider value={value}>{children}</TerminalSettingsContext.Provider>;
}

export function useTerminalSettings() {
  const ctx = useContext(TerminalSettingsContext);
  if (!ctx) throw new Error("useTerminalSettings must be used within TerminalSettingsProvider");
  return ctx;
}
