import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useHoverPopover, useUsageState } from "./useUsageState";
import { usagePopoverPosition } from "./usagePopoverLayout";
import { UsagePopoverContent } from "./UsagePopoverContent";
import { useI18n } from "../i18n";
import "./plugin-menu.css";
import "./plugin-usage.css";

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

/** One row - same usage popover as the shortcut-bar button (PluginUsageButton)
 * shows up here too, on hover, for any plugin with a known usage fetcher
 * (currently Codex CLI / Claude Code). `useUsageState` is safe to call for
 * every row regardless: it's a no-op for a plugin with no fetcher. */
function PluginMenuRow({ item, onClose }: { item: PluginMenuEntry; onClose: () => void }) {
  const { t } = useI18n();
  const { fetcher, usage, loading, load } = useUsageState(item.id);
  const rowRef = useRef<HTMLDivElement>(null);
  const popover = useHoverPopover(rowRef, load);
  const rect = fetcher ? popover.rect : null;
  const show = fetcher ? popover.show : undefined;
  const scheduleHide = fetcher ? popover.scheduleHide : undefined;

  return (
    <div className="plugin-menu-item" ref={rowRef} onMouseEnter={show} onMouseLeave={scheduleHide}>
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
        aria-label={item.pinned ? t("plugins.unpin") : t("plugins.pin")}
        title={item.pinned ? t("plugins.unpin") : t("plugins.pin")}
        onClick={(e) => {
          e.stopPropagation();
          item.onTogglePin();
        }}
      >
        <PinIcon filled={item.pinned} />
      </button>
      {rect &&
        createPortal(
          <div
            className="plugin-usage-popover"
            data-plugin={item.id}
            style={usagePopoverPosition(rect)}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            <UsagePopoverContent label={item.label} usage={usage} loading={loading} />
          </div>,
          document.body,
        )}
    </div>
  );
}

export function PluginMenu({ items, anchorRect, onClose }: PluginMenuProps) {
  const { t } = useI18n();
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
  const style = {
    top: anchorRect.bottom + 4,
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - menuWidth - 8)),
  };

  return createPortal(
    <div className="plugin-menu" style={style} ref={menuRef}>
      <input
        ref={inputRef}
        className="plugin-menu-search"
        placeholder={t("plugins.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="plugin-menu-list">
        {filtered.length === 0 && <div className="plugin-menu-empty">{t("common.noResults")}</div>}
        {filtered.map((item) => (
          <PluginMenuRow key={item.id} item={item} onClose={onClose} />
        ))}
      </div>
    </div>,
    document.body,
  );
}
