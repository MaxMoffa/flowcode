import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const STORAGE_KEY = "flowcode.terminalFontSize";
const BANNER_KEY = "flowcode.terminalBannerEnabled";
const MIN_SIZE = 9;
const MAX_SIZE = 28;
const DEFAULT_SIZE = 13;

interface TerminalSettingsValue {
  fontSize: number;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  /** Whether a fresh terminal tab writes the ASCII "Flowcode" splash before
   * the shell's own output. */
  bannerEnabled: boolean;
  setBannerEnabled: (enabled: boolean) => void;
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

export function TerminalSettingsProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSize] = useState(readInitial);
  const [bannerEnabled, setBannerEnabledState] = useState(readInitialBanner);

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

  const zoomIn = () => setFontSize((s) => clamp(s + 1));
  const zoomOut = () => setFontSize((s) => clamp(s - 1));
  const resetZoom = () => setFontSize(DEFAULT_SIZE);
  const setBannerEnabled = (enabled: boolean) => setBannerEnabledState(enabled);

  return (
    <TerminalSettingsContext.Provider
      value={{ fontSize, zoomIn, zoomOut, resetZoom, bannerEnabled, setBannerEnabled }}
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
