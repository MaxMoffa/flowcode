// Turns the desktop's mirrored palette into CSS custom properties on <html>.
// Every value is a concrete hex/rgba string (never color-mix()): the terminal
// reads them with getComputedStyle and hands them to xterm, which can't parse
// CSS color functions.
import type { MirroredSettings } from "./remote";
import { createStore, safeStorage } from "./store";

type Rgba = [number, number, number, number];

function parse(c: string): Rgba {
  const s = c.trim();
  if (s.startsWith("#")) {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length >= 8 ? n(6) / 255 : 1];
  }
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0] || 0, p[1] || 0, p[2] || 0, p[3] ?? 1];
  }
  return [0, 0, 0, 1];
}

const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** `a` moved `pct` (0..1) of the way toward `b`, as opaque hex. */
function mix(a: string, b: string, pct: number): string {
  const x = parse(a);
  const y = parse(b);
  return "#" + [0, 1, 2].map((i) => hex(x[i] + (y[i] - x[i]) * pct)).join("");
}

/** `c` at the given alpha, as rgba(). */
function alpha(c: string, a: number): string {
  const [r, g, b] = parse(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Film-grain overlay tinted with the given 0..1 rgb. */
function grain([r, g, b]: [number, number, number]): string {
  const svg =
    "%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n' x='0' y='0' width='100%25' height='100%25'%3E" +
    "%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E" +
    `%3CfeColorMatrix values='0 0 0 0 ${r} 0 0 0 0 ${g} 0 0 0 0 ${b} 0.1 0 0 0 -0.04'/%3E%3C/filter%3E` +
    "%3Crect width='200' height='200' filter='url(%23n)'/%3E%3C/svg%3E";
  return `url("data:image/svg+xml,${svg}")`;
}
const GRAIN_DARK = grain([0.95, 0.88, 0.78]);
const GRAIN_LIGHT = grain([0.15, 0.1, 0.05]);

// Flowcode palette, used until the desktop sends its own.
const DEFAULTS = {
  dark: { bg: "#0e0a07", "--fg": "#e7d8c5", "--fg-muted": "#a08a6f", "--accent": "#9db984", "--accent-2": "#c9975a", "--on-accent": "#0e0a07", "--ansi-red": "#e2645c", "--ansi-yellow": "#d1a752", "--ansi-blue": "#6f9bcf" },
  light: { bg: "#fffaf1", "--fg": "#3a2b17", "--fg-muted": "#8b7457", "--accent": "#4f6e3a", "--accent-2": "#a8683a", "--on-accent": "#ffffff", "--ansi-red": "#b3382b", "--ansi-yellow": "#9a6414", "--ansi-blue": "#2f5f9c" },
} as const;

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const ANSI_FALLBACK = ["#1c1814", "#e2645c", "#9db984", "#d1a752", "#6f9bcf", "#b48ead", "#6fb5b0", "#e7d8c5"];

export function applyTheme(settings: MirroredSettings | null) {
  const mode: "light" | "dark" =
    settings?.resolvedTheme ?? (typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const dark = mode === "dark";
  const d = DEFAULTS[mode] as Record<string, string>;
  const c = (k: string) => settings?.colors[k] ?? d[k];

  const bg = c("bg");
  const fg = c("--fg");
  const accent = c("--accent");
  const yellow = c("--ansi-yellow");
  const blue = c("--ansi-blue");
  const red = c("--ansi-red");
  const page = mix(bg, fg, 0.04);

  const vars: Record<string, string> = {
    "--bg": page,
    "--surface": mix(page, fg, 0.06),
    "--surface-2": mix(page, fg, 0.09),
    "--surface-3": mix(page, fg, 0.13),
    "--border": settings?.colors["--border"] ?? alpha(fg, 0.12),
    "--border-strong": alpha(fg, 0.2),
    "--fg": fg,
    "--muted": c("--fg-muted"),
    "--accent": accent,
    "--accent-2": c("--accent-2"),
    "--accent-bg": alpha(accent, 0.12),
    "--accent-border": alpha(accent, 0.3),
    "--on-accent": c("--on-accent"),
    "--wait": yellow,
    "--wait-bg": alpha(yellow, 0.08),
    "--wait-border": alpha(yellow, 0.28),
    "--busy": blue,
    "--busy-bg": alpha(blue, 0.09),
    "--danger": red,
    "--shadow": dark ? "0 10px 30px rgba(0, 0, 0, 0.45)" : "0 10px 30px rgba(60, 50, 20, 0.16)",
    "--glass": dark ? alpha(fg, 0.045) : "rgba(255, 255, 255, 0.55)",
    "--glass-strong": alpha(bg, 0.62),
    "--grain": dark ? GRAIN_DARK : GRAIN_LIGHT,
    "--term-bg": dark ? mix(bg, "#000000", 0.45) : mix(bg, "#ffffff", 0.6),
    "--term-border": alpha(fg, 0.18),
  };

  // Terminal palette: its own colors when the desktop has a separate one.
  const tc = settings?.terminalColors ?? {};
  vars["--term-fg"] = tc["--term-fg"] ?? fg;
  vars["--term-cursor"] = tc["--term-cursor"] ?? tc["--accent"] ?? accent;
  vars["--term-selection"] = tc["--term-selection-bg"] ?? alpha(accent, 0.3);
  ANSI.forEach((n, i) => {
    vars[`--ansi-${n}`] = tc[`--ansi-${n}`] ?? settings?.colors[`--ansi-${n}`] ?? ANSI_FALLBACK[i];
    vars[`--ansi-bright-${n}`] = tc[`--ansi-bright-${n}`] ?? settings?.colors[`--ansi-bright-${n}`] ?? vars[`--ansi-${n}`];
  });

  const root = document.documentElement;
  for (const k in vars) root.style.setProperty(k, vars[k]);
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
}

// ---- Phone-only theme -------------------------------------------------------
// An optional override of the desktop's theme/palette, kept on the phone only
// and never sent to the desktop. Each field falls back to the mirrored value.
interface PhoneTheme {
  enabled: boolean;
  theme: "auto" | "light" | "dark" | null;
  palette: string | null;
}

const PHONE_THEME_KEY = "flowcode.phoneTheme";

function loadPhoneTheme(): PhoneTheme {
  const out: PhoneTheme = { enabled: false, theme: null, palette: null };
  const raw = safeStorage.get(PHONE_THEME_KEY);
  if (!raw) return out;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    out.enabled = v.enabled === true;
    out.theme = v.theme === "auto" || v.theme === "light" || v.theme === "dark" ? v.theme : null;
    out.palette = typeof v.palette === "string" ? v.palette : null;
  } catch {
    // Corrupt cache: start from the defaults.
  }
  return out;
}

export const phoneTheme = createStore<PhoneTheme>(loadPhoneTheme());

/** Updates the phone-only theme; when enabled, empty fields are seeded from the mirrored settings. */
export function setPhoneTheme(patch: Partial<PhoneTheme>, mirrored?: MirroredSettings | null) {
  const next = { ...phoneTheme.get(), ...patch };
  if (next.enabled && mirrored) {
    next.theme ??= mirrored.theme;
    next.palette ??= mirrored.palette;
  }
  phoneTheme.set(next);
  safeStorage.set(PHONE_THEME_KEY, JSON.stringify(next));
}

/** Theme and palette the phone actually shows (an unknown stored palette id falls back to the mirrored one). */
export function effectivePhone(s: MirroredSettings, local: PhoneTheme): { theme: "auto" | "light" | "dark"; palette: string; local: boolean } {
  if (!local.enabled) return { theme: s.theme, palette: s.palette, local: false };
  const known = local.palette !== null && s.palettes.some((p) => p.id === local.palette);
  return { theme: local.theme ?? s.theme, palette: known ? (local.palette as string) : s.palette, local: true };
}

const luma = (c: string) => {
  const [r, g, b] = parse(c);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/** The mirrored settings with the phone-only theme/palette applied; the same object when there is no override. */
export function withPhoneTheme(s: MirroredSettings | null, local: PhoneTheme): MirroredSettings | null {
  if (!s || !local.enabled) return s;
  const e = effectivePhone(s, local);
  const sysLight = typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: light)").matches;
  const mode: "light" | "dark" = e.theme === "auto" ? (sysLight ? "light" : "dark") : e.theme;
  if (e.palette === s.palette && mode === s.resolvedTheme) return { ...s, theme: e.theme };
  const p = s.palettes.find((x) => x.id === e.palette);
  // Only the swatch (bg + two accents) is known for other palettes: derive the rest.
  const wantDark = mode === "dark";
  const base = p?.bg ?? DEFAULTS[mode].bg;
  const bg = luma(base) < 0.5 === wantDark ? base : mix(base, wantDark ? "#000000" : "#ffffff", 0.9);
  const fg = wantDark ? mix(bg, "#ffffff", 0.88) : mix(bg, "#000000", 0.85);
  const accent = p?.accent ?? DEFAULTS[mode]["--accent"];
  const colors: Record<string, string> = {};
  for (const k in s.colors) if (k.startsWith("--ansi-")) colors[k] = s.colors[k];
  Object.assign(colors, {
    bg,
    "--fg": fg,
    "--fg-muted": mix(bg, fg, 0.6),
    "--accent": accent,
    "--accent-2": p?.accent2 ?? DEFAULTS[mode]["--accent-2"],
    "--on-accent": luma(accent) > 0.55 ? "#111111" : "#ffffff",
  });
  return { ...s, theme: e.theme, resolvedTheme: mode, palette: e.palette, colors };
}
