/** The settings the phone can read and change (see docs/remote-protocol.md),
 * as one table: each key has a validator for the value the phone sends. The
 * bridge applies a change only when it passes, so a malformed or unknown value
 * is ignored instead of resetting anything. Pure, so it can be unit-tested. */

export const MAX_MESSAGE_LENGTH = 500;
export const THEME_MODES = ["auto", "light", "dark"] as const;
export const NOTIFY_KINDS = ["done", "input", "exited", "limitReset"] as const;

/** What validators need to know about the running app. */
export interface SettingContext {
  /** Language codes the app ships. */
  languages: readonly string[];
  /** Whether a palette id exists. */
  hasPalette: (id: string) => boolean;
}

export interface SettingDef {
  key: string;
  isValid: (value: unknown, ctx: SettingContext) => boolean;
}

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

export const SETTING_DEFS: readonly SettingDef[] = [
  { key: "theme", isValid: (v) => isStr(v) && (THEME_MODES as readonly string[]).includes(v) },
  { key: "palette", isValid: (v, c) => isStr(v) && c.hasPalette(v) },
  // null = follow the app palette.
  { key: "terminalPalette", isValid: (v, c) => v === null || (isStr(v) && c.hasPalette(v)) },
  { key: "contrast", isValid: isNum },
  { key: "glassOpacity", isValid: isNum },
  { key: "language", isValid: (v, c) => isStr(v) && (v === "system" || c.languages.includes(v)) },
  { key: "terminalFontSize", isValid: isNum },
  { key: "bannerEnabled", isValid: isBool },
  { key: "confirmLinkOpen", isValid: isBool },
  { key: "restoreSession", isValid: isBool },
  { key: "newTabPage", isValid: isBool },
  ...NOTIFY_KINDS.map((kind) => ({ key: `notify.${kind}`, isValid: isBool })),
  { key: "autoResume.enabled", isValid: isBool },
  { key: "autoResume.message", isValid: (v) => isStr(v) && v.length <= MAX_MESSAGE_LENGTH },
];

const BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

/** True when `key` is a known setting and `value` is acceptable for it. */
export function isValidSetting(key: string, value: unknown, ctx: SettingContext): boolean {
  return BY_KEY.get(key)?.isValid(value, ctx) ?? false;
}
