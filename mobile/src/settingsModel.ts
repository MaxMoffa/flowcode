// The settings the desktop mirrors to the phone: defaults, and the guards that
// make a cached or incoming object safe to render whatever shape it arrives in.
import type { MirroredSettings, ProfileInfo } from "../../shared/remote-types";

/** Used for any field a cached or incoming settings object lacks or gets wrong. */
/** @internal exported for tests */
export const DEFAULT_SETTINGS: MirroredSettings = {
  theme: "auto",
  resolvedTheme: "dark",
  palette: "",
  terminalPalette: null,
  contrast: 0.5,
  glassOpacity: 0.5,
  language: "system",
  resolvedLanguage: "en",
  languages: [],
  colors: {},
  terminalColors: {},
  palettes: [],
  terminalFontSize: 14,
  bannerEnabled: true,
  confirmLinkOpen: true,
  restoreSession: true,
  newTabPage: false,
  notify: { done: true, input: true, exited: false, limitReset: true },
  autoResume: { enabled: false, message: "" },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, min = -Infinity, max = Infinity) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const k in v) if (typeof v[k] === "string") out[k] = v[k] as string;
  return out;
}

/** Merges a cached or incoming settings object over the defaults, dropping anything of the wrong shape. Null when it isn't an object at all. */
/** @internal exported for tests */
export function normalizeSettings(raw: unknown): MirroredSettings | null {
  if (!isObj(raw)) return null;
  const d = DEFAULT_SETTINGS;
  const notify = isObj(raw.notify) ? raw.notify : {};
  const resume = isObj(raw.autoResume) ? raw.autoResume : {};
  const list = <T,>(v: unknown, ok: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.flatMap((x) => (isObj(x) ? (ok(x) ?? []) : [])) : [];
  return {
    theme: oneOf(raw.theme, ["auto", "light", "dark"], d.theme),
    resolvedTheme: oneOf(raw.resolvedTheme, ["light", "dark"], d.resolvedTheme),
    palette: str(raw.palette, d.palette),
    terminalPalette: typeof raw.terminalPalette === "string" ? raw.terminalPalette : null,
    contrast: num(raw.contrast, d.contrast, 0, 1),
    glassOpacity: num(raw.glassOpacity, d.glassOpacity, 0, 1),
    language: str(raw.language, d.language),
    resolvedLanguage: str(raw.resolvedLanguage, d.resolvedLanguage),
    languages: list(raw.languages, (x) => (typeof x.id === "string" ? { id: x.id, name: str(x.name, x.id) } : null)),
    colors: strMap(raw.colors),
    terminalColors: strMap(raw.terminalColors),
    palettes: list(raw.palettes, (x) =>
      typeof x.id === "string" ? { id: x.id, name: str(x.name, x.id), bg: str(x.bg, "#000000"), accent: str(x.accent, "#888888"), accent2: str(x.accent2, "#888888") } : null,
    ),
    terminalFontSize: num(raw.terminalFontSize, d.terminalFontSize, 9, 28),
    bannerEnabled: bool(raw.bannerEnabled, d.bannerEnabled),
    confirmLinkOpen: bool(raw.confirmLinkOpen, d.confirmLinkOpen),
    restoreSession: bool(raw.restoreSession, d.restoreSession),
    newTabPage: bool(raw.newTabPage, d.newTabPage),
    notify: {
      done: bool(notify.done, d.notify.done),
      input: bool(notify.input, d.notify.input),
      exited: bool(notify.exited, d.notify.exited),
      limitReset: bool(notify.limitReset, d.notify.limitReset),
    },
    autoResume: { enabled: bool(resume.enabled, d.autoResume.enabled), message: str(resume.message, d.autoResume.message) },
  };
}

/** The profile list as sent, dropping anything of the wrong shape. */
/** @internal exported for tests */
export function normalizeLoggedIn(raw: unknown): ProfileInfo["loggedIn"] | null {
  return isObj(raw) ? { claude: bool(raw.claude, false), codex: bool(raw.codex, false), vibe: bool(raw.vibe, false), gemini: bool(raw.gemini, false) } : null;
}

export function normalizeProfiles(raw: unknown): ProfileInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x) => {
    if (!isObj(x) || typeof x.id !== "string") return [];
    const color = typeof x.color === "string" && /^#[0-9a-fA-F]{6}$/.test(x.color) ? x.color : "#64748b";
    return [{ id: x.id, name: str(x.name, x.id), color, loggedIn: normalizeLoggedIn(x.loggedIn) ?? { claude: false, codex: false, vibe: false, gemini: false } }];
  });
}
