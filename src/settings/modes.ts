/** How the left side panel is laid out: "auto" docks it while there is room
 * next to the terminal and otherwise parks it (a click peeks it as a float). */
export type SidebarMode = "auto" | "docked" | "floating";
export const SIDEBAR_MODES: readonly SidebarMode[] = ["auto", "docked", "floating"];

/** "auto" follows the active terminal (clicking a folder actually `cd`s the
 * shell), but auto-suspends itself while that shell is busy with a
 * full-screen program - see TermTab.busy. "disconnesso" never `cd`s the
 * shell at all, regardless of busy state, until switched back by hand. */
export type ExplorerLinkMode = "auto" | "disconnesso";
export const EXPLORER_LINK_MODES: readonly ExplorerLinkMode[] = ["auto", "disconnesso"];
