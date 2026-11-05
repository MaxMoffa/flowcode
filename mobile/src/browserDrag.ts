import { useEffect, useRef, type RefObject } from "react";
import { releaseVelocity } from "./useSheetDrag";

/** The two heights the browser drawer rests at. */
export type Detent = "half" | "full";

/** Half height as a fraction of the visible viewport. */
export const HALF_RATIO = 0.62;
/** Vertical movement before a touch becomes a drag (below it, a tap on the grabber). */
const SLOP = 6;
/** How far ahead (ms) the release velocity projects the drawer's resting point. */
const PROJECT_MS = 180;

type Sample = { t: number; d: number };

/** Where a release settles: the nearest of closed, half and full to the height projected by the fling (velocity px/ms, positive = finger moving down). */
export function dragTarget(height: number, velocity: number, half: number, full: number): Detent | "closed" {
  const projected = height - velocity * PROJECT_MS;
  const options: [Detent | "closed", number][] = [["closed", 0], ["half", half], ["full", full]];
  let best = options[0];
  for (const option of options) if (Math.abs(option[1] - projected) < Math.abs(best[1] - projected)) best = option;
  return best[0];
}

/**
 * Lets a finger drag the browser drawer by its handle (grabber and toolbar) and settle on a
 * detent or close. While dragging, `--br-h` on the root follows the finger.
 */
export function useBrowserDrag(handleRef: RefObject<HTMLElement | null>, rootRef: RefObject<HTMLElement | null>, enabled: boolean, onRelease: (target: Detent | "closed") => void): void {
  const release = useRef(onRelease);
  release.current = onRelease;

  useEffect(() => {
    const handle = handleRef.current;
    const root = rootRef.current;
    if (!enabled || !handle || !root) return;

    let pointerId = -1;
    let startY = 0;
    let startHeight = 0;
    let dragging = false;
    let height = 0;
    let samples: Sample[] = [];

    const fullHeight = () => window.visualViewport?.height ?? window.innerHeight;

    function end() {
      pointerId = -1;
      if (dragging) {
        root!.classList.remove("is-dragging");
        root!.style.removeProperty("--br-h");
      }
      dragging = false;
    }

    function onDown(e: PointerEvent) {
      if (!e.isPrimary || (e.target as Element).closest("input, .br-btn")) return;
      pointerId = e.pointerId;
      startY = e.clientY;
      startHeight = root!.offsetHeight;
      dragging = false;
      samples = [];
    }

    function onMove(e: PointerEvent) {
      if (e.pointerId !== pointerId) return;
      const dy = e.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) < SLOP) return;
        dragging = true;
        // Capturing earlier would steal the grabber's click.
        handle!.setPointerCapture(e.pointerId);
        root!.classList.add("is-dragging");
      }
      height = Math.min(Math.max(startHeight - dy, 0), fullHeight());
      root!.style.setProperty("--br-h", height + "px");
      samples.push({ t: e.timeStamp, d: e.clientY });
      while (samples.length > 1 && e.timeStamp - samples[0].t > 160) samples.shift();
    }

    function onUp(e: PointerEvent) {
      if (e.pointerId !== pointerId) return;
      const wasDragging = dragging;
      const full = fullHeight();
      const velocity = releaseVelocity(samples, e.timeStamp);
      end();
      if (wasDragging && e.type === "pointerup") release.current(dragTarget(height, velocity, full * HALF_RATIO, full));
    }

    handle.addEventListener("pointerdown", onDown);
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
    return () => {
      handle.removeEventListener("pointerdown", onDown);
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      end();
    };
  }, [handleRef, rootRef, enabled]);
}
