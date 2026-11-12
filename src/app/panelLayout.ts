// Pure horizontal layout for the docked side panels: which of the panels the
// user wants open actually fit next to the chat/terminal, and how wide each
// one is. No React here, so the rules are easy to test.

export type PanelKey = "sidebar" | "browser" | "agents";

export interface PanelReq {
  key: PanelKey;
  /** The user's preferred width. */
  width: number;
  min: number;
}

export interface LayoutResult {
  /** Width to give each panel that is displayed. */
  shown: Partial<Record<PanelKey, number>>;
  /** Wanted open but without room: hidden until space returns, not closed. */
  parked: PanelKey[];
  /** The most each shown panel may grow to (for clamping a drag). */
  maxWidth: Partial<Record<PanelKey, number>>;
}

/** `available` is the content width of the body (without its padding),
 * `byPriority` the panels wanted open, most important first. A panel is kept
 * while the center keeps `centerMin`; the first one that doesn't fit and every
 * lower one are parked. The top panel is the exception: the user just asked
 * for it, so it stays (at its min if need be) even if it squeezes the center.
 * Whatever still overflows after that is taken from the lowest-priority panel
 * first, down to its min, then from the next one up. */
export function solvePanels(available: number, centerMin: number, gap: number, byPriority: PanelReq[]): LayoutResult {
  const kept: PanelReq[] = [];
  let used = centerMin;
  let cut = byPriority.length;
  for (let i = 0; i < byPriority.length; i++) {
    const need = byPriority[i].min + gap;
    if (i > 0 && used + need > available) {
      cut = i;
      break;
    }
    kept.push(byPriority[i]);
    used += need;
  }
  const parked = byPriority.slice(cut).map((p) => p.key);

  const widths = kept.map((p) => Math.max(p.width, p.min));
  let deficit = centerMin + widths.reduce((sum, w) => sum + w + gap, 0) - available;
  for (let i = kept.length - 1; i >= 0 && deficit > 0; i--) {
    const take = Math.min(deficit, widths[i] - kept[i].min);
    widths[i] -= take;
    deficit -= take;
  }

  const total = widths.reduce((sum, w) => sum + w, 0);
  const shown: LayoutResult["shown"] = {};
  const maxWidth: LayoutResult["maxWidth"] = {};
  kept.forEach((p, i) => {
    shown[p.key] = widths[i];
    const room = available - centerMin - (total - widths[i]) - kept.length * gap;
    maxWidth[p.key] = Math.max(p.min, room);
  });
  return { shown, parked, maxWidth };
}
