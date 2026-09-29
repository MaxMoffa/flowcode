import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { readBool, readJson, readNumber, readString, usePersistentState, writeBool, writeString } from "../lib/storage";
import { wslDistroOfShell } from "./wslPath";

const STORAGE_KEY = "flowcode.terminalFontSize";
const BANNER_KEY = "flowcode.terminalBannerEnabled";
const SHELL_KEY = "flowcode.terminalShell";
const START_PATH_KEY = "flowcode.terminalStartPath";
const SHELL_START_PATHS_KEY = "flowcode.terminalStartPathByShell";
const RESTORE_SESSION_KEY = "flowcode.restoreSession";
const NEW_TAB_PAGE_KEY = "flowcode.newTabPage";
const CONFIRM_LINKS_KEY = "flowcode.confirmLinkOpen";
const EXPLORER_DOUBLE_CLICK_KEY = "flowcode.explorerDoubleClick";
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
  /** Per-shell start folders, keyed by `shellStartKey` - a shell with no
   * entry uses `startPath` above, except WSL, which defaults to the distro's
   * home (see App.tsx's `resolveStartDir`). Like `startPath`, only ever set
   * to a path the Settings page verified, and re-checked before use. A WSL
   * entry may be POSIX-shaped (`~/src`, `/opt/x`) as well as a Windows/UNC
   * path. */
  shellStartPaths: Record<string, string>;
  /** Empty `path` drops the shell's entry (back to the default). */
  setShellStartPath: (shellKey: string, path: string) => void;
  resetShellStartPaths: () => void;
  /** Whether closing the window saves the open tabs (and each terminal's
   * content) and the next launch reopens them - see `src/session/`. */
  restoreSession: boolean;
  setRestoreSession: (enabled: boolean) => void;
  /** Whether clicking a link in a terminal asks first (a small menu at the
   * click) or opens it in the browser straight away. */
  confirmLinkOpen: boolean;
  setConfirmLinkOpen: (enabled: boolean) => void;
  /** Whether the file explorer enters a folder on double click (the default)
   * or on a single click. */
  explorerDoubleClick: boolean;
  setExplorerDoubleClick: (enabled: boolean) => void;
  /** Whether "+" / Ctrl+T open the new tab page (favorites, recent commands
   * and its command line) or go straight to a terminal. */
  newTabPage: boolean;
  setNewTabPage: (enabled: boolean) => void;
}

/** Plain (non-hook) read of the same value `shellId` above holds - for the
 * headless probes (`usage.ts`'s Codex status check) that spawn a pty from
 * outside any React component and so can't call `useTerminalSettings()`.
 * Reads localStorage directly rather than caching: negligible cost, and
 * guarantees it never drifts from whatever the Settings page just wrote. */
export function getConfiguredShell(): string {
  return readString(SHELL_KEY) || DEFAULT_SHELL_ID;
}

/** The `shellStartPaths` key for a shell id: every WSL one (`wsl`,
 * `wsl:<distro>`) shares the `wsl` entry, and an empty id is `system`. */
export function shellStartKey(shellId: string | undefined): string {
  if (wslDistroOfShell(shellId) !== undefined) return "wsl";
  return shellId || DEFAULT_SHELL_ID;
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
const isStringRecord = (value: unknown): value is Record<string, string> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((v) => typeof v === "string");
const readShellStartPaths = (key: string) => readJson(key, isStringRecord, {});
const writeJson = (key: string, value: Record<string, string>) => writeString(key, JSON.stringify(value));
const readRestoreSession = (key: string) => readBool(key, true);
const readConfirmLinks = (key: string) => readBool(key, true);
const readExplorerDoubleClick = (key: string) => readBool(key, true);
const readNewTabPage = (key: string) => readBool(key, true);

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
  const [shellStartPaths, setShellStartPaths] = usePersistentState(
    SHELL_START_PATHS_KEY,
    readShellStartPaths,
    writeJson,
  );
  const setShellStartPath = useCallback(
    (shellKey: string, path: string) =>
      setShellStartPaths((prev) => {
        if ((prev[shellKey] ?? "") === path) return prev;
        const next = { ...prev };
        if (path) next[shellKey] = path;
        else delete next[shellKey];
        return next;
      }),
    [setShellStartPaths],
  );
  const [restoreSession, setRestoreSession] = usePersistentState(RESTORE_SESSION_KEY, readRestoreSession, writeBool);
  const [confirmLinkOpen, setConfirmLinkOpen] = usePersistentState(CONFIRM_LINKS_KEY, readConfirmLinks, writeBool);
  const [explorerDoubleClick, setExplorerDoubleClick] = usePersistentState(
    EXPLORER_DOUBLE_CLICK_KEY,
    readExplorerDoubleClick,
    writeBool,
  );
  const [newTabPage, setNewTabPage] = usePersistentState(NEW_TAB_PAGE_KEY, readNewTabPage, writeBool);

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
      shellStartPaths,
      setShellStartPath,
      resetShellStartPaths: () => setShellStartPaths({}),
      restoreSession,
      setRestoreSession,
      confirmLinkOpen,
      setConfirmLinkOpen,
      explorerDoubleClick,
      setExplorerDoubleClick,
      newTabPage,
      setNewTabPage,
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
      shellStartPaths,
      setShellStartPath,
      setShellStartPaths,
      restoreSession,
      setRestoreSession,
      confirmLinkOpen,
      setConfirmLinkOpen,
      explorerDoubleClick,
      setExplorerDoubleClick,
      newTabPage,
      setNewTabPage,
    ],
  );

  return <TerminalSettingsContext.Provider value={value}>{children}</TerminalSettingsContext.Provider>;
}

export function useTerminalSettings() {
  const ctx = useContext(TerminalSettingsContext);
  if (!ctx) throw new Error("useTerminalSettings must be used within TerminalSettingsProvider");
  return ctx;
}
