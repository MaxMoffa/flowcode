import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { MenuIcons } from "../context-menu/menuIcons";
import { createPortal } from "react-dom";
import { listShellOptions, shellOptionLabel, type ShellOption } from "./shellOptions";
import type { AppTab } from "../tabs/types";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { useOpenContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { t, translationsOf, useI18n } from "../i18n";
import { agentCliIcon } from "../plugins/icons";
import { wslDistroOfShell } from "./wslPath";
import type { TabAgent } from "../agents/agentSessions";
import { profileById, useProfiles, type ProfileInfo } from "../profiles/profiles";
import { ChangelogIcon, ChatIcon, GearIcon } from "../app/icons";
import { SWEEP_DASHES } from "../../shared/busySweep";
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
  /** Terminal tab -> when its agent will be resumed (auto-resume). */
  resumeAt?: ReadonlyMap<string, number>;
  onCancelResume?: (tabId: string) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Creates a new terminal tab - `shellId` (a `list_shell_options` id, from
   * the "+" button's own context menu) picks a specific shell instead of the
   * configured default. */
  /** `profileId`: undefined = automatic, null = the default profile on
   * purpose, a string = that profile on purpose. */
  onNew: (shellId?: string, profileId?: string | null) => void;
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
  /** Narrow windows: narrower tabs, so more of them fit. */
  compact?: boolean;
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

// Tabs have a fixed CSS width, so a pointer position maps to a slot with plain
// arithmetic instead of measuring each tab - see tabstrip.css for the matching
// values.
const TAB_SLOT = 162; // 160px tab + 2px gap
const COMPACT_TAB_SLOT = 122; // 120px compact tab + 2px gap
/** Within this distance of the row's edge, dragging a tab scrolls it. */
const AUTOSCROLL_EDGE = 40;
/** Fastest auto-scroll speed while dragging, in px per frame. */
const AUTOSCROLL_MAX = 14;
/** Width of the row's faded edge under each scroll arrow (keep in sync with
 * --tab-fade-* in tabstrip.css): tabs scrolled into view clear it. */
const FADE_WIDTH = 48;

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={direction === "left" ? "M15 6 9 12l6 6" : "M9 6l6 6-6 6"} />
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

/** Shown on a terminal tab whose agent hit its usage limit and will be
 * resumed when it resets; a click gives that up. */
function ResumeBadge({ at, onCancel }: { at: number; onCancel: () => void }) {
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <button
      type="button"
      className="term-tab-resume"
      title={t("autoResume.badge.title", { time })}
      aria-label={t("autoResume.badge.title", { time })}
      // The tab starts a drag on pointer down and selects on click.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onCancel();
      }}
    >
      <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="11" height="11" stroke="currentColor" fill="none" aria-hidden="true">
        <circle cx="12" cy="13" r="7" />
        <path d="M12 9.5V13l2.2 1.5M5 4 2.5 6.5M19 4l2.5 2.5" />
      </svg>
      {time}
    </button>
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
  if (id === "system") return <GearIcon size={13} strokeWidth={1.8} />;
  // zsh/bash/sh (macOS/Linux builds) - same neutral prompt icon as cmd,
  // nothing platform-specific to tell them apart with.
  return <PromptIcon />;
}

/** A terminal tab running an agent CLI: its logo, which slowly turns and
 * pulses while the agent works. On a renamed tab (`renamed`) it's followed
 * by a "?" while it waits on the user: the CLIs show that state in the
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
      {renamed && agent.state === "waiting" && <span className="term-tab-agent-question">?</span>}
    </span>
  );
}

/** A chat tab's status as the strip's agent attention: it needs the user
 * while it waits on a permission, it works while it is busy. */
function chatAttention(tab: AppTab): "waiting" | "busy" | "idle" {
  if (tab.kind !== "chat") return "idle";
  return tab.status === "waiting" ? "waiting" : tab.status === "busy" ? "busy" : "idle";
}

/** The account profile a terminal or chat tab runs under, if it still exists. */
function tabProfile(profiles: ReturnType<typeof useProfiles>, tab: AppTab): ProfileInfo | undefined {
  return tab.kind === "terminal" || tab.kind === "chat" ? profileById(profiles, tab.profileId) : undefined;
}

