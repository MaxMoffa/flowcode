import { useEffect, useRef, type RefObject } from "react";

/** Calls `onClose` on a `mousedown` outside every one of `refs` (and, with
 * `escape`, on Escape) while `open`. `ignore` exempts targets that belong to
 * the menu without being inside its refs (a portaled list, the toggle button). */
export function useOutsideClose(
  open: boolean,
  refs: RefObject<HTMLElement | null>[],
  onClose: () => void,
  opts?: { escape?: boolean; ignore?: (target: Element) => boolean },
) {
  const latest = useRef({ refs, onClose, opts });
  latest.current = { refs, onClose, opts };
  const escape = opts?.escape ?? false;

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element;
      const { refs, onClose, opts } = latest.current;
      if (opts?.ignore?.(target)) return;
      if (!refs.some((r) => r.current?.contains(target))) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") latest.current.onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    if (escape) document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, escape]);
}
