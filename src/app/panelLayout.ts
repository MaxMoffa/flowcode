// Pure horizontal layout for the docked side panels: which of the panels the
// user wants open actually fit next to the chat/terminal, and how wide each
// one is. No React here, so the rules are easy to test.

export type PanelKey = "sidebar" | "browser";

export interface PanelReq<K extends string = PanelKey> {
  key: K;
  /** The user's preferred width. */
  width: number;
  min: number;
}

export interface LayoutResult<K extends string = PanelKey> {
  /** Width to give each panel that is displayed. */
  shown: Partial<Record<K, number>>;
  /** Wanted open but without room: hidden until space returns, not closed. */
  parked: K[];
  /** The most each shown panel may grow to (for clamping a drag). */
  maxWidth: Partial<Record<K, number>>;
}

/** `available` is the content width of the body (without its padding),
 * `byPriority` the panels wanted open, most important first. A panel is kept
 * while the center keeps `centerMin`; the first one that doesn't fit and every
 * lower one are parked. The top panel is the exception: the user just asked
 * for it, so it stays (at its min if need be) even if it squeezes the center.
 * Whatever still overflows after that is taken from the browser first (it is
 * the elastic panel: opening it must not squeeze the explorer), then from the
 * lowest-priority panel up, each down to its min. */
export function solvePanels<K extends string = PanelKey>(
  available: number,
  centerMin: number,
  gap: number,
  byPriority: PanelReq<K>[],
): LayoutResult<K> {
  const kept: PanelReq<K>[] = [];
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
  const browserAt = kept.findIndex((p) => p.key === "browser");
  const shrinkOrder = kept.map((_, i) => kept.length - 1 - i).filter((i) => i !== browserAt);
  if (browserAt >= 0) shrinkOrder.unshift(browserAt);
  for (const i of shrinkOrder) {
    if (deficit <= 0) break;
    const take = Math.min(deficit, widths[i] - kept[i].min);
    widths[i] -= take;
    deficit -= take;
  }

  const total = widths.reduce((sum, w) => sum + w, 0);
  const shown: LayoutResult<K>["shown"] = {};
  const maxWidth: LayoutResult<K>["maxWidth"] = {};
  kept.forEach((p, i) => {
    shown[p.key] = widths[i];
    const room = available - centerMin - (total - widths[i]) - kept.length * gap;
    maxWidth[p.key] = Math.max(p.min, room);
  });
  return { shown, parked, maxWidth };
}
