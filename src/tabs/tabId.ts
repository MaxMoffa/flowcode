// Carried across hot reloads in dev: Fast Refresh re-runs this module but
// keeps the tabs in state, so a counter back at 1 would hand the next tab an
// id one of them already has - and two tabs with the same id both count as
// active, rendering side by side.
let nextTabId: number = import.meta.hot?.data.nextTabId ?? 1;
import.meta.hot?.dispose((data) => {
  data.nextTabId = nextTabId;
});

/** A fresh, never-reused tab id: `tab-N`, `editor-N` or `diff-N`. */
export function newTabId(kind: "tab" | "editor" | "diff" = "tab"): string {
  return `${kind}-${nextTabId++}`;
}
