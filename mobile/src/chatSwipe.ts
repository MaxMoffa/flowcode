// Two fingers swiping sideways across a chat cycle its views. One finger is
// always scrolling or selecting text, so only a deliberate two-finger move
// counts: both fingers travel the same way, mostly horizontally, without
// pinching.
import { useEffect, useRef, type RefObject } from "react";
import { tapFeedback } from "./haptics";

export interface Point {
  x: number;
  y: number;
}

/** Average horizontal travel (px) that makes a swipe. */
const MIN_TRAVEL = 64;
/** Each finger must have moved at least this far, the same way. */
const MIN_EACH = 32;
/** Horizontal travel must beat vertical by this factor, so a two-finger scroll isn't one. */
const AXIS_RATIO = 1.8;
/** How much the distance between the fingers may change (a fraction of it) before it is a pinch. */
const MAX_PINCH = 0.35;

const gap = ([a, b]: [Point, Point]) => Math.hypot(a.x - b.x, a.y - b.y);

/** +1 when both fingers moved left (the next view), -1 when right (the previous one), else 0. */
export function twoFingerSwipe(from: [Point, Point], to: [Point, Point]): -1 | 0 | 1 {
  const dx = [to[0].x - from[0].x, to[1].x - from[1].x];
  const dy = [to[0].y - from[0].y, to[1].y - from[1].y];
  const meanX = (dx[0] + dx[1]) / 2;
  const meanY = (dy[0] + dy[1]) / 2;
  if (Math.abs(meanX) < MIN_TRAVEL || Math.abs(meanX) < Math.abs(meanY) * AXIS_RATIO) return 0;
  // Both fingers, the same direction.
  if (dx.some((d) => Math.sign(d) !== Math.sign(meanX) || Math.abs(d) < MIN_EACH)) return 0;
  const before = gap(from);
  if (before > 0 && Math.abs(gap(to) - before) / before > MAX_PINCH) return 0;
  return meanX < 0 ? 1 : -1;
}

/** Calls `onSwipe` (with a haptic tick) when two fingers swipe across `ref`; a third finger or a lifted one cancels the gesture. */
export function useTwoFingerSwipe(ref: RefObject<HTMLElement | null>, onSwipe: (direction: -1 | 1) => void, enabled = true) {
  const swipe = useRef(onSwipe);
  swipe.current = onSwipe;
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let start: [Point, Point] | null = null;
    let last: [Point, Point] | null = null;
    let ids: [number, number] | null = null;

    const pair = (e: TouchEvent): [Point, Point] | null => {
      if (!ids) return null;
      const [a, b] = ids.map((id) => Array.from(e.touches).find((t) => t.identifier === id));
      return a && b ? [{ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }] : null;
    };
    const reset = () => {
      start = last = null;
      ids = null;
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        ids = [e.touches[0].identifier, e.touches[1].identifier];
        start = last = pair(e);
      } else {
        reset();
      }
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      const now = pair(e);
      if (now) last = now;
    };
    const onEnd = (e: TouchEvent) => {
      // The first finger up ends the gesture; the other one lifting later must not count again.
      if (!start || !last) return reset();
      const direction = twoFingerSwipe(start, last);
      reset();
      if (direction !== 0 && e.touches.length < 2) {
        tapFeedback();
        swipe.current(direction);
      }
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: true });
    el.addEventListener("touchend", onEnd, { passive: true });
    el.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", reset);
    };
  }, [ref, enabled]);
}
