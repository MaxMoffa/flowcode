import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "./terminal.css";
import "./wide.css";
import { AgentsScreen } from "./Agents";
import { AgentInsight } from "./AgentInsight";
import { useBackHandler, useEscape } from "./back";
import { chatKey, ptyKey, remoteEntries, type RemoteEntry } from "../../shared/remoteEntries";
import { nextDone } from "./doneTabs";
import { effectivePhone, phoneTheme, setPhoneTheme } from "./theme";
import { ChatClearing } from "./ChatClearing";
import { closeChatTab, requestOpenChat, useClearing } from "./chats";
import { lastInWindow } from "./homeSessions";
import { dropIndex, moveWithinWindow, windowRange } from "./tabDrag";
import { ComputerSwitcher } from "./ComputerSwitcher";
import { t } from "./i18n";
import { AgentLogo, AgentsIcon, ChatIcon, CloseIcon, FileIcon, FolderIcon, GridIcon, KebabIcon, PlusIcon, SlidersIcon, TerminalIcon } from "./icons";
import { NewTerminalSheet } from "./NewTerminalSheet";
import { interrupt, send, sendChecked, showToast, useRemoteSelector, useSupports, type ChatInfo, type ConnStatus, type MirroredSettings, type Tab } from "./remote";
import { TermActions, runAction } from "./TermActions";
import { BusyArc, useOpenNew } from "./Terminals";
import { setUiScale, useUiScale, useUiZoom } from "./uiScale";
import { useSheetDrag } from "./useSheetDrag";
import { useSideWidth } from "./useSideWidth";
import { panelsFit, setPanelMode, usePanelMode } from "./panelMode";
import { useBigScreen, useDocked } from "./wide";
import { Browser } from "./Browser";
import { Launcher } from "./Home";
import { CHAT_VIEW, TERMINAL_VIEW } from "./ChatMenu";
import { defaultViewFor } from "./defaultView";
import { shortCwd } from "./common";
import { tabIndexFor, useWideShortcuts, type WideShortcut } from "./useWideShortcuts";
import { useChatBrowser } from "./useChatBrowser";
import { WideDiffView } from "./WideDiffView";
import { LegacyFileView, WideFileView } from "./WideFileView";
import { WideSidebar } from "./WideSidebar";
import { launchPath } from "./explorerPaths";
import { folderName } from "./explorerRemote";
import { WideMenu } from "./WideMenu";
import { WideChangelog } from "./WideChangelog";
import { WideUsageAction } from "./WideUsageAction";

const TerminalScreen = lazy(() => import("./TerminalScreen").then((m) => ({ default: m.TerminalScreen })));
const SettingsScreen = lazy(() => import("./Settings").then((m) => ({ default: m.SettingsScreen })));
const ChatScreen = lazy(() => import("./ChatScreen").then((m) => ({ default: m.ChatScreen })));
const noop = () => {};

/** The tab's agent state as the desktop's .attn-* classes (see wide.css). */
const attnClass = (status?: string, done = false) => (status === "busy" ? " attn-busy" : status === "waiting" ? " attn-wait" : done ? " attn-done" : "");

/** An entry's agent status (a plain terminal has none). */
const statusOf = (e: RemoteEntry) => (e.kind === "pty" ? (e.tab.cli ? e.tab.status : undefined) : e.chat.status);

/** The busy tab's arc, run round its outline as on the desktop (shared/busySweep.ts). */
const TabSweep = () => <BusyArc className="tr-sweep w-tab-sweep" rx={9.25} />;

/** A non-terminal tab: the new-tab page, the settings page, a file (absolute path; with `ptyId`, a path relative to that terminal's folder, for desktops without the file explorer) or the diff of a changed file. */
type Doc =
  | { id: "settings"; kind: "settings" }
  | { id: "newtab"; kind: "newtab" }
  | { id: string; kind: "file"; path: string; ptyId?: string }
  | { id: string; kind: "diff"; root: string; path: string; staged: boolean; status: string };

interface Props {
  hostName?: string;
  tabs: Tab[] | null;
  settings: MirroredSettings | null;
  status: ConnStatus;
  activePty: string | null;
  onSelectPty: (ptyId: string) => void;
  /** The chat session shown instead of a terminal. */
  activeChat: string | null;
  /** Turns a chat into a terminal tab on the desktop (see App). */
  onTerminal: (chat: ChatInfo) => void;
  /** Turns an agent's terminal into a chat shown with the given view. */
  onChat: (ptyId: string, view: string) => void;
  /** Opens another chat linked from the one shown. */
  onOpenChat: (chatId: string) => void;
  onAddComputer: () => void;
}

