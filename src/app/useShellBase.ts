import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { setBrowserFocusTab, useBrowser } from "../browser/browserStore";
import type { PromptAnchor, TerminalHandle, TerminalTransfer } from "../terminal/Terminal";
import { LOCAL_HOST, remoteCallTabId, useActiveHost, useHosts, useHostState } from "../remoteHosts/remoteHosts";
import type { EditorHandle } from "../editor/EditorView";
import type { AppTab, ChatTab, TermTab } from "../tabs/types";
import { useTheme } from "../themes/ThemeContext";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { useAutoResumeSettings } from "../agents/autoResumeSettings";
import { setCallFocusTab } from "../calls/callStore";
import { useNotificationSettings } from "../notifications/notificationSettings";
import { useAgentSessions } from "../agents/agentSessions";
import { useOpenContextMenu, useContextMenu } from "../context-menu/ContextMenuContext";
import { useConfirmChoice, useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { useSettingsSection } from "../settings/SettingsSectionContext";
import { moveShortcut, useQuickActionReorder } from "../plugins/useQuickActionReorder";
import { usePluginHost } from "../plugins/usePluginHost";
import type { PluginDef } from "../plugins/types";
import { useResizablePanelWidth } from "../hooks/useResizablePanelWidth";
import type { SidebarMode, ExplorerLinkMode } from "../settings/modes";
import { usePersistentState, writeBool, writeJson, writeString } from "../lib/storage";
import { useI18n } from "../i18n";
import { resolveNewTabLayout } from "../newtab/layouts";
import { useNewTabSettings } from "../newtab/newTabSettings";
import { useProfiles } from "../profiles/profiles";
import { useStartPath } from "./useStartPath";
import type { PanelKey } from "./panelLayout";
import { usePerTabPanels } from "./usePerTabPanels";
import { useWindowChrome } from "../window/useWindowChrome";
import { isDialogTab, listedTabs, makeTermTab, patchTermTab } from "../tabs/tabState";
import type { DelegateInfo } from "../chat/chatModel";
import { SIDEBAR_MODE_KEY, EXPLORER_LINK_MODE_KEY, QUICK_ACTIONS_KEY, FAVORITES_BUTTON_VISIBLE_KEY, SIDEBAR_COLLAPSED_KEY, readQuickActions, readTrue, readFalse, readSidebarMode, readLinkMode } from "./appPrefs";
import type { Handoff, ChatCallbacks } from "./types";

/** The window shell's own state: persisted toggles, panel sizes, the tabs, and the per-tab bookkeeping
 * kept outside `tabs` (refs). Everything else in the shell reads it through `ShellCtx`. */
export function useShellBase() {
  // All persisted across restarts - every toggle path (header button,
  // shortcut, floating backdrop, the Agent action, Settings...) goes
  // through these setters, so persisting in one place covers all of them.
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentState(SIDEBAR_COLLAPSED_KEY, readFalse, writeBool);
  const [shortcutsDialogOpen, setShortcutsDialogOpen] = useState(false);
  const { setSection: setSettingsSection } = useSettingsSection();
  const [sidebarMode, setSidebarMode] = usePersistentState<SidebarMode>(SIDEBAR_MODE_KEY, readSidebarMode, writeString);
  const [explorerLinkMode, setExplorerLinkMode] = usePersistentState<ExplorerLinkMode>(
    EXPLORER_LINK_MODE_KEY,
    readLinkMode,
    writeString,
  );
  const [quickActionIds, setQuickActionIds] = usePersistentState<string[]>(QUICK_ACTIONS_KEY, readQuickActions, writeJson);
  const quickActionReorder = useQuickActionReorder(quickActionIds, (id, target) =>
    setQuickActionIds((previous) => moveShortcut(previous, id, target)),
  );
  const [favoritesButtonVisible, setFavoritesButtonVisible] = usePersistentState(
    FAVORITES_BUTTON_VISIBLE_KEY,
    readTrue,
    writeBool,
  );
  // What the panel layout last decided, for the drag handles to clamp against (see usePanelLayout).
  const layoutLiveRef = useRef<{ maxWidth: Partial<Record<PanelKey, number>>; shown: Partial<Record<PanelKey, number>> }>({
    maxWidth: {},
    shown: {},
  });
  const appBodyRef = useRef<HTMLDivElement>(null);
  const sidebarPanelRef = useRef<HTMLDivElement>(null);
  const browserPanelRef = useRef<HTMLDivElement>(null);
  const sidebarResize = useResizablePanelWidth({
    storageKey: "flowcode.sidebarWidth",
    defaultWidth: 240,
    min: 180,
    max: 480,
    handleSide: "right",
    getMax: () => layoutLiveRef.current.maxWidth.sidebar ?? Infinity,
    getCurrent: () => layoutLiveRef.current.shown.sidebar,
    panelRef: sidebarPanelRef,
  });
  const browserResize = useResizablePanelWidth({
    storageKey: "flowcode.browserWidth",
    defaultWidth: 480,
    min: 320,
    // The layout caps it to what leaves the center its minimum.
    max: 4000,
    handleSide: "left",
    getMax: () => layoutLiveRef.current.maxWidth.browser ?? Infinity,
    getCurrent: () => layoutLiveRef.current.shown.browser,
    panelRef: browserPanelRef,
  });
  const { open: browserOpen } = useBrowser();
  const [homeDir, setHomeDir] = useState<string>("");
  const [tabs, setTabs] = useState<AppTab[]>([makeTermTab("tab-0", "")]);
  const [activeTabId, setActiveTabId] = useState("tab-0");
  const [activeTerminalId, setActiveTerminalId] = useState("tab-0");
  const latestRef = useRef({ tabs, activeTabId, activeTerminalId });
  // What the periodic session save looks at: tabs or the active tab changed,
  // or a busy/command-line event, since the last save (see `persist`).
  const sessionDirtyRef = useRef(true);
  if (latestRef.current.tabs !== tabs || latestRef.current.activeTabId !== activeTabId) sessionDirtyRef.current = true;
  latestRef.current = { tabs, activeTabId, activeTerminalId };
  const { restoreRef: panelRestoreRef, forget: forgetTabPanels } = usePerTabPanels(
    activeTabId,
    { sidebarCollapsed, browserOpen },
    setSidebarCollapsed,
  );
  // The tab on screen, for pages opened on behalf of another tab (see browserStore).
  useLayoutEffect(() => setBrowserFocusTab(activeTabId), [activeTabId]);
  // The tab strip, the shortcuts and the phone's list leave out the new tab dialog.
  const stripTabs = useMemo(() => listedTabs(tabs), [tabs]);
  const [{ layout: newTabLayoutId }] = useNewTabSettings();
  const dialogTabId = tabs.find(isDialogTab)?.id;
  const dialogLayout = resolveNewTabLayout(newTabLayoutId).dialog;
  // The layout was switched (from the dialog's own customize panel) to one that
  // is a page: the draft becomes the tab it would have been.
  useEffect(() => {
    if (!dialogTabId || dialogLayout) return;
    setTabs((prev) => patchTermTab(prev, dialogTabId, { dialog: undefined }));
    setActiveTabId(dialogTabId);
    setActiveTerminalId(dialogTabId);
  }, [dialogTabId, dialogLayout]);
  const { isMaximized, isEdgeFlush, isFullscreen, toggleFullscreen } = useWindowChrome();
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(() => new Set());
  const [pluginMenuAnchor, setPluginMenuAnchor] = useState<DOMRect | null>(null);
  const showPluginToastRef = useRef<(message: string) => void>(() => {});
  const termRefs = useRef(new Map<string, TerminalHandle>());
  // Command to type into a tab the instant its shell is ready - set by
  // openTerminalWithCommand, read once by that tab's own TerminalView via
  // its runOnStart prop (see the render loop below).
  const pendingCommandsRef = useRef(new Map<string, string>());
  // A one-off shell override for a tab about to be created (the "+" button's
  // own context menu picking a specific shell, e.g. WSL, instead of the
  // configured default) - read once by that tab's TerminalView via its
  // shellOverride prop (see the render loop below), same lifecycle as
  // pendingCommandsRef above.
  const pendingShellOverrideRef = useRef(new Map<string, string>());
  // A command to leave typed (not run) on a tab's first prompt - a recent
  // terminal reopened from the new tab page. Same lifecycle as the two above.
  const pendingTypedCommandsRef = useRef(new Map<string, string>());
  // Tabs whose start folder is still being looked up - see `fillStartDir`.
  const startDirPendingRef = useRef(new Set<string>());
  // The shell last picked on each new tab page - see `previewNewTabShell`.
  const newTabShellRef = useRef(new Map<string, string>());
  // Tabs whose profile was chosen on purpose (a menu row, the new tab page's
  // chips, a duplicate, an agent launch...): the automatic pick - the folder's
  // project default, else the profile of the tab that was active - never
  // overwrites them. See `addTab` / `fillStartDir`.
  const explicitProfileRef = useRef(new Set<string>());
  // The profile of the tab that was active when a tab was created: what an
  // automatic tab falls back to when its folder has no project default.
  const inheritedProfileRef = useRef(new Map<string, string | undefined>());
  const [profilePickerOpen, setProfilePickerOpen] = useState(false);
  const { profiles } = useProfiles();
  const editorRefs = useRef(new Map<string, EditorHandle>());
  // A terminal session moved here from another window, keyed by its new tab
  // id - handed to that tab's TerminalView once, at mount (its `attach`).
  const pendingAttachRef = useRef(new Map<string, TerminalTransfer>());
  // Same for an editor tab moved here with unsaved edits.
  const pendingEditorContentRef = useRef(new Map<string, string>());
  const pluginBtnRef = useRef<HTMLButtonElement>(null);
  const confirm = useConfirmDialog();
  const chooseClose = useConfirmChoice();
  const { t } = useI18n();
  const openMenu = useOpenContextMenu();
  const activeHost = useActiveHost();
  // The tab on screen decides which calls need no bubble: this PC's tab, or the one of the PC in front.
  const remoteActiveKey = useHostState(activeHost).activeKey;
  useLayoutEffect(
    () => setCallFocusTab(activeHost === LOCAL_HOST ? activeTabId : remoteActiveKey ? remoteCallTabId(activeHost, remoteActiveKey) : null),
    [activeHost, activeTabId, remoteActiveKey],
  );
  // No PC paired yet: the header has no PC selector, so pairing is in the "more options" menu.
  const noPairedHosts = useHosts().length === 0;
  const [pairingHost, setPairingHost] = useState(false);
  const { hide: hideMenu } = useContextMenu();
  const { mode, toggleTheme, setMode } = useTheme();
  const notificationSettings = useNotificationSettings();
  const autoResumeEnabled = useAutoResumeSettings().enabled;
  const { sessions: agentSessions } = useAgentSessions(
    Object.values(notificationSettings).some(Boolean) || autoResumeEnabled,
  );
  const {
    startPath,
    shellStartPaths,
    resetTabZoom,
    zoomTabIn,
    zoomTabOut,
    restoreSession,
    restoreContent,
    shellId,
    newTabPage,
    tabFontSizeOverrides,
    setTabFontSize,
    getTabFontSize,
  } = useTerminalSettings();
  // Tabs whose new tab page is still fading out over the terminal that just
  // replaced it (see NewTabPage's `onLaunch`/`onDone`).
  // The value is whether that tab's terminal has reported ready.
  const [handoffs, setHandoffs] = useState<Map<string, Handoff>>(() => new Map());
  const patchHandoff = (tabId: string, patch: Handoff) =>
    setHandoffs((prev) => (prev.has(tabId) ? new Map(prev).set(tabId, { ...prev.get(tabId), ...patch }) : prev));
  const restoreSessionRef = useRef(restoreSession);
  restoreSessionRef.current = restoreSession;
  const restoreContentRef = useRef(restoreContent);
  restoreContentRef.current = restoreContent;
  // Previous session's terminal text, keyed by the restored tab's new id -
  // handed to its TerminalView once, at mount (see `restoredContent`).
  const restoredContentRef = useRef(new Map<string, string>());
  // Terminal tabs brought back from the previous session - an untouched one
  // is still worth keeping (it has history), unlike a virgin fresh tab.
  const restoredTabIdsRef = useRef(new Set<string>());
  // Nothing may spawn, and nothing may be saved, until the previous session
  // has been read back (or skipped) - otherwise the startup tab would start
  // a shell that's about to be replaced, and the first save would overwrite
  // the file before it was ever read.
  const [sessionChecked, setSessionChecked] = useState(false);

  const { allPlugins, pluginToast, pluginDialog, setPluginDialog, showPluginToast, seedExamplePlugins, reloadCustomPlugins, addPlugin, deletePlugin } =
    usePluginHost(setQuickActionIds, pinToQuickActions);

  function toggleQuickAction(id: string) {
    setQuickActionIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function pinToQuickActions(ids: string[]) {
    if (ids.length === 0) return;
    setQuickActionIds((prev) => [...prev, ...ids.filter((id) => !prev.includes(id))]);
  }

  useEffect(() => {
    invoke<string>("home_dir")
      .then(setHomeDir)
      .catch(() => setHomeDir("/"));
  }, []);

  const { resolvedStartPath, startPathChecked } = useStartPath(startPath);

  /** Per chat pane, the stable callbacks handed to its memoized view (see `stableChatCallbacks`). */
  const chatCallbacksRef = useRef(new Map<string, { latest: ChatCallbacks; stable: ChatCallbacks }>());
  /** How to end each chat tab's agent (see AgentSessionView `onCloser`), so a terminal resuming its session starts only once it is gone. */
  const chatClosersRef = useRef(new Map<string, { close: () => Promise<void>; restart: () => void; clear: () => void; compact: () => void }>());
  const switchingChatsRef = useRef(new Set<string>());
  const runPluginRef = useRef<(plugin: PluginDef) => void>(() => {});
  const allPluginsRef = useRef<PluginDef[]>([]);
  /** Sessions being resumed right now (`cli:sessionId`): a second click meanwhile must not open a second tab. */
  const resumingRef = useRef(new Set<string>());
  const reservedIdsRef = useRef(new Map<string, string>());
  // Bumped when a terminal learns its pty id: the tab-to-agent match and the
  // tab report both depend on it, and neither is otherwise re-run for it.
  const [ptyVersion, setPtyVersion] = useState(0);
  const termCallbacksRef = useRef(
    new Map<
      string,
      {
        ref: (handle: TerminalHandle | null) => void;
        onTitleChange: (title: string) => void;
        onBusyChange: (busy: boolean) => void;
        onCommandLine: (line: string) => void;
        interceptCommandLine: (line: string) => boolean;
        onAnchor: (anchor: PromptAnchor) => void;
        onPromptShown: (anchor: PromptAnchor | null) => void;
        onPtyReady: () => void;
        onOpenDelegate: (delegate: DelegateInfo, wslDistro: string | null) => void;
      }
    >(),
  );
  // A phone's quick action waits here for its tab to become the active one,
  // then runs against that render's state.
  const pendingRemoteRunRef = useRef<{ tabId: string; plugin: PluginDef } | null>(null);
  showPluginToastRef.current = showPluginToast;
  allPluginsRef.current = allPlugins;
  const activeTerminal = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
  // A chat in front wins over the last terminal, like in useActiveAgentSync.
  const frontChat = tabs.find((t): t is ChatTab => t.id === activeTabId && t.kind === "chat");
  const frontTab = tabs.find((t) => t.id === activeTabId);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  return {
    sidebarCollapsed, setSidebarCollapsed, shortcutsDialogOpen, setShortcutsDialogOpen, setSettingsSection,
    sidebarMode, setSidebarMode, explorerLinkMode, setExplorerLinkMode, quickActionIds, quickActionReorder,
    favoritesButtonVisible, setFavoritesButtonVisible, layoutLiveRef, appBodyRef, sidebarPanelRef, browserPanelRef,
    sidebarResize, browserResize, browserOpen, homeDir, tabs, setTabs, activeTabId, setActiveTabId,
    activeTerminalId, setActiveTerminalId, latestRef, sessionDirtyRef, panelRestoreRef, forgetTabPanels, stripTabs,
    newTabLayoutId, isMaximized, isEdgeFlush, isFullscreen, toggleFullscreen, dirtyIds, setDirtyIds,
    pluginMenuAnchor, setPluginMenuAnchor, showPluginToastRef, termRefs, pendingCommandsRef,
    pendingShellOverrideRef, pendingTypedCommandsRef, startDirPendingRef, newTabShellRef, explicitProfileRef,
    inheritedProfileRef, profilePickerOpen, setProfilePickerOpen, profiles, editorRefs, pendingAttachRef,
    pendingEditorContentRef, pluginBtnRef, confirm, chooseClose, t, openMenu, activeHost, noPairedHosts,
    pairingHost, setPairingHost, hideMenu, mode, toggleTheme, setMode, agentSessions, shellStartPaths,
    resetTabZoom, zoomTabIn, zoomTabOut, restoreContent, shellId, newTabPage, tabFontSizeOverrides, setTabFontSize,
    getTabFontSize, handoffs, setHandoffs, patchHandoff, restoreSessionRef, restoreContentRef, restoredContentRef,
    restoredTabIdsRef, sessionChecked, setSessionChecked, allPlugins, pluginToast, pluginDialog, setPluginDialog,
    showPluginToast, seedExamplePlugins, reloadCustomPlugins, addPlugin, deletePlugin, toggleQuickAction,
    resolvedStartPath, startPathChecked, chatCallbacksRef, chatClosersRef, switchingChatsRef, runPluginRef,
    allPluginsRef, resumingRef, reservedIdsRef, ptyVersion, setPtyVersion, termCallbacksRef, pendingRemoteRunRef,
    activeTerminal, frontChat, frontTab, activeTab,
  };
}
