/** Colour palettes. A palette recolours the whole app and carries both a light
 * and a dark variant: the theme mode (auto/light/dark) only picks which of the
 * two is shown, so switching mode never switches palette.
 *
 * Each variant is a small set of base colours; everything else themes.css
 * defines (borders, hovers, selection, the 16 ANSI colours...) is derived
 * from them in `resolvePalette`. Derived values are computed to plain
 * hex/rgba here rather than left as CSS `color-mix()`: xterm.js and flowkit
 * both need concrete colours and can't parse a `color-mix()` string.
 *
 * The default palette applies nothing - themes.css already holds its
 * hand-tuned values - so its variants below are only used for the preview. */

export type ThemeKind = "light" | "dark";

export interface PaletteVariant {
  /** Panel/glass surface colour (its alpha comes from the opacity setting). */
  bg: string;
  fg: string;
  fgMuted: string;
  accent: string;
  accent2: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
}

export interface Palette {
  id: string;
  name: string;
  light: PaletteVariant;
  dark: PaletteVariant;
}

export const DEFAULT_PALETTE_ID = "flowcode";

/** Plain black / white surfaces. Not tied to the theme mode: both variants of
 * each are the same, so picking one gives that surface in light and dark. */
const BLACK: PaletteVariant = { bg: "#000000", fg: "#f2f2f2", fgMuted: "#9a9a9a", accent: "#e0e0e0", accent2: "#b0b0b0", red: "#ff6b6b", green: "#6fdc8c", yellow: "#f0d060", blue: "#6ea8fe", magenta: "#d68cf0", cyan: "#5fd4e0" };
const WHITE: PaletteVariant = { bg: "#ffffff", fg: "#1a1a1a", fgMuted: "#5f5f5f", accent: "#333333", accent2: "#666666", red: "#c0392b", green: "#1f7a3a", yellow: "#8a6a00", blue: "#1f5fa8", magenta: "#8a3fa0", cyan: "#0f7488" };

