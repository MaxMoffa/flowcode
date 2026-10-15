/** The arc that runs round a busy agent's outline (desktop tabs, phone rows):
 * dashes of a rounded rect with pathLength 100, moved at a constant speed by
 * a linear stroke-dashoffset animation from 0 to -100px (the CSS side). */

/** Length of the arc, head to tail end, in % of the outline. */
export const SWEEP_LENGTH = 45;
/** Slices the arc's fading tail is drawn in: enough for a smooth fade, few enough to keep the per-frame repaint cheap (each is an animated stroke). */
export const SWEEP_SLICES = 16;
/** One dash per slice, the tail end first. Each runs from its slice up to the
 * head (all end at SWEEP_LENGTH, so they move as one) and they stack: slice
 * k's opacity is picked so the stacked result at k is ((k + 1) / SWEEP_SLICES) ** 1.6.
 * Overlapping instead of butting leaves no seams between slices. */
export const SWEEP_DASHES = (() => {
  const step = SWEEP_LENGTH / SWEEP_SLICES;
  let below = 0;
  return Array.from({ length: SWEEP_SLICES }, (_, i) => {
    const start = i * step;
    const target = ((i + 1) / SWEEP_SLICES) ** 1.6;
    const opacity = 1 - (1 - target) / (1 - below);
    below = target;
    return { dasharray: `0 ${start} ${SWEEP_LENGTH - start} ${100 - SWEEP_LENGTH}`, opacity };
  });
})();
