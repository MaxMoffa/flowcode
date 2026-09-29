import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { MenuIcons } from "../context-menu/menuIcons";
import { createPortal } from "react-dom";
import { listShellOptions, shellOptionLabel, type ShellOption } from "./shellOptions";
import type { AppTab } from "../tabs/types";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { useOpenContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { t, translationsOf, useI18n } from "../i18n";
import { agentCliIcon } from "../plugins/icons";
import type { TabAgent } from "../agents/agentSessions";
import "./tabstrip.css";

interface TabStripProps {
  tabs: AppTab[];
  activeId: string;
  dirtyIds?: Set<string>;
  /** The agent CLI (Claude Code, Codex) running in a terminal tab, by tab
   * id - shown as its logo in place of the dot, with what it's doing. */
  agents?: Map<string, TabAgent>;
  /** Terminal tabs whose agent finished while nobody was looking - their
   * logo (or dot) turns green until the tab is seen. */
  doneIds?: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Creates a new terminal tab - `shellId` (a `list_shell_options` id, from
   * the "+" button's own context menu) picks a specific shell instead of the
   * configured default. */
  onNew: (shellId?: string) => void;
  onRename: (id: string, label: string) => void;
  /** Opens a second, independent copy of a tab - same cwd for a terminal,
   * same file for an editor. Not offered for the (singleton) settings tab. */
  onDuplicate: (id: string) => void;
  /** Mutes/unmutes a terminal tab's agent notifications. */
  onToggleNotifications: (id: string) => void;
  /** A tab dragged along the strip, moved to slot `toIndex`. */
  onReorder: (id: string, toIndex: number) => void;
  /** A tab dragged out of the strip and released - it goes to whatever is
   * under the cursor (another window, or a new one): see App.tsx's
   * `handleTabDragOut`. */
  onDragOut: (id: string) => void;
}

/** How far the pointer has to travel before a press on a tab becomes a drag
 * (below it, it's a plain click). */
const DRAG_THRESHOLD = 5;
/** How far above/below the strip the pointer can stray while still
 * reordering, before the tab counts as pulled out of it. */
const DETACH_MARGIN = 30;

interface TabDrag {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  dragging: boolean;
  /** Pulled out of the strip: dropping it now moves it out of this window. */
  detached: boolean;
  x: number;
  y: number;
}

// Tabs have a fixed CSS width, so how many fit is plain arithmetic instead
// of measuring each one - see tabstrip.css for the matching values. The
// folder tab takes up exactly one regular tab slot (same size), so there's
// no separate reservation for it.
const TAB_SLOT = 162; // 160px tab + 2px gap
const NEW_BTN_SLOT = 28; // 26px button + 2px gap

function computeVisibleSlots(containerWidth: number, total: number): number {
  if (total === 0 || containerWidth <= 0) return total;
  const maxSlots = Math.floor((containerWidth - NEW_BTN_SLOT) / TAB_SLOT);
  return Math.max(1, Math.min(maxSlots, total));
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" stroke="currentColor" fill="none">
      <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Shown on a terminal tab whose agent notifications are muted. */
function MutedIcon() {
  return (
    <svg
      className="term-tab-muted"
      viewBox="0 0 24 24"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="11"
      height="11"
      stroke="currentColor"
      fill="none"
      aria-label={t("tabs.notificationsMuted")}
    >
      <title>{t("tabs.notificationsMuted")}</title>
      <path d="M8.7 3A6 6 0 0 1 18 8c0 2.9.6 4.9 1.3 6.1M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h14M10.3 21a1.9 1.9 0 0 0 3.4 0M2 2l20 20" />
    </svg>
  );
}

function ChangelogIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <path d="M12 3.5 14.2 8l4.8.6-3.5 3.3.9 4.8L12 14.4l-4.4 2.3.9-4.8L5 8.6 9.8 8z" />
      <line x1="5" y1="20.5" x2="19" y2="20.5" />
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9.5 10.5 12.5 7 15.5" />
      <line x1="12" y1="15.5" x2="16" y2="15.5" />
    </svg>
  );
}

/** Same terminal-box shape as PromptIcon, but a plain chevron with no
 * underscore bar - a deliberately small, brand-neutral difference from cmd's
 * own icon (this app draws no real shell logos) so PowerShell/pwsh rows
 * still read as visually distinct from the cmd row in the "+" button's
 * shell-picker menu. */
function ChevronBoxIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M8 9 13 12 8 15" />
    </svg>
  );
}

/** Generic "Linux" stand-in (an abstract penguin silhouette, not the Tux
 * artwork itself) for the WSL shell option. */
