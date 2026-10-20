import { useEffect, useRef, type RefObject } from "react";

/** The edge a sheet or drawer slides in from; dragging toward it closes. */
type SheetEdge = "down" | "left" | "right";

/** Movement before a touch is judged a scroll or a close drag. */
const SLOP = 8;
/** Fraction of the sheet that, dragged away, closes it. */
const CLOSE_FRACTION = 0.3;
/** Fling speed (px/ms) that closes regardless of distance. */
const CLOSE_VELOCITY = 0.5;
/** Window over which the release velocity is measured. */
const VELOCITY_WINDOW = 80;

type Sample = { t: number; d: number };

/** Whether a release closes: dragged far enough, or flung fast enough. */
export function shouldClose(distance: number, size: number, velocity: number): boolean {
  return distance > size * CLOSE_FRACTION || velocity > CLOSE_VELOCITY;
}

/** Speed (px/ms) over the last VELOCITY_WINDOW ms of samples; 0 with too little data. */
export function releaseVelocity(samples: Sample[], now: number): number {
  const recent = samples.filter((s) => now - s.t <= VELOCITY_WINDOW);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  return last.t > first.t ? (last.d - first.d) / (last.t - first.t) : 0;
}

const NO_DRAG = "input, textarea, select, [data-no-sheet-drag]";
const SCRIM = ".tm-scrim, .nts-scrim, .rc-scrim, [data-sheet-scrim]";

/** Whether `el` scrolls along the drag axis and can still scroll the way the finger pushes. */
function scrollsAgainst(el: HTMLElement, edge: SheetEdge): boolean {
  if (edge === "down") {
    const oy = getComputedStyle(el).overflowY;
    return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight && el.scrollTop > 0;
  }
  const ox = getComputedStyle(el).overflowX;
  if ((ox !== "auto" && ox !== "scroll") || el.scrollWidth <= el.clientWidth) return false;
  const max = el.scrollWidth - el.clientWidth;
  // A finger moving left scrolls to larger scrollLeft; moving right, to smaller.
  return edge === "left" ? el.scrollLeft < max - 1 : el.scrollLeft > 0;
}

/** Whether a touch starting on `target` is really scrolling content instead of dragging the sheet. */
function startsInScroll(target: Element, sheet: HTMLElement, edge: SheetEdge): boolean {
  for (let el: Element | null = target; el instanceof HTMLElement; el = el.parentElement) {
    if (scrollsAgainst(el, edge)) return true;
    if (el === sheet) break;
  }
  return false;
}

/**
 * Lets a finger drag a bottom sheet down (or a side drawer toward its edge) to close it, like a
 * native sheet. Scrolling inside the sheet works as usual: a drag only closes when it starts on
 * the grabber/header, or on a list already at its top. Releasing past 30% or with a fling calls
 * `onClose`; otherwise the sheet springs back.
 */
export function useSheetDrag(sheetRef: RefObject<HTMLElement | null>, onClose: () => void, enabled = true, edge: SheetEdge = "down"): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!enabled || !sheet) return;
    const el: HTMLElement = sheet;
    const vertical = edge === "down";
    // +1 when the closing direction grows the coordinate (down, right), -1 when it shrinks it (left).
    const sign = edge === "left" ? -1 : 1;
    const prev = el.previousElementSibling;
    const scrim = prev instanceof HTMLElement && prev.matches(SCRIM) ? prev : null;

    let startX = 0;
    let startY = 0;
    let tracking = false;
    let captured = false;
    let size = 1;
    let dist = 0;
    let samples: Sample[] = [];
    let swallowClick = false;
    let swallowTimer = 0;
    let resetTimer = 0;

    const translate = (d: number) => (vertical ? `translateY(${d}px)` : `translateX(${sign * d}px)`);

    function reset() {
      el.style.transform = "";
      el.style.transition = "";
      if (scrim) scrim.style.opacity = "";
    }

    function onStart(e: TouchEvent) {
      // A new touch ends the previous drag's leftovers: its spring-back reset and click swallowing.
      window.clearTimeout(swallowTimer);
      window.clearTimeout(resetTimer);
      swallowClick = false;
      tracking = false;
      captured = false;
      if (e.touches.length !== 1 || (e.target as Element).closest(NO_DRAG)) return;
      tracking = true;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dist = 0;
      samples = [];
      size = (vertical ? el.offsetHeight : el.offsetWidth) || 1;
    }

    function onMove(e: TouchEvent) {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      const along = sign * (vertical ? dy : dx);
      const across = vertical ? dx : dy;
      if (!captured) {
        if (Math.hypot(dx, dy) < SLOP) return;
        // Upward or sideways first moves, and scrolls inside a list, are never ours.
        if (along <= 0 || Math.abs(across) >= along || startsInScroll(e.target as Element, el, edge)) {
          tracking = false;
          return;
        }
        captured = true;
        el.style.transition = "none";
      }
      if (e.cancelable) e.preventDefault();
      dist = Math.max(0, along);
      samples.push({ t: e.timeStamp, d: dist });
      while (samples.length > 1 && e.timeStamp - samples[0].t > VELOCITY_WINDOW * 2) samples.shift();
      el.style.transform = translate(dist);
      if (scrim) scrim.style.opacity = String(Math.max(0, 1 - dist / size));
    }

    function onEnd(e: TouchEvent) {
      if (!tracking) return;
      tracking = false;
      if (!captured) return;
      captured = false;
      swallowClick = true;
      swallowTimer = window.setTimeout(() => (swallowClick = false), 400);
      if (e.type === "touchend" && shouldClose(dist, size, releaseVelocity(samples, e.timeStamp))) {
        // Keep the dragged position through the render that closes it, then hand over to the
        // closed-state CSS, which animates on from here.
        close.current();
        requestAnimationFrame(() => requestAnimationFrame(reset));
        return;
      }
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        reset();
        return;
      }
      el.style.transition = "transform 0.2s cubic-bezier(0.2, 0.8, 0.2, 1)";
      el.style.transform = translate(0);
      if (scrim) scrim.style.opacity = "";
      resetTimer = window.setTimeout(reset, 220);
    }

    // The click that follows a drag must not press the button under the finger.
    function onClick(e: MouseEvent) {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    }

    el.addEventListener("touchstart", onStart, { passive: true });
    // Non-passive, so a captured drag can stop the page and lists from scrolling too.
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("click", onClick, true);
      window.clearTimeout(swallowTimer);
      window.clearTimeout(resetTimer);
      reset();
    };
  }, [sheetRef, enabled, edge]);
}
