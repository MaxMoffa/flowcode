/** How a sheet looks on the tablet layout: a centered dialog (forms, confirmations) or a side drawer (lists, menus, inspectors). */
export type SheetVariant = "dialog" | "drawer";
export type SheetSide = "left" | "right";
/** The edge a sheet slides in from, as `useSheetDrag` knows it. */
export type DragEdge = "down" | "left" | "right";

/**
 * The edge a finger drags toward to close the sheet, or null where touch can't close it.
 * Narrow screens keep the bottom sheet (or the side drawer a sheet already was on the phone);
 * wide screens drag a drawer toward its side and leave a dialog to Escape, Back and the scrim.
 */
export function dragEdge(wide: boolean, variant: SheetVariant, side: SheetSide, phoneDrawer: boolean): DragEdge | null {
  if (!wide) return phoneDrawer ? side : "down";
  return variant === "drawer" ? side : null;
}

/** The index Tab (or Shift+Tab) lands on among `count` focusable elements, wrapping at both ends; `current` is -1 when focus is outside them. */
export function wrapFocusIndex(current: number, count: number, backwards: boolean): number {
  if (count <= 0) return -1;
  if (current < 0) return backwards ? count - 1 : 0;
  return (current + (backwards ? -1 : 1) + count) % count;
}
