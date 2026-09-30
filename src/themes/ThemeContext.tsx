import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { readEnum, readNumber, readString, removeKey, writeString } from "../lib/storage";
import { DEFAULT_CONTRAST, DEFAULT_PALETTE_ID, findPalette, resolvePalette } from "./palettes";

export type Theme = "light" | "dark";
export type ThemeMode = Theme | "auto";

const STORAGE_KEY = "flowcode.theme";
export const PALETTE_KEY = "flowcode.palette";
const TERMINAL_PALETTE_KEY = "flowcode.terminalPalette";
const CONTRAST_KEY = "flowcode.contrast";
// Version suffix: while Windows had no working native backdrop, panels at a
// low alpha just looked washed out, so a stored opacity of ~1 was the only
// usable setting - and that stored value would keep hiding the acrylic
// backdrop now that it does work. Bumping the key drops those stale values
// once, so everyone lands back on the default below; the slider still
// overrides it from then on.
// Bumped again (v3 -> v4): `getInitialGlassOpacity` used to read a missing
// key as literal 0% (`Number(null) === 0` slipped past the `0 <= x <= 1`
// check) instead of falling back to the default, and then persisted that
// wrong 0 right back to storage on the next render - so v3's stored values
// are all suspect, not just unset ones, and can't be told apart from a
// genuine "user picked 0%" after the fact.
// Keyed per-theme (`.v4.light` / `.v4.dark`), not one shared value: a level
// tuned by eye against a dark backdrop while on the dark theme reads as
// muddy/too-dark once applied to the light theme's much paler surface color
// (or vice versa) - the two need their own setting, same as the theme mode
// itself does.
const GLASS_OPACITY_KEY_PREFIX = "flowcode.glassOpacity.v4.";

interface ThemeContextValue {
  /** Resolved light/dark - what's actually applied, auto included. */
  theme: Theme;
  /** The user's stored preference - "auto" follows the OS. */
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  /** Flips the resolved theme, breaking out of "auto" if that was active. */
  toggleTheme: () => void;
  /** Id of the colour palette (see palettes.ts) - recolours the whole app and
   * holds a light and a dark variant, so it's independent of `mode`. */
  paletteId: string;
  setPaletteId: (id: string) => void;
  /** A palette used only by the terminal, or `null` when the terminal simply
   * follows `paletteId` (the "separate terminal colours" option is off). */
  terminalPaletteId: string | null;
  setTerminalPaletteId: (id: string | null) => void;
  /** Text contrast of the theme, 0-1: 0.5 is the palettes as designed, lower
   * softens it (never below a readable floor), higher strengthens it. */
  contrast: number;
  setContrast: (value: number) => void;
  /** 0 (fully see-through) - 1 (fully opaque) opacity of every glass panel
   * (--surface) for the *current* theme. Defaults to whatever the current
   * platform/theme combination already uses (themes.css's own default, or
   * its Windows/Linux opaque-fallback override) until the user drags the
   * settings slider - stored separately per theme from then on. */
  glassOpacity: number;
  setGlassOpacity: (value: number) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getInitialMode(): ThemeMode {
  return readEnum<ThemeMode>(STORAGE_KEY, ["auto", "light", "dark"], "auto");
}

/** The stored palette id, or the default when unset or no longer a palette. */
export function readPaletteId(): string {
  const stored = readString(PALETTE_KEY);
  return findPalette(stored) ? stored! : DEFAULT_PALETTE_ID;
}

function readTerminalPaletteId(): string | null {
  const stored = readString(TERMINAL_PALETTE_KEY);
  return findPalette(stored) ? stored : null;
}

/** Default --surface-alpha until the user moves the slider - the same for
 * both themes today. Can't be read back from themes.css via
 * getComputedStyle: this runs before the `data-theme` attribute that makes
 * the platform override rules match has been applied. */
const DEFAULT_GLASS_ALPHA = 0.6;

function getInitialGlassOpacity(theme: Theme): number {
  // readNumber treats a missing key as "use the default" - `Number(null)` is
  // 0, which would otherwise turn every fresh profile fully transparent.
  return readNumber(GLASS_OPACITY_KEY_PREFIX + theme, DEFAULT_GLASS_ALPHA, 0, 1);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);
  const [paletteId, setPaletteIdState] = useState<string>(readPaletteId);
  const [contrast, setContrastState] = useState<number>(() => readNumber(CONTRAST_KEY, DEFAULT_CONTRAST, 0, 1));
  const [terminalPaletteId, setTerminalPaletteIdState] = useState<string | null>(readTerminalPaletteId);

  const theme: Theme = mode === "auto" ? systemTheme : mode;

  const [glassOpacity, setGlassOpacityState] = useState<number>(() => getInitialGlassOpacity(theme));

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemTheme(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Layout effect, not a plain one: React flushes every layout effect in the
  // tree (parents included) before any passive `useEffect` runs, but within
  // a single effect phase children fire before their ancestors. Terminal.tsx
  // re-reads these CSS custom properties from a plain `useEffect` keyed off
  // `theme` - as a passive effect it would otherwise run in the same commit
  // as this one, but *before* it (child before parent), catching the
  // computed style one render behind and leaving already-open tabs stuck on
  // the previous theme's colors until something else touched them.
  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  // Same layout-effect reasoning as above. The palette is set as inline
  // custom properties on :root, which beat themes.css's per-theme blocks
  // (those only cover the first paint, before this runs). Runs on `theme`
  // too, since each palette has a different variant per theme.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const palette = findPalette(paletteId);
    if (!palette) return;
    const vars = resolvePalette(palette[theme], theme, contrast);
    for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    return () => {
      for (const name of Object.keys(vars)) root.style.removeProperty(name);
    };
  }, [paletteId, theme, contrast]);

  useEffect(() => {
    writeString(STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    writeString(PALETTE_KEY, paletteId);
  }, [paletteId]);

  useEffect(() => {
    writeString(CONTRAST_KEY, String(contrast));
  }, [contrast]);

  useEffect(() => {
    if (terminalPaletteId) writeString(TERMINAL_PALETTE_KEY, terminalPaletteId);
    else removeKey(TERMINAL_PALETTE_KEY);
  }, [terminalPaletteId]);

  // Switching theme swaps in that theme's own stored (or default) opacity -
  // never carries the other theme's value across.
  useEffect(() => {
    setGlassOpacityState(getInitialGlassOpacity(theme));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme]);

  useEffect(() => {
    // An inline style on :root beats every stylesheet rule for the same
    // custom property, including the light/dark theme blocks and the
    // Windows/Linux opaque-fallback override - one place to set, no need to
    // know which of those is currently in effect.
    document.documentElement.style.setProperty("--surface-alpha", String(glassOpacity));
    writeString(GLASS_OPACITY_KEY_PREFIX + theme, String(glassOpacity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glassOpacity]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      mode,
      setMode: setModeState,
      toggleTheme: () => setModeState(theme === "dark" ? "light" : "dark"),
      paletteId,
      setPaletteId: (id) => setPaletteIdState(findPalette(id) ? id : DEFAULT_PALETTE_ID),
      contrast,
      setContrast: (value) => setContrastState(Math.max(0, Math.min(1, value))),
      terminalPaletteId,
      setTerminalPaletteId: (id) => setTerminalPaletteIdState(id !== null && findPalette(id) ? id : null),
      glassOpacity,
      setGlassOpacity: (next) => setGlassOpacityState(Math.max(0, Math.min(1, next))),
    }),
    [theme, mode, paletteId, terminalPaletteId, contrast, glassOpacity],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
