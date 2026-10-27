import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { needsSearch, matchesQuery, searchKeyAction } from "../../shared/menuFilter";
import { useI18n } from "../i18n";
import { MenuIcons } from "./menuIcons";
import "./context-menu.css";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
  /** Renders this instead of the standard icon/label button - for compound
   * rows (e.g. a browser-style zoom control) that don't fit the plain
   * label+action shape. `label` still has to be unique for React's key. */
  custom?: ReactNode;
  /** Turns this row into a flyout parent (one level deep) - clicking it opens
   * these items in a second panel next to it instead of running `onSelect`. */
  submenu?: ContextMenuItem[];
}

/** The rows a search can land on (not separators or compound rows). */
const isSelectable = (item: ContextMenuItem) => !item.separator && !item.custom;

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

interface ContextMenuContextValue {
  show: (x: number, y: number, items: ContextMenuItem[]) => void;
  hide: () => void;
}

const ContextMenuCtx = createContext<ContextMenuContextValue | null>(null);

export function useContextMenu() {
  const ctx = useContext(ContextMenuCtx);
  if (!ctx) throw new Error("useContextMenu must be used within ContextMenuProvider");
  return ctx;
}

/** Text inputs a Cut/Paste makes sense in (a checkbox or a button doesn't). */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number", ""]);

/** The menu for right-clicking somewhere no component has its own menu:
 * clipboard actions on a text field or a selection, nothing otherwise. The
 * browser's own menu is never shown - this replaces it. */
function fallbackMenuItems(target: EventTarget | null, t: (key: "edit.cut" | "edit.copy" | "edit.paste" | "edit.selectAll") => string): ContextMenuItem[] {
  const el = target instanceof HTMLElement ? target : null;
  const field = el?.closest<HTMLElement>("input, textarea, [contenteditable=''], [contenteditable='true']") ?? null;
  const isTextField =
    field instanceof HTMLTextAreaElement ||
    (field instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(field.type)) ||
    (field !== null && field.isContentEditable);
  const readOnly = !!field && ((field as HTMLInputElement).readOnly || (field as HTMLInputElement).disabled);
  const inField = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement;
  const selected = inField
    ? field.value.slice(field.selectionStart ?? 0, field.selectionEnd ?? 0)
    : (window.getSelection()?.toString() ?? "");

  if (!isTextField) {
    return selected ? [{ label: t("edit.copy"), icon: MenuIcons.duplicate, onSelect: () => void navigator.clipboard.writeText(selected).catch(() => {}) }] : [];
  }
  const focusField = () => field?.focus();
  return [
    {
      label: t("edit.cut"),
      icon: MenuIcons.cut,
      disabled: readOnly || !selected,
      onSelect: () => {
        focusField();
        document.execCommand("cut");
      },
    },
    {
      label: t("edit.copy"),
      icon: MenuIcons.duplicate,
      disabled: !selected,
      onSelect: () => void navigator.clipboard.writeText(selected).catch(() => {}),
    },
    {
      label: t("edit.paste"),
      icon: MenuIcons.paste,
      disabled: readOnly,
      onSelect: () => {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (!text) return;
            focusField();
            document.execCommand("insertText", false, text);
          })
          .catch(() => {});
      },
    },
    { label: "edit-separator", separator: true },
    {
      label: t("edit.selectAll"),
      icon: MenuIcons.selectAll,
      onSelect: () => {
        focusField();
        if (inField) field.select();
        else document.execCommand("selectAll");
      },
    },
  ];
}

/** Convenience wrapper: pass straight to a React element's onContextMenu. */
export function useOpenContextMenu() {
  const { show } = useContextMenu();
  return useCallback(
    (e: React.MouseEvent, items: ContextMenuItem[]) => {
      e.preventDefault();
      e.stopPropagation();
      show(e.clientX, e.clientY, items);
    },
    [show],
  );
}

/** Clicking a menu row must not pull focus (and the selection with it) out of
 * the field it was opened on - except into the menu's own inputs. */
