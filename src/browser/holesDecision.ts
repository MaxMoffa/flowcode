// Decides how a DOM overlay over the native browser view is handled on Windows:
// small overlays get a hole cut out of the view, big ones (scrims, drawers) keep
// the freeze frame.
import type { HoleRect } from "./nativeView";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An overlay covering more than this share of the viewport is a scrim or a drawer, not a menu. */
export const MAX_HOLE_SHARE = 0.45;
/** More separate overlays than this is not a menu situation: freeze instead. */
export const MAX_HOLES = 6;

function overlap(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The holes for these overlay boxes, or null when the freeze frame has to be used. */
export function decideHoles(viewport: Box, overlays: (Box & { r: number })[]): HoleRect[] | null {
  if (overlays.length > MAX_HOLES) return null;
  const area = viewport.w * viewport.h;
  if (area <= 0) return null;
  for (const o of overlays) if (overlap(o, viewport) > area * MAX_HOLE_SHARE) return null;
  return overlays.map((o) => ({ x: o.x, y: o.y, w: o.w, h: o.h, r: o.r }));
}

/** Same holes, compared on rounded numbers so sub-pixel jitter does not resend them. */
export function holesKey(holes: HoleRect[] | null): string {
  return holes ? holes.map((h) => [h.x, h.y, h.w, h.h, h.r].map(Math.round).join(",")).join(";") : "null";
}
