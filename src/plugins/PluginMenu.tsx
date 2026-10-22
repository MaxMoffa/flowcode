import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useHoverPopover, useUsageProfile, useUsageState } from "./useUsageState";
import { usagePopoverPositionBeside } from "./usagePopoverLayout";
import { UsagePopoverContent } from "./UsagePopoverContent";
import { useI18n } from "../i18n";
import { searchKeyAction, sectionMenu } from "../../shared/menuFilter";
import "./plugin-menu.css";
import "./plugin-usage.css";

interface PluginMenuEntry {
  id: string;
  label: string;
  /** Launches an agent CLI: listed under "Agents". */
  agent: boolean;
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

/** The menu a row belongs to, for placing its popover beside it. */
function menuRectOf(row: HTMLElement | null): DOMRect | null {
  return row?.closest(".plugin-menu")?.getBoundingClientRect() ?? null;
}

/** One row - same usage popover as the shortcut-bar button (PluginUsageButton)
 * shows up here too, on hover, for any plugin with a known usage fetcher
 * (currently Codex CLI / Claude Code). `useUsageState` is safe to call for
 * every row regardless: it's a no-op for a plugin with no fetcher. */
function PluginMenuRow({ item, onClose }: { item: PluginMenuEntry; onClose: () => void }) {
  const { t } = useI18n();
  const [profile, setProfile, profileReady] = useUsageProfile(item.id);
  const { fetcher, usage, loading, load } = useUsageState(item.id, profile, profileReady);
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
            style={usagePopoverPositionBeside(rect, menuRectOf(rowRef.current) ?? rect)}
            onMouseEnter={show}
            onMouseLeave={scheduleHide}
          >
            <UsagePopoverContent
              pluginId={item.id}
              label={item.label}
              usage={usage}
              loading={loading}
              profile={profile}
              onProfileChange={setProfile}
              onMenuPointerEnter={show}
              onMenuPointerLeave={scheduleHide}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

export function PluginMenu({ items, anchorRect, onClose }: PluginMenuProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // A ref and an effect rather than autoFocus: the menu is a portal that
  // mounts mid-click, where the attribute's focus doesn't always stick.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    // Escape first empties the search, then closes the menu.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (searchKeyAction(e.key, queryRef.current) === "clear") {
        setQuery("");
        inputRef.current?.focus();
      } else onClose();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const sections = sectionMenu(items, query, (i) => i.label, (i) => i.agent);

  const bodies = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>(".plugin-menu-item-body") ?? []);
  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    const action = searchKeyAction(e.key, query);
    if (action === "down") {
      e.preventDefault();
      bodies()[0]?.focus();
    } else if (action === "run") {
      e.preventDefault();
      const first = sections[0]?.items[0];
      if (!first) return;
      first.run();
      onClose();
    }
  };
  // Arrow keys walk the rows; up from the first goes back to the search.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const rows = bodies();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowUp" && at <= 0) inputRef.current?.focus();
    else rows[e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1]?.focus();
  };

  const menuWidth = 250;
  // Opened from the narrow layout's bottom bar, the list has to grow upward.
  const above = anchorRect.top > window.innerHeight / 2;
  const style = {
    ...(above ? { bottom: window.innerHeight - anchorRect.top + 4 } : { top: anchorRect.bottom + 4 }),
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
        onKeyDown={onSearchKeyDown}
      />
      <div className="plugin-menu-list" onKeyDown={onListKeyDown}>
        {sections.length === 0 && <div className="plugin-menu-empty">{t("common.noResults")}</div>}
        {sections.map((section) => (
          <section key={section.id} className="plugin-menu-section">
            <h3 className="plugin-menu-heading">{section.id === "agents" ? t("plugins.sectionAgents") : t("plugins.sectionTools")}</h3>
            {section.items.map((item) => (
              <PluginMenuRow key={item.id} item={item} onClose={onClose} />
            ))}
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