export const PALETTES: readonly Palette[] = [
  {
    id: DEFAULT_PALETTE_ID,
    name: "Flowcode",
    light: { bg: "#fffaf1", fg: "#3a2b17", fgMuted: "#8b7457", accent: "#4f6e3a", accent2: "#a8683a", red: "#b33a3a", green: "#4f6e3a", yellow: "#8a6a1f", blue: "#33618f", magenta: "#8a4a86", cyan: "#2f7d7d" },
    dark: { bg: "#0e0a07", fg: "#e7d8c5", fgMuted: "#a08a6f", accent: "#9db984", accent2: "#c9975a", red: "#e2645c", green: "#9db984", yellow: "#d1a752", blue: "#6f9bcf", magenta: "#c98fc4", cyan: "#6fc2c2" },
  },
  {
    id: "ocean",
    name: "Ocean",
    light: { bg: "#f3f8fc", fg: "#17324a", fgMuted: "#64809a", accent: "#1f6fb2", accent2: "#0e8a8a", red: "#c0392b", green: "#2e7d4f", yellow: "#9a6b00", blue: "#1f5fa8", magenta: "#8e44ad", cyan: "#0f7c8a" },
    dark: { bg: "#08131d", fg: "#d6e6f2", fgMuted: "#7f9bb3", accent: "#5cb3ff", accent2: "#3ec9c0", red: "#ff6b6b", green: "#5fd39a", yellow: "#e6c15a", blue: "#6aa8ff", magenta: "#c792ea", cyan: "#5ad1e0" },
  },
  {
    id: "ember",
    name: "Ember",
    light: { bg: "#fff6f0", fg: "#3b1d12", fgMuted: "#94604c", accent: "#c2410c", accent2: "#b45309", red: "#b91c1c", green: "#4d7c0f", yellow: "#a16207", blue: "#2b5fa0", magenta: "#a1327a", cyan: "#0e7490" },
    dark: { bg: "#140a07", fg: "#f5dfd3", fgMuted: "#b5806a", accent: "#ff8a4c", accent2: "#f2b24a", red: "#ff6b5e", green: "#a8cc6a", yellow: "#f2c14e", blue: "#7aa7e6", magenta: "#e08bc0", cyan: "#6cc7d6" },
  },
  {
    id: "lavender",
    name: "Lavender",
    light: { bg: "#f8f5ff", fg: "#2a2140", fgMuted: "#7d70a0", accent: "#6d43c8", accent2: "#b0499a", red: "#c2334d", green: "#2f7d5a", yellow: "#96690f", blue: "#3b62c4", magenta: "#9b3fc0", cyan: "#1f7f8f" },
    dark: { bg: "#100c1c", fg: "#e6def8", fgMuted: "#9a8cc0", accent: "#b499ff", accent2: "#f18ac8", red: "#ff7391", green: "#7fdcaa", yellow: "#ebc865", blue: "#86a5ff", magenta: "#d58cf5", cyan: "#6ed3e6" },
  },
  {
    id: "rose",
    name: "Rose",
    light: { bg: "#fff5f7", fg: "#40202b", fgMuted: "#9a6273", accent: "#d1336f", accent2: "#c2603c", red: "#c0264a", green: "#3d7d4f", yellow: "#9a6a10", blue: "#3a5fa8", magenta: "#a3339a", cyan: "#1f7f86" },
    dark: { bg: "#170a10", fg: "#f7dde5", fgMuted: "#b98598", accent: "#ff6f9f", accent2: "#ffa26b", red: "#ff6b8a", green: "#8fd3a0", yellow: "#f0c96a", blue: "#85a5ee", magenta: "#e08ad8", cyan: "#72cdd6" },
  },
  {
    id: "mint",
    name: "Mint",
    light: { bg: "#f2fbf7", fg: "#12352a", fgMuted: "#5f8a7a", accent: "#0f8f6b", accent2: "#2f7fbf", red: "#c0392b", green: "#1f8a4c", yellow: "#8f6a08", blue: "#2a63b0", magenta: "#8a4aa0", cyan: "#0c8592" },
    dark: { bg: "#07140f", fg: "#d5f0e5", fgMuted: "#7fab99", accent: "#4fe0b0", accent2: "#62b6ff", red: "#ff7268", green: "#6fe0a0", yellow: "#e6c65a", blue: "#74a8f5", magenta: "#cf95ea", cyan: "#5ae0d0" },
  },
  {
    id: "graphite",
    name: "Graphite",
    light: { bg: "#f7f7f8", fg: "#1f2328", fgMuted: "#6b7280", accent: "#52606d", accent2: "#8a6d3b", red: "#c0392b", green: "#2f7d4a", yellow: "#8a6a10", blue: "#2f62a8", magenta: "#8a45a0", cyan: "#1f7a86" },
    dark: { bg: "#0c0d0f", fg: "#e4e6ea", fgMuted: "#8b919a", accent: "#b8c0cc", accent2: "#d0a86a", red: "#f0706a", green: "#7fd39a", yellow: "#e0c060", blue: "#78a8f0", magenta: "#c690e0", cyan: "#6ccbd8" },
  },
  {
    id: "nord",
    name: "Nord",
    light: { bg: "#eceff4", fg: "#2e3440", fgMuted: "#6b7690", accent: "#5e81ac", accent2: "#c0705a", red: "#bf616a", green: "#5f8a45", yellow: "#a0781f", blue: "#5e81ac", magenta: "#9a6f9b", cyan: "#3f8c98" },
    dark: { bg: "#2e3440", fg: "#d8dee9", fgMuted: "#8a93a8", accent: "#88c0d0", accent2: "#d08770", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#8fbcbb" },
  },
  {
    id: "solarized",
    name: "Solarized",
    light: { bg: "#fdf6e3", fg: "#4a6169", fgMuted: "#7f9095", accent: "#268bd2", accent2: "#cb4b16", red: "#dc322f", green: "#728300", yellow: "#a17800", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198" },
    dark: { bg: "#002b36", fg: "#93a1a1", fgMuted: "#657b83", accent: "#2aa198", accent2: "#cb4b16", red: "#dc322f", green: "#859900", yellow: "#b58900", blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198" },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    light: { bg: "#fbf1c7", fg: "#3c3836", fgMuted: "#7c6f64", accent: "#b57614", accent2: "#af3a03", red: "#9d0006", green: "#79740e", yellow: "#b57614", blue: "#076678", magenta: "#8f3f71", cyan: "#427b58" },
    dark: { bg: "#282828", fg: "#ebdbb2", fgMuted: "#a89984", accent: "#fabd2f", accent2: "#fe8019", red: "#fb4934", green: "#b8bb26", yellow: "#fabd2f", blue: "#83a598", magenta: "#d3869b", cyan: "#8ec07c" },
  },
  {
    id: "dracula",
    name: "Dracula",
    light: { bg: "#fffbeb", fg: "#1f1f1f", fgMuted: "#6c664b", accent: "#644ac9", accent2: "#a3144d", red: "#cb3a2a", green: "#14710a", yellow: "#846e15", blue: "#036a96", magenta: "#a3144d", cyan: "#0b7a8a" },
    dark: { bg: "#282a36", fg: "#f8f8f2", fgMuted: "#7b86b5", accent: "#bd93f9", accent2: "#ff79c6", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#6ea8ff", magenta: "#ff79c6", cyan: "#8be9fd" },
  },
  { id: "black", name: "Black", light: BLACK, dark: BLACK },
  { id: "white", name: "White", light: WHITE, dark: WHITE },
];

export function findPalette(id: string | null | undefined): Palette | undefined {
  return PALETTES.find((p) => p.id === id);
}

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
  return "#" + [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");
}

/** `weight` (0-1) of `b` mixed into `a`, as `#rrggbb`. */
function mix(a: string, b: string, weight: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex([0, 1, 2].map((i) => ca[i]! * (1 - weight) + cb[i]! * weight) as Rgb);
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque colours (1-21). */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Pure black or white, whichever reads better on `hex` - always at least 4.5:1. */
function readableOn(hex: string): string {
  return contrast("#000000", hex) >= contrast("#ffffff", hex) ? "#000000" : "#ffffff";
}

/** `color`, moved toward black or white (whichever `bg` contrasts with more)
 * by the smallest amount that reaches `min`:1 against `bg`. Unchanged if it
 * already does. */
function ensureContrast(color: string, bg: string, min: number): string {
  if (contrast(color, bg) >= min) return color;
  const target = readableOn(bg);
  if (contrast(target, bg) < min) return target;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (contrast(mix(color, target, mid), bg) >= min) hi = mid;
    else lo = mid;
  }
  return mix(color, target, hi);
}

function alpha(hex: string, a: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Contrast targets: body text well past WCAG AAA-ish, everything else that
 * is read as text (muted, accents, ANSI colours) past AA's 4.5. The small
 * margin over 4.5 absorbs the tinted overlays (hover, selection) drawn behind
 * text. */
const MIN_TEXT = 8;
const MIN_COLOR = 4.6;
const MAX_COLOR = 12;

/** The contrast level the palettes are designed at. The user's slider runs
 * 0-1 around it: below softens text toward `MIN_*`, above strengthens it. */
export const DEFAULT_CONTRAST = 0.5;

/** `color` moved toward `bg` (less contrast) or toward black/white (more)
 * until it is `target`:1 against `bg`, or as far as it can go. */
function moveToContrast(color: string, bg: string, target: number): string {
  const c = contrast(color, bg);
  if (Math.abs(c - target) < 0.05) return color;
  const lower = c > target;
  const end = lower ? bg : readableOn(bg);
  if (!lower && contrast(end, bg) <= target) return end;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    const cm = contrast(mix(color, end, mid), bg);
    if (lower ? cm <= target : cm >= target) hi = mid;
    else lo = mid;
  }
  return mix(color, end, hi);
}

/** Re-targets `color`'s contrast for the slider `level`: 0.5 keeps it as is,
 * 0 brings it down to `floor`:1, 1 raises it to `max`:1 (never lower than it
 * already is). */
function withContrastLevel(color: string, bg: string, level: number, floor: number, max: number): string {
  if (level === DEFAULT_CONTRAST) return color;
  const c = contrast(color, bg);
  const target =
    level < DEFAULT_CONTRAST
      ? floor + (c - floor) * (level / DEFAULT_CONTRAST)
      : c + Math.max(0, max - c) * ((level - DEFAULT_CONTRAST) / DEFAULT_CONTRAST);
  return moveToContrast(color, bg, Math.max(floor, target));
}

/** The variant with every colour used as text pushed, only if needed, to a
 * readable contrast against the surface it's drawn on - so a palette can be
 * written for looks and still never ship an unreadable combination. The
 * surface is taken as opaque `bg`: the glass is translucent, but the
 * contrast that matters is against the panel itself. The user's contrast
 * `level` then softens or strengthens that, but never below the floors. */
function readable(v: PaletteVariant, kind: ThemeKind, level: number): PaletteVariant {
  const dark = kind === "dark";
  const hover = mix(v.bg, v.fg, dark ? 0.13 : 0.1);
  const tab = mix(v.bg, "#000000", 0.03);
  const fg = ensureContrast(ensureContrast(v.fg, v.bg, MIN_TEXT), hover, 7.5);
  const fgMuted = ensureContrast(ensureContrast(ensureContrast(v.fgMuted, v.bg, MIN_COLOR), tab, MIN_COLOR), hover, MIN_COLOR);
  const on = (c: string) => withContrastLevel(ensureContrast(c, v.bg, MIN_COLOR), v.bg, level, MIN_COLOR, MAX_COLOR);
  const tunedFg = withContrastLevel(fg, v.bg, level, 7.5, 21);
  const tunedMuted = withContrastLevel(fgMuted, v.bg, level, MIN_COLOR, MAX_COLOR);
  const tunedHover = mix(v.bg, tunedFg, dark ? 0.13 : 0.1);
  return {
    ...v,
    fg: ensureContrast(tunedFg, tunedHover, 7.5),
    fgMuted: ensureContrast(ensureContrast(tunedMuted, tab, MIN_COLOR), tunedHover, MIN_COLOR),
    accent: on(v.accent),
    accent2: on(v.accent2),
    red: on(v.red),
    green: on(v.green),
    yellow: on(v.yellow),
    blue: on(v.blue),
    magenta: on(v.magenta),
    cyan: on(v.cyan),
  };
}

/** Every CSS custom property a palette variant sets on `:root`, keyed by name.
 * Same set themes.css defines per theme, minus `--surface-alpha` (the opacity
 * slider owns that one). */
export function resolvePalette(
  raw: PaletteVariant,
  kind: ThemeKind,
  level = DEFAULT_CONTRAST,
): Record<string, string> {
  const dark = kind === "dark";
  const v = readable(raw, kind, level);
  const bright = (hue: string) => ensureContrast(mix(hue, "#ffffff", dark ? 0.22 : 0.18), v.bg, MIN_COLOR);
  const [r, g, b] = parseHex(v.bg);
  // Worst case behind text: the selected row / active tab (accent tint) and
  // the terminal's selection highlight.
  // Tinted fills use the accent as designed, not as the contrast slider moved
  // it - otherwise a high setting lightens the row behind its own text.
  const tint = readable(raw, kind, DEFAULT_CONTRAST).accent;
  const selectedRow = mix(v.bg, tint, 0.22);
  const selection = mix(v.bg, tint, 0.3);
  return {
    "--surface-rgb": `${r} ${g} ${b}`,
    "--fg": v.fg,
    "--fg-muted": v.fgMuted,
    "--border": alpha(v.fg, dark ? 0.12 : 0.16),
    "--window-border": dark ? "rgba(0, 0, 0, 0.55)" : alpha(v.fg, 0.28),
    "--accent": v.accent,
    "--accent-tint": tint,
    "--accent-2": v.accent2,
    "--on-accent": readableOn(v.accent),
    "--on-accent-2": readableOn(v.accent2),
    "--on-danger": readableOn(v.red),
    "--ctrl-fg": alpha(v.fg, dark ? 0.85 : 0.86),
    "--ctrl-hover-bg": alpha(v.fg, dark ? 0.1 : 0.07),
    "--sidebar-hover": alpha(v.fg, dark ? 0.06 : 0.05),
    "--sidebar-selected-bg": alpha(tint, dark ? 0.22 : 0.16),
    "--sidebar-selected-fg": ensureContrast(mix(v.fg, v.accent, 0.12), selectedRow, 7.5),
    "--term-fg": ensureContrast(v.fg, selection, 5),
    "--term-selection-bg": alpha(tint, dark ? 0.3 : 0.25),
    "--ansi-black": dark ? mix(v.bg, v.fg, 0.22) : v.fg,
    "--ansi-red": v.red,
    "--ansi-green": v.green,
    "--ansi-yellow": v.yellow,
    "--ansi-blue": v.blue,
    "--ansi-magenta": v.magenta,
    "--ansi-cyan": v.cyan,
    "--ansi-white": ensureContrast(dark ? mix(v.fg, v.bg, 0.12) : mix(v.fg, v.bg, 0.3), v.bg, MIN_COLOR),
    "--ansi-bright-black": v.fgMuted,
    "--ansi-bright-red": bright(v.red),
    "--ansi-bright-green": bright(v.green),
    "--ansi-bright-yellow": bright(v.yellow),
    "--ansi-bright-blue": bright(v.blue),
    "--ansi-bright-magenta": bright(v.magenta),
    "--ansi-bright-cyan": bright(v.cyan),
    "--ansi-bright-white": v.fg,
  };
}

/** Colour tokens for the flowkit welcome overlay, from a palette variant. */
export function flowColors(raw: PaletteVariant, kind: ThemeKind, level = DEFAULT_CONTRAST) {
  const dark = kind === "dark";
  const v = readable(raw, kind, level);
  return {
    text: v.fg,
    text2: v.fgMuted,
    canvas: v.bg,
    soft: alpha(v.fg, dark ? 0.05 : 0.06),
    surface: mix(v.bg, v.fg, dark ? 0.05 : 0.04),
    border: alpha(v.fg, dark ? 0.12 : 0.16),
    accent: v.accent,
    accentSoft: alpha(v.accent, dark ? 0.22 : 0.16),
    success: v.green,
    successSoft: alpha(v.green, dark ? 0.22 : 0.16),
    warning: v.accent2,
    warningSoft: alpha(v.accent2, dark ? 0.2 : 0.18),
    danger: v.red,
    dangerSoft: alpha(v.red, dark ? 0.16 : 0.14),
  };
}

/** The custom properties to set on a terminal's own container to give just
 * that terminal a palette, whatever the rest of the app uses. `--accent` is
 * the cursor colour; `--term-bg` is spelled out with the panel opacity
 * because a `var(--surface)` inherited from `:root` would already be resolved
 * against the app's palette, not this one. */
export function resolveTerminalPalette(
  palette: Palette,
  kind: ThemeKind,
  level = DEFAULT_CONTRAST,
): Record<string, string> {
  const all = resolvePalette(palette[kind], kind, level);
  const vars: Record<string, string> = { "--accent": all["--accent"]! };
  for (const [name, value] of Object.entries(all)) {
    if (name.startsWith("--ansi-") || name === "--term-fg" || name === "--term-selection-bg") vars[name] = value;
  }
  vars["--term-bg"] = `rgb(${all["--surface-rgb"]} / var(--surface-alpha))`;
  return vars;
}
