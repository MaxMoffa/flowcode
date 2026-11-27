import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

export const SHORTCUT_HOLD_MS = 350;
const MOVE_TOLERANCE = 6;
const LIFT = "translateY(-2px) scale(1.15)";

/** Where the lifted button sits: under the pointer at the grab point, kept inside the bar. */
export function followLeft(pointerX: number, grab: number, boundsLeft: number, boundsRight: number, width: number): number {
  return Math.max(boundsLeft, Math.min(pointerX - grab, boundsRight - width));
}

// Users who ask for less motion keep the follow and the placeholder, but lose the timed animations.
const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const findShortcut = (bar: HTMLElement, id: string) =>
  Array.from(bar.querySelectorAll<HTMLElement>("[data-shortcut-id]")).find((item) => item.dataset.shortcutId === id);

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
  /** Pointer distance from the button's left edge when pressed, so the button keeps that grip. */
  grab: number;
  lastX: number;
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
  const [pressingId, setPressingId] = useState<string | undefined>(undefined);
  const barRef = useRef<HTMLElement | null>(null);
  const lefts = useRef<Map<string, number>>(new Map());

  const order = preview ? moveShortcut(ids, preview.id, preview.target) : ids;

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar || !bar.isConnected) return;
    const next = new Map<string, number>();
    const animate = !reducedMotion();
    for (const item of Array.from(bar.querySelectorAll<HTMLElement>("[data-shortcut-id]"))) {
      const id = item.dataset.shortcutId!;
      const now = item.offsetLeft;
      next.set(id, now);
      const old = lefts.current.get(id);
      // FLIP: the other shortcuts slide from their old slot instead of jumping.
      if (animate && id !== preview?.id && old !== undefined && old !== now && item.animate) {
        item.animate([{ transform: `translateX(${old - now}px)` }, { transform: "none" }], { duration: 180, easing: "cubic-bezier(.2,.8,.3,1)" });
      }
    }
    lefts.current = next;
    // React moved the dragged wrapper to its new slot, so its lifted button needs a fresh offset.
    if (press.current?.dragging) follow(press.current);
  }, [order.join("|"), preview?.id]);

  /** Moves the lifted button imperatively: it tracks the pointer faster than React can render. */
  function follow(current: Press) {
    const wrapper = findShortcut(current.bar, current.id);
    const lifted = wrapper?.firstElementChild as HTMLElement | null | undefined;
    if (!wrapper || !lifted) return;
    const bounds = current.bar.getBoundingClientRect();
    // The wrapper is never transformed, so its rect is the slot; viewport coordinates already include the bar's scroll.
    const slot = wrapper.getBoundingClientRect();
    const left = followLeft(current.lastX, current.grab, bounds.left, bounds.right, slot.width);
    lifted.style.transform = `translateX(${left - slot.left}px) ${LIFT}`;
  }

  /** Drops the lifted button into its slot with a small settle. */
  function settle(current: Press) {
    const lifted = findShortcut(current.bar, current.id)?.firstElementChild as HTMLElement | null | undefined;
    if (!lifted) return;
    lifted.style.transform = "";
    if (!reducedMotion() && lifted.animate) lifted.animate([{ transform: "scale(1.1)" }, { transform: "none" }], { duration: 220, easing: "ease-out" });
  }

  useEffect(() => {
    const finish = (commit: boolean) => {
      const current = press.current;
      if (!current) return;
      press.current = null;
      clearTimeout(current.timer);
      if (current.bar.hasPointerCapture(current.pointerId)) current.bar.releasePointerCapture(current.pointerId);
      setPressingId(undefined);
      if (current.dragging) settle(current);
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
            setPressingId(undefined);
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
      current.lastX = event.clientX;
      follow(current);
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
        if (current.dragging) settle(current);
        if (current.bar.hasPointerCapture(current.pointerId)) current.bar.releasePointerCapture(current.pointerId);
      }
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.button !== 0 || !event.isPrimary || press.current) return;
    suppressClick.current = false;
    const element = event.currentTarget;
    const bar = element.parentElement!;
    barRef.current = bar;
    const rects = Array.from(bar.querySelectorAll<HTMLElement>("[data-shortcut-id]")).map((item) => ({ id: item.dataset.shortcutId!, rect: item.getBoundingClientRect() }));
    const own = rects.find((item) => item.id === id)?.rect;
    const current: Press = {
      id, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      bar, scrollLeft: bar.scrollLeft,
      slots: rects.map(({ id: slotId, rect }) => ({ id: slotId, center: rect.left + rect.width / 2 })),
      grab: own ? event.clientX - own.left : 0,
      lastX: event.clientX,
      target: id, dragging: false,
      timer: setTimeout(() => {
        if (press.current !== current) return;
        current.dragging = true;
        suppressClick.current = true;
        setPressingId(undefined);
        // Capture on the stable bar: React moves the shortcut nodes during preview.
        bar.setPointerCapture(current.pointerId);
        setPreview({ id, target: id });
      }, SHORTCUT_HOLD_MS),
    };
    press.current = current;
    setPressingId(id);
  };

  const onClickCapture = (event: MouseEvent) => {
    if (!suppressClick.current || event.detail === 0) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    ids: order,
    draggingId: preview?.id,
    pressingId,
    onPointerDown,
    onClickCapture,
  };
}
