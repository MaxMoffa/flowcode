import { useCallback, useEffect, useRef, useState } from "react";

/** One observer per margin, shared by every element watching with it. */
const observers = new Map<string, { io: IntersectionObserver; callbacks: Map<Element, () => void> }>();

/** Calls `onNear` once when `el` first comes within `margin` of its scroll container's viewport; returns the stop function. */
function watchNear(el: Element, margin: string, onNear: () => void): () => void {
  let entry = observers.get(margin);
  if (!entry) {
    const callbacks = new Map<Element, () => void>();
    const io = new IntersectionObserver(
      (list) => {
        for (const e of list) {
          if (!e.isIntersecting) continue;
          const cb = callbacks.get(e.target);
          if (!cb) continue;
          callbacks.delete(e.target);
          io.unobserve(e.target);
          cb();
        }
      },
      { rootMargin: margin },
    );
    entry = { io, callbacks };
    observers.set(margin, entry);
  }
  const { io, callbacks } = entry;
  callbacks.set(el, onNear);
  io.observe(el);
  return () => {
    if (callbacks.delete(el)) io.unobserve(el);
  };
}

/**
 * `[ref, near]`: `near` turns true (and stays) once the element is within `margin` of the viewport.
 * Without IntersectionObserver (tests, old webviews) it is true from the start.
 */
export function useNearViewport<T extends Element = HTMLDivElement>(margin = "600px"): [(el: T | null) => void, boolean] {
  const supported = typeof IntersectionObserver !== "undefined";
  const [near, setNear] = useState(!supported);
  const stop = useRef<(() => void) | null>(null);
  const ref = useCallback(
    (el: T | null) => {
      stop.current?.();
      stop.current = null;
      if (el && supported) stop.current = watchNear(el, margin, () => setNear(true));
    },
    [margin, supported],
  );
  useEffect(() => () => stop.current?.(), []);
  return [ref, near];
}
