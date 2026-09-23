import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  // The flyout is one level deep and always spawned from the top-level menu
  // that's currently open - index into `menu.items`, not a separate menu
  // stack, so it's automatically torn down whenever `menu` itself closes.
  const [submenuOpenAt, setSubmenuOpenAt] = useState<{ index: number; x: number; y: number; parentLeft: number } | null>(null);

  const hide = useCallback(() => {
    setMenu(null);
    setSubmenuOpenAt(null);
  }, []);

  const show = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setMenu({ x, y, items });
    setSubmenuOpenAt(null);
  }, []);

  // Stable across menu open/close, so consumers of the context (every
  // component with a right-click menu) don't all re-render with it.
  const value = useMemo(() => ({ show, hide }), [show, hide]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (submenuRef.current?.contains(target)) return;
      hide();
    };
    // Capture phase: xterm stops propagation of every keydown it handles, so
    // with a terminal focused (a link menu opens right over one) a bubbling
    // listener never saw Escape.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      hide();
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

  let style: { left: number; top: number } | undefined;
  if (menu) {
    const menuWidth = 210;
    const rowHeight = 30;
    const estHeight = menu.items.length * rowHeight + 8;
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

  function renderItems(items: ContextMenuItem[], onOpenSubmenu?: (index: number, rect: DOMRect) => void) {
    return items.map((item, i) =>
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

  return (
    <ContextMenuCtx.Provider value={value}>
      {children}
      {menu && (
        <div className="context-menu" ref={menuRef} style={style} role="menu">
          {renderItems(menu.items, (index, rect) =>
            setSubmenuOpenAt((prev) =>
              prev?.index === index ? null : { index, x: rect.right + 2, y: rect.top, parentLeft: rect.left },
            ),
          )}
        </div>
      )}
      {menu && submenuOpenAt && activeSubmenu && (
        <div className="context-menu" ref={submenuRef} style={submenuStyle} role="menu">
          {renderItems(activeSubmenu)}
        </div>
      )}
    </ContextMenuCtx.Provider>
  );
}
