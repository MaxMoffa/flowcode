import { useCallback, useEffect, useRef, useState } from "react";

interface Options {
  storageKey: string;
  defaultWidth: number;
  min: number;
  max: number;
  /** Which edge the drag handle sits on: "right" for a left-docked panel
   * (dragging right grows it), "left" for a right-docked panel (dragging
   * left grows it) - flips the sign on the pointer delta. */
  handleSide: "left" | "right";
}

/** A panel's width, draggable from one edge and persisted - shared by the
 * file explorer / settings / symbol-outline sidebar slot (left, handle on
 * the right) and the agents sidebar (right, handle on the left), so both
 * get the same resize behavior and clamping instead of two hand-rolled
 * versions drifting apart. */
export function useResizablePanelWidth({ storageKey, defaultWidth, min, max, handleSide }: Options) {
  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(stored) && stored >= min && stored <= max) return stored;
    return defaultWidth;
  });
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  useEffect(() => {
    if (!dragging) return;

    function onMove(e: PointerEvent) {
      const delta = e.clientX - startXRef.current;
      const signedDelta = handleSide === "right" ? delta : -delta;
      setWidth(Math.max(min, Math.min(max, startWidthRef.current + signedDelta)));
    }
    function onUp() {
      setDragging(false);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, handleSide, min, max]);

  // Persist once the drag actually ends, not on every intermediate frame.
  useEffect(() => {
    if (dragging) return;
    localStorage.setItem(storageKey, String(width));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setDragging(true);
    },
    [width],
  );

  return { width, dragging, onHandlePointerDown };
}