function PenguinIcon() {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" width="13" height="13" stroke="currentColor" fill="none">
      <path d="M12 3.5c-2.6 0-4.3 2-4.3 4.6 0 1.4.4 2.3.4 3.4 0 2-1.4 3.3-1.4 5.7 0 2 2.3 3.3 5.3 3.3s5.3-1.3 5.3-3.3c0-2.4-1.4-3.7-1.4-5.7 0-1.1.4-2 .4-3.4 0-2.6-1.7-4.6-4.3-4.6z" />
      <circle cx="10.2" cy="9.3" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.8" cy="9.3" r="0.9" fill="currentColor" stroke="none" />
      <path d="M10.5 17.5 9 20.5M13.5 17.5 15 20.5" />
    </svg>
  );
}

/** Icon for a `list_shell_options` row, used in the "+" button's own
 * shell-picker context menu (see TabStrip's onContextMenu handler below) -
 * `id` is the same id `pty_spawn`'s `shell` argument and `resolve_shell` in
 * pty.rs understand. */
export function shellOptionIcon(id: string) {
  if (id === "wsl") return <PenguinIcon />;
  if (id === "cmd") return <PromptIcon />;
  if (id === "powershell" || id === "pwsh") return <ChevronBoxIcon />;
  if (id === "system") return <GearIcon />;
  // zsh/bash/sh (macOS/Linux builds) - same neutral prompt icon as cmd,
  // nothing platform-specific to tell them apart with.
  return <PromptIcon />;
}

/** A terminal tab running Claude Code or Codex: the CLI's logo. On a
 * renamed tab (`renamed`) it's followed by a spinner while the agent works
 * or a "?" while it waits on the user: both CLIs show that state in the
 * title, which a custom name replaces. */
function agentAttention(agent: TabAgent | undefined, done: boolean): "waiting" | "busy" | "done" | "idle" {
  if (agent?.state === "waiting") return "waiting";
  if (agent?.state === "busy") return "busy";
  return done ? "done" : "idle";
}

function agentTabIcon(agent: TabAgent, renamed: boolean, done: boolean) {
  const title =
    agent.state === "busy" ? t("agents.status.busy") : agent.state === "waiting" ? t("agents.status.waiting") : undefined;
  // The logo itself carries the state: amber when it needs the user, blue
  // while it works, green once it finished unseen.
  const state = agentAttention(agent, done);
  return (
    <span className="term-tab-agent" title={title}>
      <span className={"term-tab-agent-logo is-" + state}>{agentCliIcon(agent.cli)}</span>
      {renamed && agent.state === "busy" && <span className="term-tab-agent-spinner" />}
      {renamed && agent.state === "waiting" && <span className="term-tab-agent-question">?</span>}
    </span>
  );
}

function tabIcon(tab: AppTab, agent?: TabAgent, done = false) {
  if (tab.kind === "terminal") {
    return agent ? agentTabIcon(agent, !!tab.customLabel, done) : <span className={"term-tab-dot" + (done ? " is-done" : "")} />;
  }
  if (tab.kind === "settings") return <GearIcon />;
  if (tab.kind === "changelog" || tab.kind === "whatsNew") return <ChangelogIcon />;
  return <FileTypeIcon name={tab.label} />;
}

/** The label shown for `tab`: a settings/changelog tab still carrying its
 * default name (in whichever language it was opened) is shown in the
 * current one. */
export function tabDisplayLabel(tab: AppTab): string {
  if (tab.kind === "terminal" && tab.newTab) return t("newTab.title");
  if (tab.kind === "settings" && translationsOf("settings.title").includes(tab.label)) return t("settings.title");
  if (tab.kind === "changelog" && translationsOf("changelog.title").includes(tab.label)) return t("changelog.title");
  if (tab.kind === "whatsNew" && translationsOf("whatsNew.title").includes(tab.label)) return t("whatsNew.title");
  return tab.label;
}

function tabTitle(tab: AppTab): string {
  if (tab.kind === "terminal") return tab.cwd;
  if (tab.kind === "editor") return tab.path;
  return tabDisplayLabel(tab);
}

interface TabOverflowMenuProps {
  tabs: AppTab[];
  activeId: string;
  agents?: Map<string, TabAgent>;
  doneIds?: ReadonlySet<string>;
  anchorRect: DOMRect;
  onSelect: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Closes the overflow popup itself (Escape, click outside) - distinct
   * from `onCloseTab`, which closes one of the tabs listed inside it. */
  onDismiss: () => void;
}

