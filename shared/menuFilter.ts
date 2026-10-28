/** Search and grouping shared by the desktop's menus and the phone's (both
 * import this, so the two stay in step). */

/** The phone's quick-actions library gets a search bar at its top once it has
 * more selectable rows than this; a shorter one is quicker to read than to filter. */
const SEARCH_MIN_ITEMS = 4;

export const needsSearch = (selectableCount: number): boolean => selectableCount > SEARCH_MIN_ITEMS;

/** Whether `label` matches what was typed (case-insensitive substring; blank matches all). */
export function matchesQuery(label: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || label.toLowerCase().includes(q);
}

/** The library's sections: the agent launchers first, then everything else. */
type MenuSectionId = "agents" | "tools";

export interface MenuSection<T> {
  id: MenuSectionId;
  items: T[];
}

/** Splits `items` into the agents and the tools sections, keeping each one's
 * order, after filtering by `query`; a section left empty is dropped. */
export function sectionMenu<T>(items: T[], query: string, labelOf: (item: T) => string, isAgent: (item: T) => boolean): MenuSection<T>[] {
  const shown = items.filter((i) => matchesQuery(labelOf(i), query));
  const sections: MenuSection<T>[] = [
    { id: "agents", items: shown.filter(isAgent) },
    { id: "tools", items: shown.filter((i) => !isAgent(i)) },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/** What a key does in a menu's search field: Escape clears the query before
 * it closes the menu, ArrowDown moves into the results, Enter runs the first. */
export type SearchKeyAction = "clear" | "close" | "down" | "run" | null;

export function searchKeyAction(key: string, query: string): SearchKeyAction {
  if (key === "Escape") return query === "" ? "close" : "clear";
  if (key === "ArrowDown") return "down";
  if (key === "Enter") return "run";
  return null;
}
