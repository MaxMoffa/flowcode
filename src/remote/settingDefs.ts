/** The settings the phone can read and change (see docs/remote-protocol.md),
 * as one table: each key has a validator for the value the phone sends. The
 * bridge applies a change only when it passes, so a malformed or unknown value
 * is ignored instead of resetting anything. Pure, so it can be unit-tested. */

import type { SettingKey } from "../../shared/remote-types";

const MAX_MESSAGE_LENGTH = 500;
const THEME_MODES = ["auto", "light", "dark"] as const;

/** What validators need to know about the running app. */
export interface SettingContext {
  /** Language codes the app ships. */
  languages: readonly string[];
  /** Whether a palette id exists. */
  hasPalette: (id: string) => boolean;
}

type Validator = (value: unknown, ctx: SettingContext) => boolean;

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** A `Record` over `SettingKey`: a key added to the shared type without a
 * validator here (or the other way round) does not compile. */
const SETTING_DEFS: Record<SettingKey, Validator> = {
  theme: (v) => isStr(v) && (THEME_MODES as readonly string[]).includes(v),
  palette: (v, c) => isStr(v) && c.hasPalette(v),
  // null = follow the app palette.
  terminalPalette: (v, c) => v === null || (isStr(v) && c.hasPalette(v)),
  contrast: isNum,
  glassOpacity: isNum,
  language: (v, c) => isStr(v) && (v === "system" || c.languages.includes(v)),
  terminalFontSize: isNum,
  bannerEnabled: isBool,
  confirmLinkOpen: isBool,
  restoreSession: isBool,
  newTabPage: isBool,
  "notify.done": isBool,
  "notify.input": isBool,
  "notify.exited": isBool,
  "notify.limitReset": isBool,
  "autoResume.enabled": isBool,
  "autoResume.message": (v) => isStr(v) && v.length <= MAX_MESSAGE_LENGTH,
};

/** True when `key` is a known setting and `value` is acceptable for it. */
export function isValidSetting(key: string, value: unknown, ctx: SettingContext): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFS, key) ? SETTING_DEFS[key as SettingKey](value, ctx) : false;
}