function TabOverflowMenu({ tabs, activeId, agents, doneIds, anchorRect, onSelect, onCloseTab, onDismiss }: TabOverflowMenuProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onDismiss]);

  const filtered = tabs.filter((tab) => tabDisplayLabel(tab).toLowerCase().includes(query.trim().toLowerCase()));

  // Same width as the tab it unfolds from, anchored right under it - the
  // opening animation (see tabstrip.css) is what sells the illusion that
  // the tab itself is the thing expanding open.
  const style: CSSProperties = {
    top: anchorRect.bottom + 2,
    left: anchorRect.left,
    width: anchorRect.width,
  };

  return createPortal(
    <div className="tab-overflow-menu" style={style} ref={menuRef}>
      <input
        ref={inputRef}
        className="tab-overflow-search"
        placeholder={t("tabs.search")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="tab-overflow-list">
        {filtered.length === 0 && <div className="tab-overflow-empty">{t("common.noResults")}</div>}
        {filtered.map((tab) => (
          <div
            key={tab.id}
            className={"tab-overflow-item" + (tab.id === activeId ? " is-active" : "")}
            onClick={() => {
              onSelect(tab.id);
              onDismiss();
            }}
          >
            {tabIcon(tab, agents?.get(tab.id), doneIds?.has(tab.id))}
            <span className="tab-overflow-item-label">{tabDisplayLabel(tab)}</span>
            {tab.kind === "terminal" && tab.notifyMuted && <MutedIcon />}
            <button
              type="button"
              className="tab-overflow-item-close"
              aria-label={t("tabs.closeNamed", { name: tabDisplayLabel(tab) })}
              onClick={(e) => {
                e.stopPropagation();
                // A stacked tab needs at least two tabs inside it: closing
                // one of the last two leaves a lone tab that's no longer a
                // stack, so the popup is dismissed along with it. (Counts
                // all the stacked tabs, not just the search-filtered ones.)
                if (tabs.length <= 2) onDismiss();
                onCloseTab(tab.id);
              }}
            >
              <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}

export function TabStrip({
  tabs,
  activeId,
  dirtyIds,
  agents,
  doneIds,
  onSelect,
  onClose,
  onNew,
  onRename,
  onDuplicate,
  onToggleNotifications,
  onReorder,
  onDragOut,
}: TabStripProps) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [overflowAnchorRect, setOverflowAnchorRect] = useState<DOMRect | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [lastFolderSelection, setLastFolderSelection] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const folderTabRef = useRef<HTMLDivElement>(null);
  const openMenu = useOpenContextMenu();
  // The tab being dragged, if any - state for rendering (the ghost, the
  // dimmed tab), mirrored in a ref for the pointer handlers.
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const dragRef = useRef<TabDrag | null>(null);
  // The click that follows the pointerup ending a drag must not also count
  // as a click on the tab.
  const suppressClickRef = useRef(false);
  // Fetched once, purely to answer "is there more than one shell to offer" -
  // same list Settings uses for the default-shell picker (see
  // list_shell_options in pty.rs), already filtered there to what's actually
  // usable on this OS/machine (a WSL entry only exists here when it's really
  // installed).
  const [shellOptions, setShellOptions] = useState<ShellOption[]>([]);

  useEffect(() => {
    listShellOptions().then(setShellOptions);
  }, []);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setContainerWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function startEditing(tab: AppTab) {
    setEditingId(tab.id);
    setDraft(tabDisplayLabel(tab));
  }

  function commitEditing() {
    if (editingId) onRename(editingId, draft);
    setEditingId(null);
  }

  function tabMenuItems(tab: AppTab): ContextMenuItem[] {
    const items: ContextMenuItem[] = [
      // Same effect as double-clicking the label - just reachable without
      // knowing that gesture exists.
      { label: t("tabs.rename"), icon: MenuIcons.rename, onSelect: () => startEditing(tab) },
    ];
    if (tab.kind === "terminal" || tab.kind === "editor") {
      items.push({ label: t("tabs.duplicate"), icon: MenuIcons.duplicate, onSelect: () => onDuplicate(tab.id) });
    }
    if (tab.kind === "terminal") {
      items.push({
        label: tab.notifyMuted ? t("tabs.unmuteNotifications") : t("tabs.muteNotifications"),
        icon: tab.notifyMuted ? MenuIcons.bell : MenuIcons.bellOff,
        onSelect: () => onToggleNotifications(tab.id),
      });
    }
    items.push({ separator: true, label: "sep-close" });
    items.push({ label: t("common.close"), icon: MenuIcons.close, danger: true, onSelect: () => onClose(tab.id) });
    return items;
  }

  const totalSlots = computeVisibleSlots(containerWidth, tabs.length);
  const hasOverflow = totalSlots < tabs.length;
  // One of the fitted slots becomes the folder tab itself when there's
  // overflow, so it never shows a "folder of one" - whatever doesn't fit
  // regularly plus that reserved slot is always at least two tabs.
  const regularCount = hasOverflow ? Math.max(0, totalSlots - 1) : totalSlots;

  // Always a stable *prefix* of the tab list - a plain derived value with no
  // memory of its own, so there's no stored window position to drift out of
  // sync. Tabs already in the bar never move: growing the window only turns
  // more of the *tail* (the newest overflow) back into regular tabs, right
  // where the folder tab sits, instead of hidden tabs reappearing on the
  // opposite side of tabs that were already visible.
  const visibleTabs = tabs.slice(0, regularCount);
  const hiddenTabs = tabs.slice(regularCount);
  const activeInFolder = hiddenTabs.find((t) => t.id === activeId);
  // Remember the last hidden tab that was actually selected (set
  // synchronously during render, React's documented way to react to a prop
  // change without an extra render's lag) so switching to a regular tab and
  // back doesn't reset the folder's preview to some arbitrary tab - it
  // keeps showing whichever one you were last looking at in there.
  if (activeInFolder && activeInFolder.id !== lastFolderSelection) {
    setLastFolderSelection(activeInFolder.id);
  }
  const rememberedTab = hiddenTabs.find((t) => t.id === lastFolderSelection);
  // What the folder tab itself displays: the active hidden tab if there is
  // one, otherwise the last one that was, otherwise the most recent tab in
  // the group - reasonable stand-ins for a preview, in that order.
  const folderPreview = activeInFolder ?? rememberedTab ?? hiddenTabs[hiddenTabs.length - 1];
  // Tabs tucked into the folder can't show their own state, so the folder
  // shows the most pressing one among them.
  const folderAttention = hiddenTabs.some((tab) => agents?.get(tab.id)?.state === "waiting")
    ? "waiting"
    : hiddenTabs.some((tab) => doneIds?.has(tab.id))
      ? "done"
      : hiddenTabs.some((tab) => agents?.get(tab.id)?.state === "busy")
        ? "busy"
        : "idle";

  function handleTabPointerDown(e: ReactPointerEvent<HTMLDivElement>, tab: AppTab) {
    if (e.button !== 0 || editingId === tab.id) return;
    if ((e.target as HTMLElement).closest(".term-tab-close, input")) return;
    // Captured so the drag keeps reporting even once the pointer leaves the
    // window - which is exactly where a tab gets dropped to open elsewhere.
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      id: tab.id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      dragging: false,
      detached: false,
      x: e.clientX,
      y: e.clientY,
    };
  }

  function handleTabPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const current = dragRef.current;
    const strip = containerRef.current;
    if (!current || !strip || e.pointerId !== current.pointerId) return;
    if (!current.dragging) {
      if (Math.hypot(e.clientX - current.startX, e.clientY - current.startY) < DRAG_THRESHOLD) return;
      // Like a browser: the tab being dragged is the one on screen.
      onSelect(current.id);
    }
    const rect = strip.getBoundingClientRect();
    const detached =
      e.clientY < rect.top - DETACH_MARGIN ||
      e.clientY > rect.bottom + DETACH_MARGIN ||
      e.clientX < 0 ||
      e.clientX > window.innerWidth;
    const next = { ...current, dragging: true, detached, x: e.clientX, y: e.clientY };
    dragRef.current = next;
    setDrag(next);
    if (detached) return;
    // Still in the strip: slide it into the slot under the pointer. Only
    // among the regular tabs - the overflow folder isn't a drop slot.
    const first = strip.querySelector(".term-tab:not(.term-tab-folder)")?.getBoundingClientRect();
    if (!first || visibleTabs.length === 0) return;
    const slot = Math.max(0, Math.min(visibleTabs.length - 1, Math.floor((e.clientX - first.left) / TAB_SLOT)));
    if (tabs[slot]?.id !== current.id) onReorder(current.id, slot);
  }

  function endTabDrag(e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const current = dragRef.current;
    if (!current || e.pointerId !== current.pointerId) return;
    dragRef.current = null;
    setDrag(null);
    if (!current.dragging) return;
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (current.detached && !cancelled) onDragOut(current.id);
  }

  const draggedTab = drag?.dragging ? tabs.find((t) => t.id === drag.id) : undefined;

  function handleFolderTabClick() {
    if (!folderPreview) return;
    if (overflowAnchorRect) {
      setOverflowAnchorRect(null);
    } else if (activeInFolder) {
      // Already the selected tab - a second click is what opens the list.
      setOverflowAnchorRect(folderTabRef.current?.getBoundingClientRect() ?? null);
    } else {
      onSelect(folderPreview.id);
    }
  }

  return (
    <div className="tab-strip" ref={containerRef} data-tauri-drag-region>
      {visibleTabs.map((tab) => {
        return (
          <div
            key={tab.id}
            className={
              "term-tab" +
              (tab.id === activeId ? " is-active" : "") +
              (tab.kind === "terminal" ? " attn-" + agentAttention(agents?.get(tab.id), !!doneIds?.has(tab.id)) : "") +
              (draggedTab?.id === tab.id ? (drag?.detached ? " is-detached" : " is-dragging") : "")
            }
            onClick={() => {
              if (!suppressClickRef.current) onSelect(tab.id);
            }}
            onPointerDown={(e) => handleTabPointerDown(e, tab)}
            onPointerMove={handleTabPointerMove}
            onPointerUp={(e) => endTabDrag(e, false)}
            onPointerCancel={(e) => endTabDrag(e, true)}
            onDoubleClick={(e) => {
              // On the whole tab, not just its label: the pointerdown above
              // captures the pointer to the tab, so the label itself never
              // sees the double-click.
              if ((e.target as HTMLElement).closest(".term-tab-close, input")) return;
              startEditing(tab);
            }}
            onContextMenu={(e) => openMenu(e, tabMenuItems(tab))}
            title={tabTitle(tab)}
          >
            {tabIcon(tab, agents?.get(tab.id), doneIds?.has(tab.id))}
            {editingId === tab.id ? (
              <input
                ref={inputRef}
                className="term-tab-rename-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onBlur={commitEditing}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitEditing();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <span className="term-tab-label">{tabDisplayLabel(tab)}</span>
            )}
            {tab.kind === "terminal" && tab.notifyMuted && <MutedIcon />}
            {tab.kind === "editor" && dirtyIds?.has(tab.id) && (
              <span className="term-tab-dirty-dot" title={t("app.unsaved.title")} />
            )}
            <button
              type="button"
              className="term-tab-close"
              aria-label={t("tabs.closeNamed", { name: tabDisplayLabel(tab) })}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          </div>
        );
      })}
      {folderPreview && (
        <div
          ref={folderTabRef}
          className={"term-tab term-tab-folder attn-" + folderAttention + (activeInFolder ? " is-active" : "")}
          onClick={handleFolderTabClick}
          title={activeInFolder ? t("tabs.folder.clickAgain") : t("tabs.folder.grouped", { count: hiddenTabs.length })}
        >
          <span className={"term-tab-folder-icon is-" + folderAttention}>
            <FolderIcon />
            <span className="tab-overflow-count">{hiddenTabs.length}</span>
          </span>
          <span className="term-tab-label">{tabDisplayLabel(folderPreview)}</span>
        </div>
      )}
      <button
        type="button"
        className="term-tab-new"
        aria-label={t("menu.newTerminal")}
        title={t("tabs.new.title")}
        onClick={() => onNew()}
        onContextMenu={(e) => {
          // Only worth a picker when there's an actual choice - one option
          // (just "system") means this would open on a menu with nothing
          // useful to pick, so it falls straight through to a plain new tab.
          if (shellOptions.length <= 1) {
            onNew();
            return;
          }
          openMenu(
            e,
            shellOptions.map((opt) => ({ label: shellOptionLabel(opt), icon: shellOptionIcon(opt.id), onSelect: () => onNew(opt.id) })),
          );
        }}
      >
        <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      {draggedTab &&
        drag?.detached &&
        createPortal(
          <div className="tab-drag-ghost" style={{ left: drag.x - 24, top: drag.y - 15 }}>
            {tabIcon(draggedTab, agents?.get(draggedTab.id), doneIds?.has(draggedTab.id))}
            <span className="term-tab-label">{tabDisplayLabel(draggedTab)}</span>
          </div>,
          document.body,
        )}
      {overflowAnchorRect && (
        <TabOverflowMenu
          tabs={hiddenTabs}
          activeId={activeId}
          agents={agents}
          doneIds={doneIds}
          anchorRect={overflowAnchorRect}
          onSelect={onSelect}
          onCloseTab={onClose}
          onDismiss={() => setOverflowAnchorRect(null)}
        />
      )}
    </div>
  );
}
