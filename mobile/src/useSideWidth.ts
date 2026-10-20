import { useEffect, useRef, useState } from "react";
import { safeStorage } from "./store";
import { useUiZoom } from "./uiScale";

interface Options {
  /** localStorage key of the width, one per panel. */
  key: string;
  /** The CSS width the panel has when not customized: the start of a drag before the panel is measured. */
  defaultWidth: number;
  min: number;
  max: number;
  /** Which edge the handle sits on: "right" for a left panel (dragging right grows it), "left" for a right panel. */
  edge: "left" | "right";
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** The stored width, or null when nothing usable is stored. */
function readWidth(key: string, min: number, max: number): number | null {
  const raw = safeStorage.get(key);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(n, min, max) : null;
}

/** A wide-layout panel's width, draggable from its inner edge and persisted. `width` null = not customized, so the CSS width applies. */
export function useSideWidth({ key, defaultWidth, min, max, edge }: Options) {
  const zoom = useUiZoom();
  const [width, setWidth] = useState(() => readWidth(key, min, max));
  const [dragging, setDragging] = useState(false);
  /** The drag in progress: where the pointer went down, and the width so far (null until the pointer moves). */
  const drag = useRef<{ startX: number; startWidth: number; zoom: number; current: number | null } | null>(null);

  /** The pending animation frame that applies the dragged width: one render per frame, not per pointer event. */
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  // Keeps the text under the pointer from being selected while the handle is dragged.
  useEffect(() => {
    if (!dragging) return;
    const prev = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.body.style.userSelect = prev;
    };
  }, [dragging]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const panel = e.currentTarget.parentElement;
    e.currentTarget.setPointerCapture(e.pointerId);
    // The panel's rendered width is zoomed, the CSS width is not: divide by the zoom.
    drag.current = {
      startX: e.clientX,
      startWidth: panel ? panel.getBoundingClientRect().width / zoom : defaultWidth,
      zoom,
      current: null,
    };
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.zoom;
    const grown = edge === "right" ? d.startWidth + dx : d.startWidth - dx;
    // Never more than 60% of the window, so the terminal keeps room.
    const cap = Math.max(min, Math.min(max, (window.innerWidth * 0.6) / d.zoom));
    d.current = clamp(grown, min, cap);
    if (!frame.current) {
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const c = drag.current?.current;
        if (c !== null && c !== undefined) setWidth(c);
      });
    }
  };

  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    if (d.current !== null) setWidth(d.current);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.current !== null) safeStorage.set(key, String(Math.round(d.current)));
    setDragging(false);
  };

  /** Double-click on the handle: back to the CSS width. */
  const onDoubleClick = () => {
    setWidth(null);
    safeStorage.remove(key);
  };

  return { width, dragging, handleProps: { onPointerDown, onPointerMove, onPointerUp: onPointerEnd, onPointerCancel: onPointerEnd, onDoubleClick } };
}
