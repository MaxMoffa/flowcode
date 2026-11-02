import { useEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

export const SHORTCUT_HOLD_MS = 350;
const MOVE_TOLERANCE = 6;

export function moveShortcut(ids: string[], id: string, target: string): string[] {
  const from = ids.indexOf(id);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return ids;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

interface Press {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  bar: HTMLElement;
  scrollLeft: number;
  slots: { id: string; center: number }[];
  target: string;
  dragging: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** A short press runs the shortcut; a held press previews an order, saved on release. */
export function useQuickActionReorder(ids: string[], onMove: (id: string, target: string) => void) {
  const press = useRef<Press | null>(null);
  const suppressClick = useRef(false);
  const moveRef = useRef(onMove);
  moveRef.current = onMove;
  const [preview, setPreview] = useState<{ id: string; target: string } | null>(null);

  useEffect(() => {
    const finish = (commit: boolean) => {
      const current = press.current;
      if (!current) return;
      press.current = null;
      clearTimeout(current.timer);
      if (current.bar.hasPointerCapture(current.pointerId)) current.bar.releasePointerCapture(current.pointerId);
      setPreview(null);
      if (commit && current.dragging) moveRef.current(current.id, current.target);
    };
    const move = (event: PointerEvent) => {
      const current = press.current;
      if (!current || event.pointerId !== current.pointerId) return;
      if (!current.dragging) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) > MOVE_TOLERANCE) {
          // Touch scrolling stays available before the hold activates.
          if (event.pointerType === "touch") {
            current.bar.scrollLeft -= event.clientX - current.x;
            suppressClick.current = true;
            clearTimeout(current.timer);
            current.x = event.clientX;
            current.y = event.clientY;
          } else finish(false);
        }
        return;
      }
      event.preventDefault();
      const bounds = current.bar.getBoundingClientRect();
      if (event.clientX < bounds.left + 20) current.bar.scrollLeft -= 8;
      else if (event.clientX > bounds.right - 20) current.bar.scrollLeft += 8;
      const x = event.clientX + current.bar.scrollLeft - current.scrollLeft;
      const slot = current.slots.reduce((best, item) => Math.abs(item.center - x) < Math.abs(best.center - x) ? item : best);
      if (slot.id !== current.target) {
        current.target = slot.id;
        setPreview({ id: current.id, target: slot.id });
      }
    };
    const up = (event: PointerEvent) => { if (event.pointerId === press.current?.pointerId) finish(true); };
    const cancel = (event: PointerEvent) => { if (event.pointerId === press.current?.pointerId) finish(false); };
    // Touch transfers its implicit capture from the button to the bar.
    const lostCapture = (event: PointerEvent) => { if (event.target === press.current?.bar) cancel(event); };
    const blur = () => finish(false);
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && press.current) {
        event.preventDefault();
        finish(false);
      }
    };
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("lostpointercapture", lostCapture);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("lostpointercapture", lostCapture);
      window.removeEventListener("blur", blur);
      window.removeEventListener("keydown", key);
      const current = press.current;
      if (current) {
        clearTimeout(current.timer);
        press.current = null;
        if (current.bar.hasPointerCapture(current.pointerId)) current.bar.releasePointerCapture(current.pointerId);
      }
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || !event.isPrimary || press.current) return;
    suppressClick.current = false;
    const element = event.currentTarget;
    const bar = element.parentElement!;
    const current: Press = {
      id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      bar, scrollLeft: bar.scrollLeft,
      slots: Array.from(bar.querySelectorAll<HTMLElement>("[data-shortcut-id]")).map((item) => {
        const rect = item.getBoundingClientRect();
        return { id: item.dataset.shortcutId!, center: rect.left + rect.width / 2 };
      }),
      target: id, dragging: false,
      timer: setTimeout(() => {
        if (press.current !== current) return;
        current.dragging = true;
        suppressClick.current = true;
        // Capture on the stable bar: React moves the shortcut nodes during preview.
        bar.setPointerCapture(current.pointerId);
        setPreview({ id, target: id });
      }, SHORTCUT_HOLD_MS),
    };
    press.current = current;
  };

  const onClickCapture = (event: MouseEvent) => {
    if (!suppressClick.current || event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    ids: preview ? moveShortcut(ids, preview.id, preview.target) : ids,
    draggingId: preview?.id,
    onPointerDown,
    onClickCapture,
  };
}
