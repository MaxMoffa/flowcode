import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

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
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
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
  try {
    return localStorage.getItem(SHELL_KEY) || DEFAULT_SHELL_ID;
  } catch {
    return DEFAULT_SHELL_ID;
  }
}

const TerminalSettingsContext = createContext<TerminalSettingsValue | null>(null);

function clamp(size: number): number {
  return Math.max(MIN_SIZE, Math.min(MAX_SIZE, size));
}

function readInitial(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return clamp(stored);
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_SIZE;
}

function readInitialBanner(): boolean {
  try {
    const stored = localStorage.getItem(BANNER_KEY);
    if (stored === "0") return false;
  } catch {
    /* storage unavailable */
  }
  return true;
}

function readInitialStartPath(): string {
  try {
    return localStorage.getItem(START_PATH_KEY) || "";
  } catch {
    return "";
  }
}

export function TerminalSettingsProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSize] = useState(readInitial);
  const [bannerEnabled, setBannerEnabledState] = useState(readInitialBanner);
  const [shellId, setShellIdState] = useState(getConfiguredShell);
  const [startPath, setStartPathState] = useState(readInitialStartPath);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(fontSize));
    } catch {
      /* storage unavailable */
    }
  }, [fontSize]);

  useEffect(() => {
    try {
      localStorage.setItem(BANNER_KEY, bannerEnabled ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [bannerEnabled]);

  useEffect(() => {
    try {
      localStorage.setItem(SHELL_KEY, shellId);
    } catch {
      /* storage unavailable */
    }
  }, [shellId]);

  useEffect(() => {
    try {
      localStorage.setItem(START_PATH_KEY, startPath);
    } catch {
      /* storage unavailable */
    }
  }, [startPath]);

  const zoomIn = () => setFontSize((s) => clamp(s + 1));
  const zoomOut = () => setFontSize((s) => clamp(s - 1));
  const resetZoom = () => setFontSize(DEFAULT_SIZE);
  const setBannerEnabled = (enabled: boolean) => setBannerEnabledState(enabled);
  const setShellId = (id: string) => setShellIdState(id);
  const setStartPath = (path: string) => setStartPathState(path);

  return (
    <TerminalSettingsContext.Provider
      value={{
        fontSize,
        zoomIn,
        zoomOut,
        resetZoom,
        bannerEnabled,
        setBannerEnabled,
        shellId,
        setShellId,
        startPath,
        setStartPath,
      }}
    >
      {children}
    </TerminalSettingsContext.Provider>
  );
}

export function useTerminalSettings() {
  const ctx = useContext(TerminalSettingsContext);
  if (!ctx) throw new Error("useTerminalSettings must be used within TerminalSettingsProvider");
  return ctx;
}