function keepFocus(e: React.MouseEvent) {
  if (!(e.target as HTMLElement).closest("input, textarea")) e.preventDefault();
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  /** What had focus when the menu opened: it gets it back, as the search bar takes it while open. */
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // The flyout is one level deep and always spawned from the top-level menu
  // that's currently open - index into `menu.items`, not a separate menu
  // stack, so it's automatically torn down whenever `menu` itself closes.
  const [submenuOpenAt, setSubmenuOpenAt] = useState<{ index: number; x: number; y: number; parentLeft: number } | null>(null);

  const hide = useCallback(() => {
    returnFocusRef.current?.focus();
    returnFocusRef.current = null;
    setMenu(null);
    setSubmenuOpenAt(null);
  }, []);

  const show = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
    setMenu({ x, y, items });
    setQuery("");
    setSubmenuOpenAt(null);
  }, []);

  // Stable across menu open/close, so consumers of the context (every
  // component with a right-click menu) don't all re-render with it.
  const value = useMemo(() => ({ show, hide }), [show, hide]);

  // Every right-click ends up here unless a component's own menu claimed it
  // first (those stop the event): the browser's default menu is suppressed
  // everywhere, and what's left gets the clipboard menu above.
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const items = fallbackMenuItems(e.target, tRef.current);
      if (items.length > 0) show(e.clientX, e.clientY, items);
      else hide();
    };
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, [show, hide]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      // A dropdown inside a compound row (ProfileSelect) portals its list out of the menu.
      if (e.target instanceof Element && e.target.closest("[data-profile-select-menu]")) return;
      hide();
    };
    // Capture phase: xterm stops propagation of every keydown it handles, so
    // with a terminal focused (a link menu opens right over one) a bubbling
    // listener never saw Escape.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      // Escape first empties the search, then closes the menu.
      if (searchKeyAction(e.key, queryRef.current) === "clear") setQuery("");
      else hide();
    };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menu, hide]);

  const searchable = !!menu && needsSearch(menu.items.filter(isSelectable).length);
  // A ref and an effect rather than autoFocus: the menu mounts mid-click, where the attribute's focus doesn't always stick.
  useEffect(() => {
    if (searchable) searchRef.current?.focus();
  }, [searchable, menu]);

  // Filtering leaves the separators and compound rows out; each row keeps its place in `menu.items` for the flyout.
  const rows =
    menu?.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !searchable || query.trim() === "" || (isSelectable(item) && matchesQuery(item.label, query))) ?? [];

  let style: { left: number; top: number } | undefined;
  if (menu) {
    const menuWidth = 210;
    const rowHeight = 30;
    const estHeight = menu.items.length * rowHeight + 8 + (searchable ? 34 : 0);
    const left = Math.min(menu.x, window.innerWidth - menuWidth - 8);
    const top = Math.min(menu.y, window.innerHeight - estHeight - 8);
    style = { left: Math.max(8, left), top: Math.max(8, top) };
  }

  const activeSubmenu = submenuOpenAt ? menu?.items[submenuOpenAt.index]?.submenu : undefined;
  let submenuStyle: { left: number; top: number } | undefined;
  if (submenuOpenAt && activeSubmenu) {
    const menuWidth = 210;
    const rowHeight = 30;
    const estHeight = activeSubmenu.length * rowHeight + 8;
    // Always opens to the left of the parent row - the one caller this
    // flyout style is used for (App.tsx's top-right "..." menu) lives at
    // the window's right edge, so a right-opening flyout would run off
    // (or hug) the screen edge; opening left is the position that's always
    // reachable regardless of where the parent menu itself ended up.
    const left = Math.max(8, submenuOpenAt.parentLeft - menuWidth - 2);
    const top = Math.min(submenuOpenAt.y, window.innerHeight - estHeight - 8);
    submenuStyle = { left: Math.max(8, left), top: Math.max(8, top) };
  }

  function renderItems(entries: { item: ContextMenuItem; index: number }[], onOpenSubmenu?: (index: number, rect: DOMRect) => void) {
    return entries.map(({ item, index: i }) =>
      item.separator ? (
        <div className="context-menu-separator" key={`sep-${i}`} />
      ) : item.custom ? (
        <div className="context-menu-custom" key={item.label}>
          {item.custom}
        </div>
      ) : (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          aria-haspopup={item.submenu ? "menu" : undefined}
          className={"context-menu-item" + (item.danger ? " is-danger" : "")}
          disabled={item.disabled}
          onClick={(e) => {
            if (item.submenu) {
              onOpenSubmenu?.(i, e.currentTarget.getBoundingClientRect());
              return;
            }
            hide();
            item.onSelect?.();
          }}
        >
          {item.submenu ? (
            <svg className="context-menu-caret" viewBox="0 0 24 24" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
              <polyline points="15 5.5 9 12 15 18.5" />
            </svg>
          ) : (
            item.icon && <span className="context-menu-icon">{item.icon}</span>
          )}
          <span className="context-menu-label">{item.label}</span>
          {item.checked && (
            <svg className="context-menu-check" viewBox="0 0 24 24" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
              <polyline points="5 12.5 10 17.5 19 7" />
            </svg>
          )}
        </button>
      ),
    );
  }

  const enabledRows = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(".context-menu-item:not(:disabled)") ?? []);
  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    const action = searchKeyAction(e.key, query);
    if (action === "down") {
      e.preventDefault();
      enabledRows()[0]?.focus();
    } else if (action === "run") {
      e.preventDefault();
      enabledRows()[0]?.click();
    }
  };
  // Arrow keys walk the rows; up from the first goes back to the search.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    if ((e.target as HTMLElement).closest("input")) return;
    e.preventDefault();
    const list = enabledRows();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowUp" && at <= 0) searchRef.current?.focus();
    else list[e.key === "ArrowDown" ? Math.min(at + 1, list.length - 1) : at - 1]?.focus();
  };

  return (
    <ContextMenuCtx.Provider value={value}>
      {children}
      {menu && (
        <div className="context-menu" ref={menuRef} style={style} role="menu" onMouseDown={keepFocus} onKeyDown={onMenuKeyDown}>
          {searchable && (
            <input
              ref={searchRef}
              className="context-menu-search"
              placeholder={t("common.search")}
              aria-label={t("common.search")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKeyDown}
            />
          )}
          {rows.length === 0 && <div className="context-menu-empty">{t("common.noResults")}</div>}
          {renderItems(rows, (index, rect) =>
            setSubmenuOpenAt((prev) =>
              prev?.index === index ? null : { index, x: rect.right + 2, y: rect.top, parentLeft: rect.left },
            ),
          )}
        </div>
      )}
      {menu && submenuOpenAt && activeSubmenu && (
        <div className="context-menu" ref={submenuRef} style={submenuStyle} role="menu" onMouseDown={keepFocus}>
          {renderItems(activeSubmenu.map((item, index) => ({ item, index })))}
        </div>
      )}
    </ContextMenuCtx.Provider>
  );
}
