import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useUsageProfile, useUsageState } from "./useUsageState";
import { usageBarMetric, usageFetcherFor, type UsageInfo } from "./usage";
import { usagePopoverPositionBeside } from "./usagePopoverLayout";
import { UsagePopoverContent } from "./UsagePopoverContent";
import { useI18n } from "../i18n";
import { searchKeyAction, sectionMenu } from "../../shared/menuFilter";
import { useSettingsSection } from "../settings/SettingsSectionContext";
import "./plugin-menu.css";
import "./plugin-usage.css";

interface PluginMenuEntry {
  id: string;
  label: string;
  /** Launches an agent CLI: listed under "Agents". */
  agent: boolean;
  icon: ReactNode;
  /** The second line: the plugin's description, else "built-in". */
  detail?: string;
  pinned: boolean;
  run: () => void;
  onTogglePin: () => void;
}

interface PluginMenuProps {
  items: PluginMenuEntry[];
  anchorRect: DOMRect;
  onClose: () => void;
  /** Opens the settings page (the menu then switches it to Funzionalità). */
  onManage: () => void;
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

/** The fraction (0-1) drawn as the row's mini usage bar - only from a reading
 * already cached: opening the menu never starts a fetch. */
function rowGauge(usage: UsageInfo | null): number | undefined {
  if (!usage || usage.offline) return undefined;
  return usageBarMetric(usage.metrics)?.percent;
}

/** One row. Plugins with a usage fetcher (currently Codex CLI / Claude Code)
 * get a "‹" button on the left that opens the same usage popover as the
 * shortcut-bar button (PluginUsageButton), beside the menu on that side. It
 * opens on click, not hover, and stays until closed. `useUsageState` is safe
 * to call for every row: a no-op for a plugin with no fetcher. */
function PluginMenuRow({
  item,
  gutter,
  open,
  onToggleOpen,
  onClose,
}: {
  item: PluginMenuEntry;
  /** Some row in the menu has a "‹" button: keep the column so badges line up. */
  gutter: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [profile, setProfile, profileReady] = useUsageProfile(item.id);
  const { fetcher, usage, loading, load } = useUsageState(item.id, profile, profileReady);
  const rowRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!open || !fetcher) {
      setRect(null);
      return;
    }
    setRect(rowRef.current?.getBoundingClientRect() ?? null);
    load();
  }, [open, fetcher, load]);

  const gauge = fetcher ? rowGauge(usage) : undefined;

  return (
    <div
      className={"plugin-menu-item" + (open && rect ? " is-open" : "")}
      ref={rowRef}
      data-plugin-row={item.id}
    >
      {gutter &&
        (fetcher ? (
          <button
            type="button"
            className="plugin-menu-more"
            aria-label={t("plugins.usageDetails")}
            aria-expanded={open}
            title={t("plugins.usageDetails")}
            onClick={(e) => {
              e.stopPropagation();
              onToggleOpen();
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="12" height="12">
              <path d="m15 6-6 6 6 6" />
            </svg>
          </button>
        ) : (
          <span className="plugin-menu-more-spacer" aria-hidden="true" />
        ))}
      <button
        type="button"
        className="plugin-menu-item-body"
        title={item.detail}
        onClick={() => {
          item.run();
          onClose();
        }}
      >
        <span className="plugin-menu-badge">{item.icon}</span>
        <span className="plugin-menu-item-label">{item.label}</span>
        {gauge !== undefined && (
          <span className={"plugin-menu-gauge" + (gauge >= 0.75 ? " is-high" : "")} aria-hidden="true">
            <span style={{ width: `${Math.round(Math.min(1, Math.max(0, gauge)) * 100)}%` }} />
          </span>
        )}
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
      {open &&
        rect &&
        createPortal(
          <div
            className="plugin-usage-popover"
            data-plugin={item.id}
            style={usagePopoverPositionBeside(rect, menuRectOf(rowRef.current) ?? rect)}
          >
            <UsagePopoverContent
              pluginId={item.id}
              label={item.label}
              usage={usage}
              loading={loading}
              profile={profile}
              onProfileChange={setProfile}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}

export function PluginMenu({ items, anchorRect, onClose, onManage }: PluginMenuProps) {
  const { t } = useI18n();
  const { setSection } = useSettingsSection();
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  queryRef.current = query;
  /** The row whose usage popover is open (opened with its "‹" button). */
  const [openId, setOpenId] = useState<string | null>(null);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // A ref and an effect rather than autoFocus: the menu is a portal that
  // mounts mid-click, where the attribute's focus doesn't always stick.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      // The usage popover (and its profile picker) are portals beside the menu:
      // closing here would unmount them before their buttons get the click.
      if (target?.closest(".plugin-usage-popover, .profile-select-menu")) return;
      if (menuRef.current?.contains(e.target as Node)) {
        // A click elsewhere in the menu closes an open popover - except on a
        // "‹" button, which toggles its own popover in its click handler.
        if (openIdRef.current && !target?.closest(".plugin-menu-more")) setOpenId(null);
        return;
      }
      onClose();
    };
    // Escape closes an open popover, then empties the search, then closes the menu.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (openIdRef.current) setOpenId(null);
      else if (searchKeyAction(e.key, queryRef.current) === "clear") {
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
  // Only while some visible row has a popover: keeps the badges lined up.
  const gutter = sections.some((s) => s.items.some((i) => usageFetcherFor(i.id)));

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
  // Arrow keys walk the rows; up from the first goes back to the search. Left
  // opens the focused row's usage popover (it opens on that side), right closes it.
  const onListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const rowId = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("[data-plugin-row]")?.dataset.pluginRow;
      if (!rowId || !usageFetcherFor(rowId)) return;
      e.preventDefault();
      setOpenId(e.key === "ArrowLeft" ? rowId : null);
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    setOpenId(null);
    const rows = bodies();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowUp" && at <= 0) inputRef.current?.focus();
    else rows[e.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1]?.focus();
  };

  const menuWidth = 290;
  // Opened from the narrow layout's bottom bar, the list has to grow upward.
  const above = anchorRect.top > window.innerHeight / 2;
  const style = {
    ...(above ? { bottom: window.innerHeight - anchorRect.top + 4 } : { top: anchorRect.bottom + 4 }),
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - menuWidth - 8)),
  };

  return createPortal(
    <div className="plugin-menu" style={style} ref={menuRef}>
      <label className="plugin-menu-search">
        <span className="plugin-menu-search-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </span>
        <input
          ref={inputRef}
          placeholder={t("plugins.search")}
          aria-label={t("plugins.search")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpenId(null);
          }}
          onKeyDown={onSearchKeyDown}
        />
      </label>
      <div className="plugin-menu-divider" role="separator" />
      <div className="plugin-menu-list" onKeyDown={onListKeyDown}>
        {sections.length === 0 && <div className="plugin-menu-empty">{t("common.noResults")}</div>}
        {sections.map((section) => (
          <section key={section.id} className="plugin-menu-section">
            <h3 className="plugin-menu-heading">
              {section.id === "agents" ? t("plugins.sectionAgents") : t("plugins.sectionTools")}
              <span className="plugin-menu-heading-count">{section.items.length}</span>
            </h3>
            {section.items.map((item) => (
              <PluginMenuRow
                key={item.id}
                item={item}
                gutter={gutter}
                open={openId === item.id}
                onToggleOpen={() => setOpenId((id) => (id === item.id ? null : item.id))}
                onClose={onClose}
              />
            ))}
          </section>
        ))}
      </div>
      <div className="plugin-menu-foot">
        <button
          type="button"
          className="plugin-menu-manage"
          onClick={() => {
            onManage();
            setSection("funzionalita");
            onClose();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="14" height="14" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
          </svg>
          {t("plugins.manage")}
        </button>
        <span className="plugin-menu-foot-keys" aria-hidden="true">
          <kbd>↑↓</kbd>
          <kbd>↵</kbd>
        </span>
      </div>
    </div>,
    document.body,
  );
}
