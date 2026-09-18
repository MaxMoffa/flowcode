import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./plugin-menu.css";

export interface PluginMenuEntry {
  id: string;
  label: string;
  icon: ReactNode;
  pinned: boolean;
  run: () => void;
  onTogglePin: () => void;
}

interface PluginMenuProps {
  items: PluginMenuEntry[];
  anchorRect: DOMRect;
  onClose: () => void;
}

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill={filled ? "currentColor" : "none"}>
      <path d="M14.5 3.5 20.5 9.5 17 13l-1 5-3-3-5 5-1-1 5-5-3-3 5-1z" />
    </svg>
  );
}

export function PluginMenu({ items, anchorRect, onClose }: PluginMenuProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const filtered = items.filter((i) => i.label.toLowerCase().includes(query.trim().toLowerCase()));

  const menuWidth = 250;
  const style: CSSProperties = {
    top: anchorRect.bottom + 4,
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - menuWidth - 8)),
  };

  return createPortal(
    <div className="plugin-menu" style={style} ref={menuRef}>
      <input
        ref={inputRef}
        className="plugin-menu-search"
        placeholder="Cerca funzionalità…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="plugin-menu-list">
        {filtered.length === 0 && <div className="plugin-menu-empty">Nessun risultato</div>}
        {filtered.map((item) => (
          <div key={item.id} className="plugin-menu-item">
            <button
              type="button"
              className="plugin-menu-item-body"
              onClick={() => {
                item.run();
                onClose();
              }}
            >
              <span className="plugin-menu-item-icon">{item.icon}</span>
              <span className="plugin-menu-item-label">{item.label}</span>
            </button>
            <button
              type="button"
              className={"plugin-menu-pin" + (item.pinned ? " is-pinned" : "")}
              aria-label={item.pinned ? "Rimuovi dalla barra" : "Aggiungi alla barra"}
              title={item.pinned ? "Rimuovi dalla barra" : "Aggiungi alla barra"}
              onClick={(e) => {
                e.stopPropagation();
                item.onTogglePin();
              }}
            >
              <PinIcon filled={item.pinned} />
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
