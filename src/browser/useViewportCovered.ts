// Detects a DOM overlay (menu, dialog, popover...) sitting over the browser
// viewport. The native page view is not part of the DOM and always paints above
// it, so the viewport div is what the DOM has under the page: when
// `elementFromPoint` finds something else on top of it, an overlay is there and
// the native view has to give way (see BrowserPanel's freeze frame).
import { useEffect, useState, type RefObject } from "react";

const INSET = 6;
const RECHECK_MS = 250;

export interface ViewportState {
  /** Connected, not in a collapsed panel and not zero-sized: a native view may be shown. */
  visible: boolean;
  /** Something other than the viewport (or its own children) is on top of it. */
  covered: boolean;
}

/** An overlay smaller than this on either side is a handle, a glow or a stroke, not a menu. */
const MIN_OVERLAY_PX = 12;
/** Ancestors this transparent (fading out, invisible hit areas) don't count as covering. */
const MIN_OPACITY = 0.05;

/**
 * Whether the element found over the viewport is a real overlay (a menu, a
 * dialog...) rather than something that only happens to be hit there:
 * splitter grab zones and edge glows reaching over the panel, elements fading
 * out at opacity 0, invisible hit areas. Those used to freeze and re-show the
 * page for nothing, which read as a jump.
 */
function isRealOverlay(top: Element): boolean {
  let root: Element | null = null;
  for (let n: Element | null = top; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (Number(cs.opacity) < MIN_OPACITY || cs.visibility === "hidden") return false;
    // The outermost positioned box is the overlay itself (an icon inside a menu item may be positioned too).
    if (cs.position === "fixed" || cs.position === "absolute") root = n;
  }
  const r = (root ?? top).getBoundingClientRect();
  return r.width >= MIN_OVERLAY_PX && r.height >= MIN_OVERLAY_PX;
}

function sample(el: HTMLElement): ViewportState {
  if (!el.isConnected || el.closest(".is-hidden")) return { visible: false, covered: false };
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return { visible: false, covered: false };
  const xs = r.width > INSET * 4 ? [r.left + INSET, r.left + r.width / 2, r.right - INSET] : [r.left + r.width / 2];
  const ys = r.height > INSET * 4 ? [r.top + INSET, r.top + r.height / 2, r.bottom - INSET] : [r.top + r.height / 2];
  for (const y of ys) {
    for (const x of xs) {
      const top = document.elementFromPoint(x, y);
      // Outside the window, or the viewport's own content (load bar, freeze frame, toast).
      if (!top || el.contains(top) || top.closest("[data-cover-ignore]") || !isRealOverlay(top)) continue;
      return { visible: true, covered: true };
    }
  }
  return { visible: true, covered: false };
}

/**
 * Tracks `viewportRef`'s visibility and whether a DOM overlay covers it.
 * While `enabled` is false (a panel drag: the viewport ignores pointers then)
 * the last state is kept and nothing is sampled.
 */
export function useViewportCovered(viewportRef: RefObject<HTMLElement | null>, enabled: boolean): ViewportState {
  const [state, setState] = useState<ViewportState>({ visible: false, covered: false });

  useEffect(() => {
    const el = viewportRef.current;
    if (!enabled || !el) return;
    let raf = 0;
    let timer = 0;
    let cancelled = false;
    let covered = false;

    const run = () => {
      raf = 0;
      if (cancelled) return;
      const next = sample(el);
      setState((prev) => (prev.visible === next.visible && prev.covered === next.covered ? prev : next));
      // Uncovering has no DOM event of its own for every overlay: poll while covered.
      if (next.covered && !covered) timer = window.setInterval(schedule, RECHECK_MS);
      else if (!next.covered && covered) window.clearInterval(timer);
      covered = next.covered;
    };
    function schedule() {
      if (!raf) raf = requestAnimationFrame(run);
    }
    // After a click or key the overlay opens on the next render: look again on the next frame.
    const afterInput = () => requestAnimationFrame(schedule);

    schedule();
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "open", "hidden"] });
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    window.addEventListener("resize", schedule);
    document.addEventListener("pointerdown", afterInput, true);
    document.addEventListener("keydown", afterInput, true);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      window.clearInterval(timer);
      mo.disconnect();
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("pointerdown", afterInput, true);
      document.removeEventListener("keydown", afterInput, true);
    };
  }, [viewportRef, enabled]);

  return state;
}
