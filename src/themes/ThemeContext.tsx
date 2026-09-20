import { createContext, useContext, useEffect, useLayoutEffect, useState, type ReactNode } from "react";

export type Theme = "light" | "dark";
export type ThemeMode = Theme | "auto";

const STORAGE_KEY = "flowcode.theme";
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
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "auto") return stored;
  return "auto";
}

/** themes.css's own default --surface-alpha for the current platform/theme.
 * Can't just read it back via getComputedStyle: this runs before the
 * `data-theme` effect below has applied (that attribute is what makes the
 * platform override rule match at all), so the cascade wouldn't have picked
 * it up yet. Duplicated here instead - matches the values in the platform
 * override block a few lines above the theme blocks in themes.css. */
function getThemeDefaultAlpha(_theme: Theme): number {
  return 0.9;
}

function getInitialGlassOpacity(theme: Theme): number {
  const raw = localStorage.getItem(GLASS_OPACITY_KEY_PREFIX + theme);
  // `Number(null)` is `0`, not `NaN` - reading it before checking for a
  // missing key would make "never set" indistinguishable from "explicitly
  // set to 0%", silently turning every fresh profile fully transparent.
  if (raw === null) return getThemeDefaultAlpha(theme);
  const stored = Number(raw);
  if (Number.isFinite(stored) && stored >= 0 && stored <= 1) return stored;
  return getThemeDefaultAlpha(theme);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getInitialMode);
  const [systemTheme, setSystemTheme] = useState<Theme>(getSystemTheme);

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

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

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
    localStorage.setItem(GLASS_OPACITY_KEY_PREFIX + theme, String(glassOpacity));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [glassOpacity]);

  const setMode = (next: ThemeMode) => setModeState(next);
  const toggleTheme = () => setModeState(theme === "dark" ? "light" : "dark");
  const setGlassOpacity = (value: number) => setGlassOpacityState(Math.max(0, Math.min(1, value)));

  return (
    <ThemeContext.Provider value={{ theme, mode, setMode, toggleTheme, glassOpacity, setGlassOpacity }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
