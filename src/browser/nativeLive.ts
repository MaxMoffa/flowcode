// Which native browser views are on screen in this window. The context menu
// reads it to decide whether it has to leave the DOM (a native view always
// paints above it) for its own popup window.
const live = new Set<string>();

export function setNativeViewLive(pageId: string, isLive: boolean) {
  if (isLive) live.add(pageId);
  else live.delete(pageId);
}

export function hasLiveNativeView(): boolean {
  return live.size > 0;
}
