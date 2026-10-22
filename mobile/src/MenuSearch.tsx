import { useEffect, useRef, useState } from "react";
import { searchKeyAction } from "../../shared/menuFilter";
import { useEscape } from "./back";
import { t } from "./i18n";

/** A keyboard-less phone would have its bottom sheet buried under the on-screen
 * keyboard the moment a menu opened, so the search field only takes focus on
 * the tablet layout (`wide`), or when a mouse or trackpad is attached (a
 * hardware keyboard is the likely companion). Otherwise the field waits for a tap. */
function shouldAutofocus(wide: boolean): boolean {
  return wide || window.matchMedia("(any-pointer: fine)").matches;
}

/** The rows a search can land on, in the menu the field sits in. */
function rowsOf(input: HTMLElement | null): HTMLElement[] {
  const menu = input?.closest("[role=menu], [role=dialog]");
  return Array.from(menu?.querySelectorAll<HTMLElement>("[data-menu-row]:not(:disabled)") ?? []);
}

/** State and keys of a menu's search field: the query (emptied when the menu
 * closes), focus on open (see `shouldAutofocus`), Escape clearing the query
 * before it closes the menu, ArrowDown into the rows, Enter on the first. Mark
 * the rows `data-menu-row` and spread `menuProps` on the menu's root. */
export function useMenuSearch(open: boolean, onClose: () => void, wide: boolean) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEscape(open, () => (query === "" ? onClose() : setQuery("")));

  useEffect(() => {
    if (!open) setQuery("");
    else if (shouldAutofocus(wide)) input.current?.focus({ preventScroll: true });
  }, [open, wide]);

  return {
    query,
    setQuery,
    input,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      const action = searchKeyAction(e.key, query);
      if (action === "down" || action === "run") {
        e.preventDefault();
        const first = rowsOf(input.current)[0];
        if (action === "down") first?.focus();
        else first?.click();
      }
    },
    /** Up and down walk the rows; up from the first goes back to the field. */
    menuProps: {
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        if ((e.target as HTMLElement).closest("input")) return;
        e.preventDefault();
        const rows = rowsOf(input.current);
        const at = rows.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowUp" && at <= 0) input.current?.focus();
        else rows[e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1]?.focus();
      },
    },
  };
}

/** The field at the top of a menu or sheet. */
export function MenuSearch({ search }: { search: ReturnType<typeof useMenuSearch> }) {
  return (
    <input
      ref={search.input}
      className="menu-search"
      type="text"
      inputMode="search"
      enterKeyHint="go"
      autoComplete="off"
      autoCapitalize="off"
      spellCheck={false}
      placeholder={t("search")}
      aria-label={t("search")}
      value={search.query}
      onChange={(e) => search.setQuery(e.target.value)}
      onKeyDown={search.onKeyDown}
    />
  );
}
