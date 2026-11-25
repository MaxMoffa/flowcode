/** Whether the layout is in motion: a splitter drag, a side panel animating
 * in or out, the window being resized. Panes that are expensive to reflow -
 * terminals - hold off refitting until it settles, then fit once. */
export type LayoutBusyReason = "drag" | "panel" | "window";

const counts: Record<LayoutBusyReason, number> = { drag: 0, panel: 0, window: 0 };
const endListeners = new Set<() => void>();
const changeListeners = new Set<() => void>();

function total(): number {
  return counts.drag + counts.panel + counts.window;
}

function changed(wasBusy: boolean): void {
  for (const cb of [...changeListeners]) cb();
  if (wasBusy && total() === 0) for (const cb of [...endListeners]) cb();
}

/** Marks the layout busy until the returned release is called (once; later calls are no-ops). */
export function beginLayoutBusy(reason: LayoutBusyReason): () => void {
  counts[reason]++;
  changed(false);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    counts[reason]--;
    changed(true);
  };
}

export function isLayoutBusy(reason?: LayoutBusyReason): boolean {
  return reason ? counts[reason] > 0 : total() > 0;
}

/** Calls `cb` whenever the layout settles (nothing busy any more). Returns the unsubscribe function. */
export function onLayoutBusyEnd(cb: () => void): () => void {
  endListeners.add(cb);
  return () => {
    endListeners.delete(cb);
  };
}

/** Calls `cb` on every busy change (for useSyncExternalStore). */
export function subscribeLayoutBusy(cb: () => void): () => void {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

let releaseDrag: (() => void) | null = null;

/** A splitter drag starts / ends. */
export function setLayoutDragging(on: boolean): void {
  if (on === !!releaseDrag) return;
  if (on) releaseDrag = beginLayoutBusy("drag");
  else {
    const release = releaseDrag;
    releaseDrag = null;
    release?.();
  }
}

const WINDOW_SETTLE_MS = 150;
let windowWatch = false;

/** Window resizes count as busy until no resize event came for a moment; also
 * flags `html.is-resizing` so CSS can drop transitions that would chase the size. */
export function watchWindowResize(): void {
  if (windowWatch || typeof window === "undefined") return;
  windowWatch = true;
  let release: (() => void) | null = null;
  let timer = 0;
  window.addEventListener("resize", () => {
    if (!release) {
      release = beginLayoutBusy("window");
      document.documentElement.classList.add("is-resizing");
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      document.documentElement.classList.remove("is-resizing");
      const r = release;
      release = null;
      r?.();
    }, WINDOW_SETTLE_MS);
  });
}
