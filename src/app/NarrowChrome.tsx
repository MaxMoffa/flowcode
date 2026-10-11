import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { AppTab } from "../tabs/types";
import type { TabAgent } from "../agents/agentSessions";
import { agentAttention, tabDisplayLabel } from "../terminal/TabStrip";
import { useI18n } from "../i18n";
import "./narrow-chrome.css";

interface TabSwitcherProps {
  tabs: AppTab[];
  activeId: string;
  agents?: Map<string, TabAgent>;
  doneIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}

/** The status dot the tab strip colours by agent state; none for a tab with
 * no agent (a plain shell, a file) unless an agent finished there unseen. */
function StatusDot({ tab, agents, doneIds }: { tab: AppTab; agents?: Map<string, TabAgent>; doneIds?: ReadonlySet<string> }) {
  if (tab.kind !== "terminal") return null;
  const agent = agents?.get(tab.id);
  const state = agentAttention(agent, !!doneIds?.has(tab.id));
  if (!agent && state !== "done") return null;
  return <span className={"narrow-dot is-" + state} aria-hidden="true" />;
}

/** Narrow-window replacement for the tab strip: one button showing the
 * active tab that opens the full list, plus the "+" button. A dropdown
 * because a phone-width bar has no room for even two 160px tabs. */
export function TabSwitcher({ tabs, activeId, agents, doneIds, onSelect, onClose, onNew }: TabSwitcherProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const active = tabs.find((x) => x.id === activeId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    // Land on the current tab so the arrows start from where you are.
    rootRef.current?.querySelector<HTMLElement>(".narrow-switch-item.is-active")?.focus();
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function onListKeyDown(e: ReactKeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(".narrow-switch-item") ?? []);
    if (items.length === 0) return;
    e.preventDefault();
    const cur = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
    items[next].focus();
  }

  return (
    <>
      <div className="narrow-switcher" ref={rootRef}>
        <button
          ref={btnRef}
          type="button"
          className="narrow-switch-btn"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t("narrow.switchTab")}
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          {active && <StatusDot tab={active} agents={agents} doneIds={doneIds} />}
          <span className="narrow-switch-label">{active ? tabDisplayLabel(active) : ""}</span>
          <span className="narrow-switch-count">
            {tabs.length === 1 ? t("narrow.tabCount.one") : t("narrow.tabCount", { count: tabs.length })}
          </span>
          <svg className="narrow-switch-chevron" viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {open && (
          <div className="narrow-switch-list" role="menu" onKeyDown={onListKeyDown}>
            {tabs.map((tab) => (
              <div key={tab.id} className={"narrow-switch-row" + (tab.id === activeId ? " is-active" : "")}>
                <button
                  type="button"
                  role="menuitem"
                  className={"narrow-switch-item" + (tab.id === activeId ? " is-active" : "")}
                  onClick={() => {
                    onSelect(tab.id);
                    setOpen(false);
                  }}
                >
                  <StatusDot tab={tab} agents={agents} doneIds={doneIds} />
                  <span className="narrow-switch-label">{tabDisplayLabel(tab)}</span>
                </button>
                <button
                  type="button"
                  className="narrow-switch-close"
                  aria-label={t("tabs.closeNamed", { name: tabDisplayLabel(tab) })}
                  onClick={() => {
                    // Closing the last tab may leave nothing to list.
                    if (tabs.length <= 1) setOpen(false);
                    onClose(tab.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <line x1="7" y1="7" x2="17" y2="17" />
                    <line x1="17" y1="7" x2="7" y2="17" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <button type="button" className="icon-button" aria-label={t("menu.newTerminal")} title={t("menu.newTerminal")} onClick={onNew}>
        <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
          <line x1="12" y1="6" x2="12" y2="18" />
          <line x1="6" y1="12" x2="18" y2="12" />
        </svg>
      </button>
    </>
  );
}

export interface NarrowQuickAction {
  id: string;
  label: string;
  icon: ReactNode;
  onRun: () => void;
}

interface NarrowBottomProps {
  quickActions: NarrowQuickAction[];
  filesOpen: boolean;
  agentsOpen: boolean;
  onTerminal: () => void;
  onToggleFiles: () => void;
  onToggleAgents: () => void;
  /** Gets the "More" button's rect so the menu can open above it. */
  onMore: (rect: DOMRect) => void;
}

const NAV_ICON = { viewBox: "0 0 24 24", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** Narrow-window bottom area: the shortcuts as a scrolling chip row, then a
 * four-item navigation bar that switches between the terminal and the two
 * overlay panels. */
export function NarrowBottom({ quickActions, filesOpen, agentsOpen, onTerminal, onToggleFiles, onToggleAgents, onMore }: NarrowBottomProps) {
  const { t } = useI18n();
  const moreRef = useRef<HTMLButtonElement>(null);
  const terminalActive = !filesOpen && !agentsOpen;

  return (
    <div className="narrow-bottom">
      {quickActions.length > 0 && (
        <div className="narrow-chips">
          {quickActions.map((a) => (
            <button key={a.id} type="button" className="narrow-chip" onClick={a.onRun}>
              {a.icon}
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      )}
      <nav className="narrow-nav">
        <button
          type="button"
          className={"narrow-nav-item" + (terminalActive ? " is-active" : "")}
          aria-current={terminalActive ? "page" : undefined}
          onClick={onTerminal}
        >
          <svg {...NAV_ICON}>
            <path d="m5 8 4 4-4 4" />
            <line x1="12" y1="17" x2="19" y2="17" />
          </svg>
          <span>{t("narrow.nav.terminal")}</span>
        </button>
        <button type="button" className={"narrow-nav-item" + (filesOpen ? " is-active" : "")} aria-pressed={filesOpen} onClick={onToggleFiles}>
          <svg {...NAV_ICON}>
            <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
          </svg>
          <span>{t("narrow.nav.files")}</span>
        </button>
        <button type="button" className={"narrow-nav-item" + (agentsOpen ? " is-active" : "")} aria-pressed={agentsOpen} onClick={onToggleAgents}>
          <svg {...NAV_ICON}>
            <rect x="4.5" y="7.5" width="15" height="11" rx="2.5" />
            <path d="M12 7.5v-3" />
            <circle cx="9.3" cy="13" r="0.6" />
            <circle cx="14.7" cy="13" r="0.6" />
          </svg>
          <span>{t("narrow.nav.agents")}</span>
        </button>
        <button
          ref={moreRef}
          type="button"
          className="narrow-nav-item"
          aria-haspopup="menu"
          onClick={() => moreRef.current && onMore(moreRef.current.getBoundingClientRect())}
        >
          <svg {...NAV_ICON}>
            <circle cx="6" cy="12" r="0.9" />
            <circle cx="12" cy="12" r="0.9" />
            <circle cx="18" cy="12" r="0.9" />
          </svg>
          <span>{t("narrow.nav.more")}</span>
        </button>
      </nav>
    </div>
  );
}