/** The desktop-like layout of large screens: a header (panel toggles, tab strip, quick actions), then cards: files, one terminal, agents. */
export function WideShell({ hostName, tabs, settings, status, activePty, onSelectPty, activeChat, onTerminal, onChat, onOpenChat, onAddComputer }: Props) {
  const clearing = useClearing();
  const docked = useDocked();
  const big = useBigScreen();
  const panelMode = usePanelMode();
  const zoom = useUiZoom();
  const uiScale = useUiScale();
  const localTheme = phoneTheme.use();
  const [agentsOpen, setAgentsOpen] = useState(docked);
  const [filesOpen, setFilesOpen] = useState(docked && big);
  /** The open non-terminal tabs, in opening order. */
  const [docs, setDocs] = useState<Doc[]>([]);
  /** The id of the shown doc; null = the terminal is shown. */
  const [doc, setDoc] = useState<string | null>(null);
  const [sheet, setSheet] = useState(false);
  const openSheet = () => setSheet(true);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [computersOpen, setComputersOpen] = useState(false);
  /** The key bar docked under the terminal. */
  const [keys, setKeys] = useState(true);
  const actions = useRemoteSelector((r) => r.actions);
  const chats = useRemoteSelector((r) => r.chats);
  const canRename = useSupports("rename");
  const canClose = useSupports("closeTab");
  const canCloseChat = useSupports("chatCloseTab");
  const canRenameChat = useSupports("chatRename");
  const canBrowse = useSupports("preview");
  const canChat = useSupports("chat");
  const canTabOps = useSupports("tabOps");
  const { opened: browserOpen, open: openBrowser, close: closeBrowser, show: showBrowserPage, pending: browserPending, dismissPending, page: browserPage, chatId: browserChatId, linksChatId } = useChatBrowser(doc === null ? activeChat : null);
  /** The key of the tab being renamed (terminal or chat), with its draft label. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The tab menu (long press / right click): the entry's key and where it opens. */
  const [tabMenu, setTabMenu] = useState<{ key: string; left: number; top: number } | null>(null);
  /** Entries whose agent finished while another tab was shown. */
  const [done, setDone] = useState<Set<string>>(() => new Set());
  const prevStatus = useRef(new Map<string, string | undefined>());
  const [draft, setDraft] = useState("");
  const cancelRename = useRef(false);

  const all = useMemo(() => tabs ?? [], [tabs]);
  const reported = useMemo(() => remoteEntries(all, chats ?? []), [all, chats]);
  /** The order a finished drag left the keys in, shown until the desktop's next report (or a short timeout). */
  const [optimistic, setOptimistic] = useState<string[] | null>(null);
  useEffect(() => setOptimistic(null), [all, chats]);
  useEffect(() => {
    if (!optimistic) return;
    const id = window.setTimeout(() => setOptimistic(null), 3000);
    return () => window.clearTimeout(id);
  }, [optimistic]);
  const entries = useMemo(() => {
    if (!optimistic) return reported;
    const byKey = new Map(reported.map((e) => [e.key, e]));
    // Only when the keys still match the report (a tab opened or closed meanwhile drops the override).
    if (optimistic.length !== reported.length || !optimistic.every((k) => byKey.has(k))) return reported;
    return optimistic.map((k) => byKey.get(k) as RemoteEntry);
  }, [reported, optimistic]);
  const folders = useMemo(() => [...new Set(all.map((x) => x.cwd).filter(Boolean))], [all]);
  const select = (ptyId: string) => {
    setDoc(null);
    onSelectPty(ptyId);
  };
  const { onCreate, pending } = useOpenNew(tabs, select);
  // Opening a chat from the agents panel or a notification leaves a file or settings tab.
  useEffect(() => {
    if (activeChat) setDoc(null);
  }, [activeChat]);
  const files = useSideWidth({ key: "wide.filesWidth", defaultWidth: 260, min: 200, max: 520, edge: "right" });
  const agents = useSideWidth({ key: "wide.agentsWidth", defaultWidth: 290, min: 220, max: 520, edge: "left" });
  const browserSide = useSideWidth({ key: "wide.browserWidth", defaultWidth: 420, min: 300, max: 900, edge: "left" });
  // Docking opens the panels, floating closes them. Where both would squeeze the terminal, only the agents open (the files toggle opens them).
  useEffect(() => {
    setAgentsOpen(docked);
    setFilesOpen(docked && panelsFit(window.innerWidth, zoom, files.width ?? 260, agents.width ?? 290));
    // Only when the docked state flips, not on every resize or drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docked]);
  // The browser card docks between the terminal and the agents. When the three cards would squeeze the terminal below its minimum, the files card gives way (the files toggle brings it back).
  const browserShown = browserOpen && canBrowse;
  useEffect(() => {
    if (!docked || !browserShown) return;
    const right = (agentsOpen ? (agents.width ?? 290) : 0) + (browserSide.width ?? 420);
    if (!panelsFit(window.innerWidth, zoom, files.width ?? 260, right)) setFilesOpen(false);
    // Only when the browser opens or the layout docks, not on every drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docked, browserShown]);
  const closeDrawers = () => {
    setAgentsOpen(false);
    setFilesOpen(false);
  };
  useBackHandler(!docked && (agentsOpen || filesOpen), closeDrawers);
  // Floating panels (not docked) close by dragging them back toward their edge.
  const filesPanel = useRef<HTMLElement>(null);
  const agentsPanel = useRef<HTMLElement>(null);
  useSheetDrag(filesPanel, () => setFilesOpen(false), !docked && filesOpen, "left");
  useSheetDrag(agentsPanel, () => setAgentsOpen(false), !docked && agentsOpen, "right");
  useBackHandler(doc !== null, () => setDoc(null));

  // A closed terminal takes its relative (legacy) files with it; absolute ones stay.
  useEffect(() => {
    if (tabs === null) return;
    const live = new Set(tabs.map((x) => x.ptyId));
    const keep = docs.filter((d) => d.kind !== "file" || !d.ptyId || live.has(d.ptyId));
    if (keep.length === docs.length) return;
    setDocs(keep);
    if (doc !== null && !keep.some((d) => d.id === doc)) setDoc(null);
  }, [tabs, docs, doc]);

  // A tab closed on the desktop ends its rename and its menu.
  useEffect(() => {
    if (renaming !== null && !entries.some((e) => e.key === renaming)) setRenaming(null);
    if (tabMenu !== null && !entries.some((e) => e.key === tabMenu.key)) setTabMenu(null);
  }, [entries, renaming, tabMenu]);

  const startRename = (e: RemoteEntry) => {
    setDraft(e.kind === "pty" ? e.tab.label : e.chat.label);
    setRenaming(e.key);
  };
  /** Ends the title edit: Escape sets `cancelRename` before blurring, so it is dropped here. */
  const commitRename = (e: RemoteEntry) => {
    if (cancelRename.current) {
      cancelRename.current = false;
      setRenaming(null);
      return;
    }
    const label = draft.trim();
    setRenaming(null);
    if (e.kind === "pty") {
      if (label && label !== e.tab.label) send({ t: "rename", ptyId: e.tab.ptyId, label });
    } else if (label && label !== e.chat.label) send({ t: "chatrename", chatId: e.chat.chatId, label });
  };
  const closeEntry = (e: RemoteEntry) => {
    if (e.kind === "pty") {
      if (window.confirm(t("closeTerminalConfirm", { label: e.tab.label }))) send({ t: "closetab", ptyId: e.tab.ptyId });
    } else if (window.confirm(t("closeChatConfirm", { label: e.chat.label }))) closeChatTab(e.chat.chatId);
  };
  const canRenameEntry = (e: RemoteEntry) => (e.kind === "pty" ? canRename : canRenameChat);
  const canCloseEntry = (e: RemoteEntry) => (e.kind === "pty" ? canClose : canCloseChat) && !lastInWindow(e.kind === "pty" ? e.tab.window : e.chat.window, all, chats ?? []);

  // Long press (or right click) on a tab opens its menu; the click that follows a long press is swallowed.
  const press = useRef<{ x: number; y: number; timer: number } | null>(null);
  const swallowClick = useRef(false);
  const cancelPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const canDuplicateEntry = (_e: RemoteEntry) => canTabOps; // ChatInfo carries no delegate marker, so every chat is offered.
  const canNotifyEntry = (e: RemoteEntry) => canTabOps && e.kind === "pty";
  const openTabMenu = (e: RemoteEntry, el: HTMLElement) => {
    if (!canRenameEntry(e) && !canCloseEntry(e) && !canDuplicateEntry(e)) return;
    const r = el.getBoundingClientRect();
    setTabMenu({ key: e.key, left: Math.max(4, Math.min(r.left, window.innerWidth - 194)), top: r.bottom + 4 });
  };
  const tabTarget = (e: RemoteEntry) => (e.kind === "pty" ? { ptyId: e.tab.ptyId } : { chatId: e.chat.chatId });

  // Drag to reorder: a mouse or pen drags after 6 px; a finger drags once the long press has opened the menu and then moves 10 px.
  const gesture = useRef<{ key: string; x: number; y: number; touch: boolean; menuShown: boolean; unblock: (() => void) | null } | null>(null);
  const drag = useRef<{ key: string; x0: number; rects: { left: number; width: number }[]; from: number; start: number; end: number; keys: string[]; target: number } | null>(null);
  const [dragView, setDragView] = useState<{ key: string; dx: number; before: string | null; after: string | null } | null>(null);
  const endGesture = () => {
    gesture.current?.unblock?.();
    gesture.current = null;
  };
  const beginDrag = (e: RemoteEntry, el: HTMLElement, ev: React.PointerEvent<HTMLElement>) => {
    const strip = tabsRef.current;
    const g = gesture.current;
    if (!strip || !g) return;
    const keys = entries.map((x) => x.key);
    const wins = entries.map((x) => (x.kind === "pty" ? x.tab.window : x.chat.window));
    const at = keys.indexOf(e.key);
    if (at < 0) return;
    const { start, end } = windowRange(wins, at);
    const rects = keys.slice(start, end).map((k) => {
      const t = strip.querySelector<HTMLElement>(`[data-tab-key="${k}"]`);
      return { left: t?.offsetLeft ?? 0, width: t?.offsetWidth ?? 0 };
    });
    cancelPress();
    setTabMenu(null);
    try {
      el.setPointerCapture(ev.pointerId);
    } catch {
      // The pointer is gone already; the drag then ends with the next event.
    }
    drag.current = { key: e.key, x0: g.x, rects, from: at - start, start, end, keys, target: at - start };
    swallowClick.current = true;
    updateDrag(ev.clientX);
  };
  const updateDrag = (clientX: number) => {
    const d = drag.current;
    const strip = tabsRef.current;
    if (!d || !strip) return;
    const x = clientX - strip.getBoundingClientRect().left + strip.scrollLeft;
    d.target = dropIndex(x, d.rects, d.from);
    const others = d.keys.slice(d.start, d.end).filter((k) => k !== d.key);
    setDragView({ key: d.key, dx: clientX - d.x0, before: others[d.target] ?? null, after: d.target >= others.length ? (others[others.length - 1] ?? null) : null });
  };
  const finishDrag = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    setDragView(null);
    if (!d || !commit || d.target === d.from) return;
    const entry = entries.find((x) => x.key === d.key);
    if (!entry) return;
    setOptimistic(moveWithinWindow(d.keys, d.key, d.start, d.end, d.target));
    send({ t: "tabop", target: tabTarget(entry), op: { kind: "move", index: d.target } });
  };
  const pressProps = (e: RemoteEntry) => ({
    onPointerDown: (ev: React.PointerEvent<HTMLElement>) => {
      cancelPress();
      endGesture();
      swallowClick.current = false;
      if (ev.pointerType === "mouse" && ev.button !== 0) return;
      const el = ev.currentTarget;
      const touch = ev.pointerType === "touch";
      gesture.current = { key: e.key, x: ev.clientX, y: ev.clientY, touch, menuShown: false, unblock: null };
      const timer = window.setTimeout(() => {
        press.current = null;
        swallowClick.current = true;
        openTabMenu(e, el);
        const g = gesture.current;
        if (!g || g.key !== e.key) return;
        g.menuShown = true;
        if (touch && canTabOps) {
          // The finger has not moved yet: keep the strip from scrolling so the move can become a drag.
          const block = (te: TouchEvent) => {
            if (te.cancelable) te.preventDefault();
          };
          el.addEventListener("touchmove", block, { passive: false });
          g.unblock = () => el.removeEventListener("touchmove", block);
        }
      }, 450);
      press.current = { x: ev.clientX, y: ev.clientY, timer };
    },
    onPointerMove: (ev: React.PointerEvent<HTMLElement>) => {
      if (drag.current) {
        if (drag.current.key === e.key) updateDrag(ev.clientX);
        return;
      }
      const g = gesture.current;
      if (g && canTabOps && g.key === e.key) {
        const moved = Math.hypot(ev.clientX - g.x, ev.clientY - g.y);
        if (!g.touch && moved > 6) {
          beginDrag(e, ev.currentTarget, ev);
          return;
        }
        if (g.touch && g.menuShown && moved > 10) {
          beginDrag(e, ev.currentTarget, ev);
          return;
        }
      }
      if (press.current && Math.hypot(ev.clientX - press.current.x, ev.clientY - press.current.y) > 8) cancelPress();
    },
    onPointerUp: () => {
      cancelPress();
      if (drag.current?.key === e.key) finishDrag(true);
      endGesture();
    },
    onPointerCancel: () => {
      cancelPress();
      if (drag.current?.key === e.key) finishDrag(false);
      endGesture();
    },
    onContextMenu: (ev: React.MouseEvent<HTMLElement>) => {
      ev.preventDefault();
      cancelPress();
      openTabMenu(e, ev.currentTarget);
    },
    onClickCapture: (ev: React.MouseEvent<HTMLElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      ev.stopPropagation();
      ev.preventDefault();
    },
  });
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  useBackHandler(tabMenu !== null, closeTabMenu);
  useEscape(tabMenu !== null, closeTabMenu);

  const openDoc = (d: Doc) => {
    setDocs((cur) => (cur.some((x) => x.id === d.id) ? cur : [...cur, d]));
    setDoc(d.id);
  };
  const openFile = (path: string) => openDoc({ id: `file:${path}`, kind: "file", path });
  const openLegacyFile = (ptyId: string, path: string) => openDoc({ id: `file:${ptyId}:${path}`, kind: "file", ptyId, path });
  const openDiff = (root: string, path: string, staged: boolean, status: string) => openDoc({ id: `diff:${root}:${path}:${staged}`, kind: "diff", root, path, staged, status });
  const openTerminalAt = async (path: string) => {
    if (await sendChecked({ t: "newtab", cwd: launchPath(path) })) onCreate(false, `${t("terminals")} · ${folderName(path)}`);
  };
  const closeDoc = (id: string) => {
    const i = docs.findIndex((d) => d.id === id);
    setDocs(docs.filter((d) => d.id !== id));
    if (doc === id) setDoc(i > 0 ? docs[i - 1].id : null);
  };
  const openNewTab = () => openDoc({ id: "newtab", kind: "newtab" });
  // The launch from the new-tab page produced its tab (it is selected by the pending logic): the page is done.
  const hadPending = useRef(false);
  useEffect(() => {
    if (pending && !pending.failed) hadPending.current = true;
    else if (!pending && hadPending.current) {
      hadPending.current = false;
      if (docs.some((d) => d.id === "newtab")) closeDoc("newtab");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);
  const toggleAgents = () => {
    if (!docked && !agentsOpen) setFilesOpen(false);
    setAgentsOpen((v) => !v);
  };
  const toggleFiles = () => {
    if (!docked && !filesOpen) setAgentsOpen(false);
    setFilesOpen((v) => !v);
  };

  // A narrow strip scrolls: keep the shown tab in view (within the strip only).
  const tabsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = tabsRef.current;
    const tab = strip?.querySelector<HTMLElement>(".w-tab.on");
    if (!strip || !tab) return;
    if (tab.offsetLeft < strip.scrollLeft) strip.scrollLeft = tab.offsetLeft;
    else if (tab.offsetLeft + tab.offsetWidth > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = tab.offsetLeft + tab.offsetWidth - strip.clientWidth;
  }, [doc, activePty, docs.length]);

  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const closeActions = useCallback(() => setActionsOpen(false), []);

  const active = activePty ? all.find((x) => x.ptyId === activePty) : undefined;
  const shown = doc !== null ? docs.find((d) => d.id === doc) : undefined;
  const activeFile = shown?.kind === "file" && (shown.ptyId ? shown.ptyId === activePty : true) ? shown.path : null;
  const fileTab = shown?.kind === "file" && shown.ptyId ? all.find((x) => x.ptyId === shown.ptyId) : undefined;
  /** The chat of the shown tab (while no terminal is). */
  const chatInfo = !active && activeChat ? (chats ?? []).find((c) => c.chatId === activeChat) : undefined;
  const sideCwd = active?.cwd || chatInfo?.cwd || null;
  const sideAgent = active?.cli ? { cli: active.cli, profile: active.profile ?? null, sessionId: null, view: "terminal" as const } : chatInfo ? { cli: chatInfo.agent, profile: chatInfo.profile ?? null, sessionId: chatInfo.sessionId ?? null, view: "chat" as const } : null;
  const menuEntry = tabMenu ? entries.find((x) => x.key === tabMenu.key) : undefined;
  /** The entry whose tab is open (none while a settings or file tab is). */
  const shownKey = doc !== null ? null : active ? ptyKey(active.ptyId) : activeChat ? chatKey(activeChat) : null;
  /** The agent in front, for the right panel: its chat, or its terminal tab. */
  const frontChat = doc === null && !active ? activeChat : null;
  const front = !!frontChat || (doc === null && !!active?.cli);

  // A tab whose agent stopped working while another was shown gets the "done" outline until it is opened.
  useEffect(() => {
    const list = entries.map((e) => ({ key: e.key, status: statusOf(e) }));
    const next = nextDone(prevStatus.current, list, shownKey, done);
    prevStatus.current = new Map(list.map((x) => [x.key, x.status]));
    if (next.size !== done.size || [...next].some((k) => !done.has(k))) setDone(next);
    // `done` is only read to carry it over; the effect runs when statuses or the shown tab change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, shownKey]);

  // Hardware shortcuts (the desktop's defaults): the tab strip's order is the entries, then the page tabs.
  const stripIds = [...entries.map((e) => e.key), ...docs.map((d) => "doc:" + d.id)];
  const currentIdx = stripIds.indexOf(doc !== null ? "doc:" + doc : (shownKey ?? ""));
  const showStrip = (i: number) => {
    const id = stripIds[i];
    if (id === undefined) return;
    if (id.startsWith("doc:")) {
      setDoc(id.slice(4));
      return;
    }
    const e = entries.find((x) => x.key === id);
    if (!e) return;
    if (e.kind === "chat") {
      setDoc(null);
      requestOpenChat(e.chat.chatId);
    } else select(e.tab.ptyId);
  };
  const runShortcut = (a: WideShortcut): boolean => {
    switch (a) {
      case "newTab":
        openNewTab();
        return true;
      case "closeTab": {
        if (doc !== null) {
          closeDoc(doc);
          return true;
        }
        const e = shownKey ? entries.find((x) => x.key === shownKey) : undefined;
        if (!e || !canCloseEntry(e)) return false;
        closeEntry(e);
        return true;
      }
      case "toggleSidebar":
        toggleFiles();
        return true;
      case "toggleAgents":
        toggleAgents();
        return true;
      case "toggleBrowser":
        if (browserOpen) closeBrowser();
        else if (canBrowse) openBrowser();
        else return false;
        return true;
      case "toggleView": {
        if (doc !== null) return false;
        if (active?.cli) {
          if (active.status === "busy") return false;
          // The same default view as picking a non-terminal view in the terminal's menu.
          const view = defaultViewFor(true);
          showToast(t("termChatWaiting"));
          onChat(active.ptyId, view === TERMINAL_VIEW ? CHAT_VIEW : view);
          return true;
        }
        if (chatInfo) {
          onTerminal(chatInfo);
          return true;
        }
        return false;
      }
      default: {
        const i = tabIndexFor(a, stripIds.length, currentIdx);
        if (i === null) return false;
        showStrip(i);
        return true;
      }
    }
  };
  useWideShortcuts(runShortcut, !sheet && renaming === null);

  return (
    <div className={"screen wide" + (docked ? " docked" : "") + (big ? "" : " narrow")} style={{ "--w-zoom": zoom } as CSSProperties}>
      <header className="w-top">
        <button type="button" className="w-ib" aria-label={t("showFiles")} aria-pressed={filesOpen} onClick={toggleFiles}>
          <FolderIcon />
        </button>
        <ComputerSwitcher pill hostName={hostName} onAdd={onAddComputer} open={computersOpen} onOpenChange={setComputersOpen} />
        <div className="w-tabs" role="tablist" ref={tabsRef}>
          {entries.map((e, i) => {
            const win = e.kind === "pty" ? e.tab.window : e.chat.window;
            const prevEntry = entries[i - 1];
            const sep = prevEntry && (prevEntry.kind === "pty" ? prevEntry.tab.window : prevEntry.chat.window) !== win ? <i className="w-tab-sep" aria-hidden="true" title={win} /> : null;
            const status = statusOf(e);
            const attn = attnClass(status, done.has(e.key));
            const label = e.kind === "pty" ? e.tab.label : e.chat.label;
            const on = doc === null && (e.kind === "pty" ? e.tab.ptyId === activePty : e.chat.chatId === activeChat);
            const ico =
              e.kind === "pty" ? (
                <span className="w-tab-ico">{(e.tab.cli && <AgentLogo cli={e.tab.cli} size={16} />) || <TerminalIcon />}</span>
              ) : (
                <span className="w-tab-ico">
                  <AgentLogo cli={e.chat.agent} size={16} />
                  <i className="w-tab-bubble" aria-hidden="true">
                    <ChatIcon size={9} />
                  </i>
                </span>
              );
            if (renaming === e.key)
              return (
                <Fragment key={e.key}>
                  {sep}
                  <div role="tab" aria-selected={on} className={"w-tab on" + attn}>
                    {status === "busy" && <TabSweep />}
                    {ico}
                    <input
                      className="w-tab-input"
                      value={draft}
                      autoFocus
                      maxLength={128}
                      enterKeyHint="done"
                      aria-label={e.kind === "pty" ? t("renameTerminal") : t("rename")}
                      onFocus={(ev) => ev.currentTarget.select()}
                      onChange={(ev) => setDraft(ev.target.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") ev.currentTarget.blur();
                        else if (ev.key === "Escape") {
                          cancelRename.current = true;
                          ev.currentTarget.blur();
                        }
                      }}
                      onBlur={() => commitRename(e)}
                    />
                  </div>
                </Fragment>
              );
            return (
              <Fragment key={e.key}>
                {sep}
                <button
                  type="button"
                  role="tab"
                  aria-selected={on}
                  className={"w-tab" + (on ? " on" : "") + attn + (dragView?.key === e.key ? " dragging" : "") + (dragView?.before === e.key ? " drop-before" : "") + (dragView?.after === e.key ? " drop-after" : "")}
                  data-tab-key={e.key}
                  style={dragView?.key === e.key ? { transform: `translateX(${dragView.dx}px)` } : undefined}
                  title={label}
                  onClick={() => (e.kind === "chat" ? requestOpenChat(e.chat.chatId) : on && canRename ? startRename(e) : select(e.tab.ptyId))}
                  onDoubleClick={e.kind === "pty" ? () => canRename && startRename(e) : undefined}
                  {...pressProps(e)}
                >
                  {status === "busy" && <TabSweep />}
                  {ico}
                  <span className="w-tab-label">{label}</span>
                  {canCloseEntry(e) && (
                    <span
                      role="button"
                      className="w-tab-x"
                      aria-label={e.kind === "pty" ? t("closeTerminal") : t("chatCloseTab")}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        closeEntry(e);
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
          {pending && (
            <div className={"w-tab is-pending" + (pending.failed ? " is-failed" : "")} role="status">
              <span className="w-tab-ico">{pending.failed ? <TerminalIcon /> : <span className="pend-spinner" aria-hidden="true" />}</span>
              <span className="w-tab-label">{pending.failed ? t("openTimeout") : t("opening", { name: pending.label })}</span>
            </div>
          )}
          {docs.map((d) => {
            const on = doc === d.id;
            const base = d.kind === "settings" || d.kind === "newtab" ? "" : (d.path.split(/[\/]/).pop() ?? d.path);
            const label = d.kind === "settings" ? t("navSettings") : d.kind === "newtab" ? t("newTabTitle") : d.kind === "diff" ? t("wsDiffLabel", { name: base }) : base;
            return (
              <button key={d.id} type="button" role="tab" aria-selected={on} className={"w-tab" + (on ? " on" : "")} title={d.kind === "settings" || d.kind === "newtab" ? undefined : d.path} onClick={() => setDoc(d.id)}>
                <span className="w-tab-ico">{d.kind === "settings" ? <SlidersIcon /> : d.kind === "newtab" ? <PlusIcon /> : <FileIcon />}</span>
                <span className="w-tab-label">{label}</span>
                <span
                  role="button"
                  className="w-tab-x"
                  aria-label={t("closeTab")}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeDoc(d.id);
                  }}
                >
                  ×
                </span>
              </button>
            );
          })}
          <button type="button" className="w-ib" aria-label={t("newTerminal")} onClick={openNewTab}>
            <PlusIcon />
          </button>
        </div>
        <div className="w-group">
          <button type="button" className="w-ib" aria-label={t("showAgents")} aria-pressed={agentsOpen} onClick={toggleAgents}>
            <AgentsIcon />
          </button>
          {active &&
            actions.map((a) => (
              <WideUsageAction key={a.id} action={a} onRun={() => runAction(active.ptyId, a)} />
            ))}
        </div>
        <div className="w-group">
          <button type="button" className="w-ib" aria-label={t("features")} disabled={!active} onClick={() => setActionsOpen(true)}>
            <GridIcon />
          </button>
          <div className="w-anchor">
            <button type="button" className="w-ib" aria-label={t("moreOptions")} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <KebabIcon />
            </button>
            <WideMenu
              open={menuOpen}
              keys={keys}
              noTerminal={!active}
              pinned={panelMode === "fixed"}
              scale={uiScale}
              onScale={setUiScale}
              theme={settings ? effectivePhone(settings, localTheme).theme : (localTheme.theme ?? "auto")}
              onTheme={(v) => setPhoneTheme(localTheme.enabled ? { theme: v } : { enabled: true, theme: v }, settings)}
              onClose={closeMenu}
              onNewTerminal={() => {
                setMenuOpen(false);
                openNewTab();
              }}
              onKeys={() => {
                setMenuOpen(false);
                setKeys((v) => !v);
              }}
              onBrowser={
                canBrowse
                  ? () => {
                      setMenuOpen(false);
                      openBrowser();
                    }
                  : undefined
              }
              onPanels={() => {
                setMenuOpen(false);
                setPanelMode(panelMode === "fixed" ? "auto" : "fixed");
              }}
              onInterrupt={() => {
                setMenuOpen(false);
                if (active) interrupt(active.ptyId);
              }}
              onComputers={() => {
                setMenuOpen(false);
                setComputersOpen(true);
              }}
              onSettings={() => {
                setMenuOpen(false);
                openDoc({ id: "settings", kind: "settings" });
              }}
              onChangelog={() => {
                setMenuOpen(false);
                setChangelogOpen(true);
              }}
            />
          </div>
        </div>
      </header>
      <div className="w-body">
        {/* Kept mounted while closed, so the folder browsed survives closing the panel. */}
        <aside ref={filesPanel} className="w-side w-left" hidden={!filesOpen} style={files.width !== null ? { width: files.width } : undefined}>
          <WideSidebar
            cwd={sideCwd}
            agent={sideAgent}
            activeFile={activeFile}
            onOpenFile={(p) => {
              openFile(p);
              if (!docked) setFilesOpen(false);
            }}
            onOpenDiff={(root, path, staged, status) => {
              openDiff(root, path, staged, status);
              if (!docked) setFilesOpen(false);
            }}
            onOpenTerminal={(p) => void openTerminalAt(p)}
            onOpenChat={onOpenChat}
            onOpenPty={select}
            legacyTab={active}
            onOpenLegacyFile={(p) => {
              if (!active) return;
              openLegacyFile(active.ptyId, p);
              if (!docked) setFilesOpen(false);
            }}
          />
          <div className={"w-resize right" + (files.dragging ? " is-dragging" : "")} role="separator" aria-orientation="vertical" aria-label={t("resizePanel")} data-no-sheet-drag {...files.handleProps} />
        </aside>
        <main className="w-main">
          {shown?.kind === "settings" ? (
            <div className="page w-page">
              <Suspense fallback={null}>
                <SettingsScreen hostName={hostName} settings={settings} />
              </Suspense>
            </div>
          ) : shown?.kind === "newtab" ? (
            <div className="page w-page w-newtab">
              {canChat && <Launcher hostName={hostName} tabs={tabs} onCreate={onCreate} pending={pending} />}
              {pending && (
                <div className={"w-newtab-pending" + (pending.failed ? " is-failed" : "")} role="status">
                  {pending.failed ? t("openTimeout") : t("opening", { name: pending.label })}
                </div>
              )}
              {folders.length > 0 && (
                <section className="w-newtab-recent">
                  <h3>{t("recentFolders")}</h3>
                  {folders.slice(0, 8).map((f) => (
                    <button key={f} type="button" className="w-newtab-folder" title={f} disabled={!!pending && !pending.failed} onClick={() => void openTerminalAt(f)}>
                      <FolderIcon />
                      <span>{shortCwd(f)}</span>
                    </button>
                  ))}
                </section>
              )}
            </div>
          ) : shown?.kind === "file" ? (
            shown.ptyId ? <LegacyFileView key={shown.id} ptyId={shown.ptyId} path={shown.path} cwd={fileTab?.cwd} /> : <WideFileView key={shown.id} path={shown.path} />
          ) : shown?.kind === "diff" ? (
            <WideDiffView key={shown.id} root={shown.root} path={shown.path} staged={shown.staged} status={shown.status} />
          ) : null}
          {/* Stays mounted (hidden) under a settings / file doc, so the stream and scrollback survive. */}
          {active ? (
            <div style={{ display: shown ? "none" : "contents" }}>
              <Suspense fallback={<div className="screen" />}>
                <TerminalScreen key={active.ptyId} tab={active} status={status} onBack={noop} onChat={onChat} embedded keys={keys} onOpenPage={showBrowserPage} />
              </Suspense>
            </div>
          ) : activeChat ? (
            <div style={{ display: shown ? "none" : "contents" }}>
              {clearing?.chatId === activeChat ? (
                <ChatClearing />
              ) : (
                <Suspense fallback={<div className="screen" />}>
                  <ChatScreen key={activeChat} chatId={activeChat} onBack={noop} onTerminal={onTerminal} onOpenChat={onOpenChat} embedded onBrowser={openBrowser} onOpenPage={showBrowserPage} pendingPage={browserPending ? browserPage : null} onOpenPending={openBrowser} onDismissPending={dismissPending} />
                </Suspense>
              )}
            </div>
          ) : !shown && tabs !== null && tabs.length === 0 && !chats?.length ? (
            <div className="empty">{t("noTabs")}</div>
          ) : null}
        </main>
        {docked && browserShown && (
          <aside className="w-side w-right w-browser" style={{ width: browserSide.width ?? 420 }}>
            <Browser docked ptyId={active?.ptyId ?? null} chatId={browserChatId} linksChatId={linksChatId} initialPage={browserPage} onClose={closeBrowser} />
            <div className={"w-resize left" + (browserSide.dragging ? " is-dragging" : "")} role="separator" aria-orientation="vertical" aria-label={t("resizePanel")} data-no-sheet-drag {...browserSide.handleProps} />
          </aside>
        )}
        {agentsOpen && (
          <aside ref={agentsPanel} className="w-side w-right" style={agents.width !== null ? { width: agents.width } : undefined}>
            <div className="w-ph">
              <span className="w-ph-title">{front ? t("agentPanel") : t("activeAgents")}</span>
              <button type="button" className="w-ib sm" aria-label={t("newTerminal")} onClick={openSheet}>
                <PlusIcon />
              </button>
              <button type="button" className="w-ib sm" aria-label={t("closePanel")} onClick={() => setAgentsOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <div className={"w-scroll" + (front ? " w-scroll-insight" : "")}>
              {front ? (
                <AgentInsight ptyId={frontChat ? undefined : active?.ptyId} chatId={frontChat ?? undefined} open={agentsOpen} onOpenChat={onOpenChat} />
              ) : (
                <AgentsScreen
                  tabs={tabs}
                  activePty={doc === null ? activePty : null}
                  activeChat={doc === null ? activeChat : null}
                  onOpen={(id) => {
                    select(id);
                    if (!docked) setAgentsOpen(false);
                  }}
                />
              )}
            </div>
            <div className={"w-resize left" + (agents.dragging ? " is-dragging" : "")} role="separator" aria-orientation="vertical" aria-label={t("resizePanel")} data-no-sheet-drag {...agents.handleProps} />
          </aside>
        )}
      </div>
      {!docked && browserShown && <Browser ptyId={active?.ptyId ?? null} chatId={browserChatId} linksChatId={linksChatId} initialPage={browserPage} onClose={closeBrowser} />}
      {!docked && (agentsOpen || filesOpen) && <div className="w-scrim" onClick={closeDrawers} />}
      {active && <TermActions tab={active} actions={actions} open={actionsOpen} onClose={closeActions} />}
      {tabMenu && (
        <>
          <div
            className="w-menu-scrim"
            onClick={closeTabMenu}
            onContextMenu={(ev) => {
              ev.preventDefault();
              closeTabMenu();
            }}
          />
          <div className="w-menu w-tab-menu" role="menu" style={{ left: tabMenu.left, top: tabMenu.top }}>
            {menuEntry && canRenameEntry(menuEntry) && (
              <div className="w-menu-entry">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeTabMenu();
                    startRename(menuEntry);
                  }}
                >
                  {t("rename")}
                </button>
              </div>
            )}
            {menuEntry && canDuplicateEntry(menuEntry) && (
              <div className="w-menu-entry">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeTabMenu();
                    send({ t: "tabop", target: tabTarget(menuEntry), op: { kind: "duplicate" } });
                  }}
                >
                  {t("tabDuplicate")}
                </button>
              </div>
            )}
            {menuEntry && menuEntry.kind === "pty" && canNotifyEntry(menuEntry) && (
              <div className="w-menu-entry">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeTabMenu();
                    send({ t: "tabop", target: tabTarget(menuEntry), op: { kind: "notify", on: menuEntry.tab.notify === false } });
                  }}
                >
                  {t("tabNotifications")}
                  <span className="w-menu-k">{menuEntry.tab.notify === false ? t("tabNotifyOff") : t("tabNotifyOn")}</span>
                </button>
              </div>
            )}
            {menuEntry && canCloseEntry(menuEntry) && (
              <div className="w-menu-entry">
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    closeTabMenu();
                    closeEntry(menuEntry);
                  }}
                >
                  {t("closeTab")}
                </button>
              </div>
            )}
          </div>
        </>
      )}
      <WideChangelog open={changelogOpen} onClose={() => setChangelogOpen(false)} />
      <NewTerminalSheet open={sheet} folders={folders} onClose={() => setSheet(false)} onCreate={onCreate} />
    </div>
  );
}
