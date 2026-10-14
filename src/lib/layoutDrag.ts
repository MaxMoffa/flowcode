/** Whether the user is dragging a layout splitter (a sidebar's edge). Panes
 * that are expensive to reflow - terminals - hold off refitting until the
 * drag ends instead of redrawing on every frame. */
let dragging = false;
const endListeners = new Set<() => void>();

export function setLayoutDragging(on: boolean): void {
  if (dragging === on) return;
  dragging = on;
  if (!on) for (const cb of [...endListeners]) cb();
}

export function isLayoutDragging(): boolean {
  return dragging;
}

/** Calls `cb` whenever a drag ends. Returns the unsubscribe function. */
export function onLayoutDragEnd(cb: () => void): () => void {
  endListeners.add(cb);
  return () => {
    endListeners.delete(cb);
  };
}
