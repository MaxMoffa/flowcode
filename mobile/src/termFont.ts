// The terminal text size on this device only: the desktop's own setting is
// just the starting point, so enlarging it here never changes the PC.
import { createStore, safeStorage } from "./store";

const KEY = "flowcode.termFontSize";
export const FONT_MIN = 9;
export const FONT_MAX = 28;

function load(): number | null {
  const n = Number(safeStorage.get(KEY));
  return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? Math.round(n) : null;
}

/** null = follow the desktop's size. */
export const phoneFontSize = createStore<{ size: number | null }>({ size: load() });

export function setPhoneFontSize(size: number) {
  const v = Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(size)));
  phoneFontSize.set({ size: v });
  safeStorage.set(KEY, String(v));
}