/** The busy tab's arc, run round the outline at a constant speed (see tabstrip.css). */
function BusySweep() {
  return (
    <svg className="term-tab-sweep" aria-hidden="true">
      {SWEEP_DASHES.map((d, i) => (
        <rect key={i} width="100%" height="100%" rx="9.25" pathLength="100" style={{ strokeDasharray: d.dasharray, opacity: d.opacity }} />
      ))}
    </svg>
  );
}

/** `profile`: the tab's account profile, shown as a small colored dot on the
 * corner of its icon. The dot sits on a wrapper of its own, not on the logo,
 * so it stays on the icon's corner whatever the agent is doing. */
function tabIcon(tab: AppTab, agent?: TabAgent, done = false, profile?: ProfileInfo) {
  if (tab.kind === "chat") {
    const icon = (
      <span className="term-tab-agent">
        <span className={"term-tab-agent-logo is-" + chatAttention(tab)}>
          <ChatIcon size={13} strokeWidth={1.8} />
        </span>
      </span>
    );
    if (!profile) return icon;
    return (
      <span className="term-tab-profiled">
        {icon}
        <span className="term-tab-profile-badge" style={{ background: profile.color }} />
      </span>
    );
  }
  if (tab.kind === "terminal") {
    const icon = agent ? agentTabIcon(agent, !!tab.customLabel, done) : <span className={"term-tab-dot" + (done ? " is-done" : "")} />;
    if (!profile) return icon;
    return (
      <span className="term-tab-profiled">
        {icon}
        <span className="term-tab-profile-badge" style={{ background: profile.color }} />
      </span>
    );
  }
  if (tab.kind === "settings") return <GearIcon size={13} strokeWidth={1.8} />;
  if (tab.kind === "changelog" || tab.kind === "whatsNew") return <ChangelogIcon size={13} strokeWidth={1.8} />;
  return <FileTypeIcon name={tab.label} />;
}

/** The label shown for `tab`: a settings/changelog tab still carrying its
 * default name (in whichever language it was opened) is shown in the
 * current one. */
function tabDisplayLabel(tab: AppTab): string {
  if (tab.kind === "terminal" && tab.newTab) return t("newTab.title");
  if (tab.kind === "settings" && translationsOf("settings.title").includes(tab.label)) return t("settings.title");
  if (tab.kind === "changelog" && translationsOf("changelog.title").includes(tab.label)) return t("changelog.title");
  if (tab.kind === "whatsNew" && translationsOf("whatsNew.title").includes(tab.label)) return t("whatsNew.title");
  return tab.label;
}

function tabTitle(tab: AppTab, profile?: ProfileInfo): string {
  if (tab.kind === "terminal" || tab.kind === "chat") return profile ? `${tab.cwd}\n${t("tabs.profile", { name: profile.name })}` : tab.cwd;
  if (tab.kind === "editor" || tab.kind === "diff") return tab.path;
  return tabDisplayLabel(tab);
}

