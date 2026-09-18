import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import "./context-menu.css";

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
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

  const hide = useCallback(() => setMenu(null), []);

  const show = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    setMenu({ x, y, items });
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) hide();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
      window.removeEventListener("keydown", onKeyDown);
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

  return (
    <ContextMenuCtx.Provider value={{ show, hide }}>
      {children}
      {menu && (
        <div className="context-menu" ref={menuRef} style={style} role="menu">
          {menu.items.map((item, i) =>
            item.separator ? (
              <div className="context-menu-separator" key={`sep-${i}`} />
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={"context-menu-item" + (item.danger ? " is-danger" : "")}
                disabled={item.disabled}
                onClick={() => {
                  hide();
                  item.onSelect?.();
                }}
              >
                {item.icon && <span className="context-menu-icon">{item.icon}</span>}
                <span className="context-menu-label">{item.label}</span>
                {item.checked && (
                  <svg className="context-menu-check" viewBox="0 0 24 24" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
                    <polyline points="5 12.5 10 17.5 19 7" />
                  </svg>
                )}
              </button>
            ),
          )}
        </div>
      )}
    </ContextMenuCtx.Provider>
  );
}
