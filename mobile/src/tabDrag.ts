// Pure helpers for dragging a tab to a new place in the tablet tab strip.

/** A tab's box in the strip's content coordinates (the same space as the pointer once the strip's scroll is added). */
export interface TabRect {
  left: number;
  width: number;
}

/** The [start, end) range of the run of equal windows that contains index `i`. */
export function windowRange(windows: string[], i: number): { start: number; end: number } {
  let start = i;
  let end = i + 1;
  while (start > 0 && windows[start - 1] === windows[i]) start--;
  while (end < windows.length && windows[end] === windows[i]) end++;
  return { start, end };
}

/**
 * Where a dragged tab lands: its index among its window's tabs once it is lifted out.
 * `rects` are the window's tabs in order (the dragged one included, at `from`), `x` the pointer in the same space.
 * The tab goes after every other tab whose centre is left of the pointer, so the result is always inside the window.
 */
export function dropIndex(x: number, rects: TabRect[], from: number): number {
  let target = 0;
  rects.forEach((r, i) => {
    if (i !== from && r.left + r.width / 2 < x) target++;
  });
  return target;
}

/** `list` with the item at `from` moved so it ends up at `to` (both indexes within the list). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** `keys` with `key` moved to index `to` within the window range [start, end); the other windows stay put. */
export function moveWithinWindow(keys: string[], key: string, start: number, end: number, to: number): string[] {
  const from = keys.indexOf(key);
  if (from < start || from >= end) return keys;
  const clamped = Math.max(0, Math.min(to, end - start - 1));
  const win = moveItem(keys.slice(start, end), from - start, clamped);
  return [...keys.slice(0, start), ...win, ...keys.slice(end)];
}