export function TabStrip({
  tabs,
  activeId,
  dirtyIds,
  agents,
  doneIds,
  resumeAt,
  onCancelResume,
  onSelect,
  onClose,
  onNew,
  onRename,
  onDuplicate,
  onToggleNotifications,
  onReorder,
  onDragOut,
  compact,
}: TabStripProps) {
  const { t } = useI18n();
  const profiles = useProfiles();
  const tabSlot = compact ? COMPACT_TAB_SLOT : TAB_SLOT;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const openMenu = useOpenContextMenu();
  // The tab being dragged, if any - state for rendering (the ghost, the
  // dimmed tab), mirrored in a ref for the pointer handlers.
  const [drag, setDrag] = useState<TabDrag | null>(null);
  const dragRef = useRef<TabDrag | null>(null);
  // Auto-scroll while dragging near the row's edge: the frame loop and a
  // pointer-to-slot function re-assigned every render (the loop outlives
  // the render that started it, and `tabs` moves on under it).
  const autoScrollRef = useRef(0);
  const reorderAtRef = useRef<(id: string, clientX: number) => void>(() => {});
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

  function updateScrollState() {
    const el = viewportRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 1);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(updateScrollState);
    observer.observe(el);
    el.addEventListener("scroll", updateScrollState, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", updateScrollState);
    };
  }, []);

  // The row's content width changed.
  useEffect(updateScrollState, [tabs]);

  // A vertical wheel scrolls the row sideways (a horizontal one already does).
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * el.clientWidth : e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the active tab in view. Done by hand on the row alone:
  // scrollIntoView could scroll the window's other containers too.
  const shownActiveRef = useRef<string | null>(null);
  useEffect(() => {
    const el = viewportRef.current;
    const index = tabs.findIndex((tab) => tab.id === activeId);
    const tabEl = el?.children[index] as HTMLElement | undefined;
    const activeChanged = shownActiveRef.current !== activeId;
    shownActiveRef.current = activeId;
    // A drag moves tabs under the pointer; its auto-scroll owns the position.
    if (!el || !tabEl || dragRef.current?.dragging) return;
    const behavior = activeChanged ? "smooth" : "auto";
    // The arrows' overlays cover the row's edges, so a tab under one isn't
    // really in view - unless it's the first/last, where that arrow goes away.
    const leftInset = el.scrollLeft > 1 ? FADE_WIDTH : 0;
    const rightInset = el.scrollLeft + el.clientWidth < el.scrollWidth - 1 ? FADE_WIDTH : 0;
    if (tabEl.offsetLeft < el.scrollLeft + leftInset) {
      el.scrollTo({ left: tabEl.offsetLeft - FADE_WIDTH, behavior });
    } else if (tabEl.offsetLeft + tabEl.offsetWidth > el.scrollLeft + el.clientWidth - rightInset) {
      el.scrollTo({ left: tabEl.offsetLeft + tabEl.offsetWidth - el.clientWidth + FADE_WIDTH, behavior });
    }
  }, [activeId, tabs]);

  useEffect(() => () => cancelAnimationFrame(autoScrollRef.current), []);

  function scrollByPage(direction: -1 | 1) {
    const el = viewportRef.current;
    if (!el) return;
    const slots = Math.max(1, Math.floor(el.clientWidth / tabSlot));
    el.scrollBy({ left: direction * slots * tabSlot, behavior: "smooth" });
  }

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
    if (tab.kind === "terminal" || tab.kind === "editor" || tab.kind === "chat") {
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
    if (detached) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = 0;
      return;
    }
    // Still in the strip: slide it into the slot under the pointer.
    reorderAtRef.current(current.id, e.clientX);
    if (!autoScrollRef.current) autoScrollRef.current = requestAnimationFrame(autoScrollTick);
  }

  // Scroll-aware, so it works across tabs that are out of view.
  reorderAtRef.current = (id, clientX) => {
    const el = viewportRef.current;
    const first = el?.querySelector<HTMLElement>(".term-tab");
    if (!el || !first || tabs.length === 0) return;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft - first.offsetLeft;
    const slot = Math.max(0, Math.min(tabs.length - 1, Math.floor(x / tabSlot)));
    if (tabs[slot]?.id !== id) onReorder(id, slot);
  };

  // Runs while a tab is dragged inside the strip: near either edge of the
  // row it scrolls, faster the closer the pointer is, and the dragged tab
  // keeps following the pointer.
  function autoScrollTick() {
    autoScrollRef.current = 0;
    const current = dragRef.current;
    const el = viewportRef.current;
    if (!current?.dragging || current.detached || !el) return;
    const rect = el.getBoundingClientRect();
    const fromLeft = Math.max(0, current.x - rect.left);
    const fromRight = Math.max(0, rect.right - current.x);
    const speed = (edge: number) => ((AUTOSCROLL_EDGE - edge) / AUTOSCROLL_EDGE) * AUTOSCROLL_MAX;
    const delta = fromLeft < AUTOSCROLL_EDGE ? -speed(fromLeft) : fromRight < AUTOSCROLL_EDGE ? speed(fromRight) : 0;
    if (delta !== 0) {
      const before = el.scrollLeft;
      el.scrollLeft += delta;
      if (el.scrollLeft !== before) reorderAtRef.current(current.id, current.x);
    }
    autoScrollRef.current = requestAnimationFrame(autoScrollTick);
  }

  function endTabDrag(e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) {
    const current = dragRef.current;
    if (!current || e.pointerId !== current.pointerId) return;
    dragRef.current = null;
    cancelAnimationFrame(autoScrollRef.current);
    autoScrollRef.current = 0;
    setDrag(null);
    if (!current.dragging) return;
    suppressClickRef.current = true;
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
    if (current.detached && !cancelled) onDragOut(current.id);
  }

  const draggedTab = drag?.dragging ? tabs.find((t) => t.id === drag.id) : undefined;

  return (
    <div className={"tab-strip" + (compact ? " is-compact" : "")} ref={containerRef} data-tauri-drag-region>
      <div className="tab-strip-scroller">
        <div
          className={"tab-strip-viewport" + (canScrollLeft ? " fade-left" : "") + (canScrollRight ? " fade-right" : "")}
          ref={viewportRef}
          data-tauri-drag-region
        >
          {tabs.map((tab) => {
            const attention =
              tab.kind === "terminal"
                ? agentAttention(agents?.get(tab.id), !!doneIds?.has(tab.id))
                : tab.kind === "chat"
                  ? chatAttention(tab)
                  : null;
            return (
              <div
                key={tab.id}
                className={
                  "term-tab" +
                  (tab.id === activeId ? " is-active" : "") +
                  (attention ? " attn-" + attention : "") +
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
                title={tabTitle(tab, tabProfile(profiles, tab))}
              >
                {attention === "busy" && <BusySweep />}
                {tabIcon(tab, agents?.get(tab.id), doneIds?.has(tab.id), tabProfile(profiles, tab))}
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
                {tab.kind === "terminal" && resumeAt?.has(tab.id) && onCancelResume && (
                  <ResumeBadge at={resumeAt.get(tab.id)!} onCancel={() => onCancelResume(tab.id)} />
                )}
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
        </div>
        {/* Always mounted, over the tabs, so they fade in and out instead of
            popping and shifting the row. */}
        <div className={"term-tab-fade is-left" + (canScrollLeft ? " is-visible" : "")} aria-hidden={!canScrollLeft}>
          <button
            type="button"
            className="term-tab-scroll"
            tabIndex={canScrollLeft ? 0 : -1}
            aria-label={t("tabs.scrollLeft")}
            onClick={() => scrollByPage(-1)}
          >
            <ChevronIcon direction="left" />
          </button>
        </div>
        <div className={"term-tab-fade is-right" + (canScrollRight ? " is-visible" : "")} aria-hidden={!canScrollRight}>
          <button
            type="button"
            className="term-tab-scroll"
            tabIndex={canScrollRight ? 0 : -1}
            aria-label={t("tabs.scrollRight")}
            onClick={() => scrollByPage(1)}
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="term-tab-new"
        aria-label={t("menu.newTerminal")}
        title={t("tabs.new.title")}
        onClick={() => onNew()}
        onContextMenu={(e) => {
          // Only worth a picker when there's an actual choice - one shell
          // (just "system") and no profile means this would open on a menu
          // with nothing useful to pick, so it falls straight through to a
          // plain new tab.
          if (shellOptions.length <= 1 && profiles.profiles.length === 0) {
            onNew();
            return;
          }
          const items: ContextMenuItem[] = shellOptions.map((opt) => ({
            label: shellOptionLabel(opt),
            icon: shellOptionIcon(opt.id),
            onSelect: () => onNew(opt.id),
          }));
          if (profiles.profiles.length > 0) {
            // Env vars don't reach a WSL distro, so a profile only pairs
            // with the other shells.
            const hostShells = shellOptions.filter((opt) => wslDistroOfShell(opt.id) === undefined);
            const profileRow = (label: string, profileId: string | null, dot: ReactNode): ContextMenuItem => {
              const pick = (shellId?: string) => onNew(shellId, profileId);
              return hostShells.length > 1
                ? {
                    label,
                    icon: dot,
                    submenu: hostShells.map((opt) => ({
                      label: shellOptionLabel(opt),
                      icon: shellOptionIcon(opt.id),
                      onSelect: () => pick(opt.id),
                    })),
                  }
                : { label, icon: dot, onSelect: () => pick(hostShells[0]?.id) };
            };
            items.push(
              { label: "sep-profiles", separator: true },
              profileRow(t("agents.profile.default"), null, <span className="context-menu-profile-dot is-default" />),
              ...profiles.profiles.map((p) =>
                profileRow(p.name, p.id, <span className="context-menu-profile-dot" style={{ background: p.color }} />),
              ),
            );
          }
          openMenu(e, items);
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
            {tabIcon(draggedTab, agents?.get(draggedTab.id), doneIds?.has(draggedTab.id), tabProfile(profiles, draggedTab))}
            <span className="term-tab-label">{tabDisplayLabel(draggedTab)}</span>
          </div>,
          document.body,
        )}
    </div>
  );
}
