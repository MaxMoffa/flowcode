import { useCallback, useEffect, useRef, useState } from "react";
import { setLayoutDragging } from "../lib/layoutDrag";
import { readNumber, writeString } from "../lib/storage";

interface Options {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Which edge the drag handle sits on: "right" for a left-docked panel
   * (dragging right grows it), "left" for a right-docked panel (dragging
   * left grows it) - flips the sign on the pointer delta. */
  handleSide: "left" | "right";
  /** The most the layout allows right now (read during a drag), on top of `max`. */
  getMax?: () => number;
  /** The width actually on screen, which the layout may have shrunk below `width`: a drag starts from it. */
  getCurrent?: () => number | undefined;
}

/** A panel's width, draggable from one edge and persisted - shared by the
 * file explorer / settings / symbol-outline sidebar slot (left, handle on
 * the right) and the agents sidebar (right, handle on the left), so both
 * get the same resize behavior and clamping instead of two hand-rolled
 * versions drifting apart. */
export function useResizablePanelWidth({ storageKey, defaultWidth, min, max, handleSide, getMax, getCurrent }: Options) {
  const limitsRef = useRef({ getMax, getCurrent });
  limitsRef.current = { getMax, getCurrent };
  const [width, setWidth] = useState(() => readNumber(storageKey, defaultWidth, min, max));
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const captureRef = useRef<{ target: Element; pointerId: number; lost: () => void } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    setLayoutDragging(true);

    let raf = 0;
    let next = 0;
    function onMove(e: PointerEvent) {
      // The button was released before these listeners existed (a quick click): end the drag instead of following the mouse.
      if (e.buttons === 0) {
        onUp();
        return;
      }
      const delta = e.clientX - startXRef.current;
      const signedDelta = handleSide === "right" ? delta : -delta;
      const cap = Math.min(max, limitsRef.current.getMax?.() ?? max);
      next = Math.max(min, Math.min(cap, startWidthRef.current + signedDelta));
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        setWidth(next);
      });
    }
    function onUp() {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
        setWidth(next);
      }
      setDragging(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A cancelled pointer or a lost window focus never sends pointerup,
    // which would leave the drag stuck on.
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      setLayoutDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      const capture = captureRef.current;
      captureRef.current = null;
      if (capture) {
        capture.target.removeEventListener("lostpointercapture", capture.lost);
        try {
          if (capture.target.hasPointerCapture(capture.pointerId)) capture.target.releasePointerCapture(capture.pointerId);
        } catch {
          // The handle can disappear while its panel closes.
        }
      }
    };
  }, [dragging, handleSide, min, max]);

  // Persist once the drag actually ends, not on every intermediate frame.
  useEffect(() => {
    if (dragging) return;
    writeString(storageKey, String(width));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || captureRef.current) return;
      const target = e.currentTarget;
      const pointerId = e.pointerId;
      const lost = () => {
        captureRef.current = null;
        setLayoutDragging(false);
        setDragging(false);
      };
      captureRef.current = { target, pointerId, lost };
      // Attach before React's effect: a quick release may happen before that effect runs.
      target.addEventListener("lostpointercapture", lost, { once: true });
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // A detached handle cannot safely start a drag.
        target.removeEventListener("lostpointercapture", lost);
        captureRef.current = null;
        return;
      }
      startXRef.current = e.clientX;
      startWidthRef.current = limitsRef.current.getCurrent?.() ?? width;
      setDragging(true);
    },
    [width],
  );

  return { width, min, dragging, onHandlePointerDown };
}
