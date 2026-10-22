import { createStore, safeStorage } from "./store";

const KEY = "wide.panelMode";

/** How the tablet layout's side panels sit: docked beside the terminal from 1100 px (auto), docked from 760 px (fixed), or always floating. */
export type PanelMode = "auto" | "fixed" | "floating";

/** The window width from which the wide layout exists / panels dock on their own. */
const WIDE_MIN = 760;
const DOCK_MIN = 1100;
/** The narrowest the terminal card may get before the panels are no longer opened together. */
const TERMINAL_MIN = 360;

/** Whether the panels are docked, from the preference and two media queries (wide: >= 760 px, big: >= 1100 px). */
export function resolveDocked(mode: PanelMode, wide: boolean, big: boolean): boolean {
  if (mode === "fixed") return wide || big;
  if (mode === "floating") return false;
  return big;
}

/** The same decision from a window width in CSS px. */
export const dockedAtWidth = (mode: PanelMode, width: number): boolean => resolveDocked(mode, width >= WIDE_MIN, width >= DOCK_MIN);

/** Whether both panels beside the terminal still leave it its minimum (widths in CSS px, before the UI zoom). */
export function panelsFit(windowWidth: number, zoom: number, filesWidth: number, agentsWidth: number): boolean {
  // 8px padding each side and 8px gaps between the three cards.
  return windowWidth / zoom - 32 - filesWidth - agentsWidth >= TERMINAL_MIN;
}

const read = (): PanelMode => {
  const v = safeStorage.get(KEY);
  return v === "fixed" || v === "floating" ? v : "auto";
};

/** Phone-local, not mirrored to the desktop. */
const store = createStore<{ mode: PanelMode }>({ mode: read() });

export function setPanelMode(mode: PanelMode) {
  safeStorage.set(KEY, mode);
  store.set({ mode });
}

export const usePanelMode = (): PanelMode => store.useSelector((s) => s.mode);
