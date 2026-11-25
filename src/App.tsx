import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { Sidebar, useSidebarTab } from "./sidebar/Sidebar";
import { isLikelyTextFile } from "./sidebar/fileIcons";
import { AgentInsightPanel } from "./agents/AgentInsightPanel";
import {
  AgentPanelHostContext,
  setAgentPanelPinned,
  setAgentPopoverOpen,
  toggleAgentPopover,
  useAgentPanelPinned,
  useAgentPopoverOpen,
  type AgentPanelHost,
} from "./agents/agentPanelState";
import { forgetBrowserTab, openFileInPreview, setBrowserFocusTab, setBrowserOpen, useBrowser } from "./browser/browserStore";
import { AgentHistoryPanel } from "./agents/AgentHistoryPanel";
import { TerminalView, type PromptAnchor, type TerminalHandle, type TerminalTransfer } from "./terminal/Terminal";
import { TabStrip } from "./terminal/TabStrip";
import { HostSelector, MonitorIcon, openHostMenu } from "./remoteHosts/HostSelector";
import { PairHostDialog } from "./remoteHosts/PairHostDialog";
import { CrashReportDialog } from "./crash/CrashReportDialog";
import { useDiagnosisTabEvents, type ChatDiagnosis } from "./crash/diagnosis";
import { useBrowserDiagnosisEvents } from "./browser/browserDiagnosis";
import { useBrowserControlBridge } from "./browser/control";
import { isSafeSessionId } from "./agents/sessionId";
import { RemoteTabStrip } from "./remoteHosts/RemoteTabStrip";
import { RemoteSidebar } from "./remoteHosts/RemoteSidebar";
import { frontRemoteTerminal, LOCAL_HOST, onRemoteNotice, parseRemoteCallTab, remoteCallTabId, remoteShortcuts, selectRemoteKey, setActiveHost, useActiveHost, useHosts, useHostState } from "./remoteHosts/remoteHosts";
import { lastSubmitAt } from "./terminal/ptyClient";
import type { EditorHandle } from "./editor/EditorView";
import { SymbolOutline } from "./editor/SymbolOutline";
import type { AppTab, ChatPane, ChatTab, TermTab, EditorTab } from "./tabs/types";
import type { GitChange } from "./git/gitStatus";
import { loadPluginViews } from "./agentViews/pluginViews";
import { defaultAgentView, defaultOpensChat } from "./agentViews/defaultView";
import { ThemeProvider, useTheme, type ThemeMode } from "./themes/ThemeContext";
import { getConfiguredShell, shellStartKey, TerminalSettingsProvider, useTerminalSettings } from "./terminal/TerminalSettingsContext";
import { loadSession, type SavedWindow } from "./session/session";
import { useWindowSession } from "./session/useWindowSession";
import { prepareEditorClose } from "./editor/closeEditors";
import { UpdateProvider } from "./update/UpdateContext";
import {
  defaultWslDistro,
  resolveWslStartDir,
  sameShell,
  toWindowsPath,
  toWslPath,
  wslDistroOfPath,
  wslDistroOfShell,
  wslShellId,
} from "./terminal/wslPath";
import { useAutoResume } from "./agents/useAutoResume";
import { useAutoResumeSettings } from "./agents/autoResumeSettings";
import { CallBubble } from "./calls/CallBubble";
import { setCallFocusTab } from "./calls/callStore";
import { useAgentStateCalls } from "./calls/useAgentStateCalls";
import { useAgentNotifications } from "./notifications/useAgentNotifications";
import { watchLimitResets } from "./notifications/limitResetWatcher";
import { isPhoneAction, PROFILE_CLI, publishRemoteActions } from "./plugins/remotePublish";
import { useRemoteLeader } from "./remote/leader";
import { useNotificationSettings } from "./notifications/notificationSettings";
import { tabAgentOf, useAgentSessions, type AgentSession, type TabAgent } from "./agents/agentSessions";
import { cliInstallCommand } from "./cli/cliInstallCommands";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { ContextMenuProvider, useOpenContextMenu, useContextMenu, type ContextMenuItem } from "./context-menu/ContextMenuContext";
import { ConfirmDialogProvider, useConfirmChoice, useConfirmDialog } from "./dialog/ConfirmDialogContext";
import { FileLinkActionsContext, FileLinkCwdContext, type FileLinkActions } from "./lib/fileLinks";
import { ChangelogNav, ChangelogPage, ChangelogProvider, WhatsNewPage } from "./changelog/ChangelogPage";
import { consumeUpdatedVersion } from "./changelog/lastRunVersion";
import { SettingsNav } from "./settings/SettingsNav";
import { SettingsSectionProvider, useSettingsSection } from "./settings/SettingsSectionContext";
import { RemoteSettingsBridge } from "./remote/RemoteSettingsBridge";
import { RemoteBrowserBridge } from "./remote/RemoteBrowserBridge";
import { RemoteUpdateBridge } from "./remote/RemoteUpdateBridge";
import { RemotePairConfirm } from "./remote/RemotePairConfirm";
import { ShortcutsProvider } from "./shortcuts/ShortcutsContext";
import { MenuIcons } from "./context-menu/menuIcons";
import { ShortcutsDialog } from "./shortcuts/ShortcutsDialog";
import { PluginMenu } from "./plugins/PluginMenu";
import { PluginUsageButton } from "./plugins/PluginUsageButton";
import { moveShortcut, useQuickActionReorder } from "./plugins/useQuickActionReorder";
import { PluginToast } from "./plugins/PluginToast";
import { PluginDialog } from "./plugins/PluginDialog";
import { usePluginHost } from "./plugins/usePluginHost";
import { examplePlugins } from "./plugins/registry";
import { pluginIconNode } from "./plugins/icons";
import type { PluginDef, PluginButtonDef } from "./plugins/types";
import { FavoritesButton, StarIcon, favoritesMenuItem } from "./favorites/FavoritesButton";
import type { FavoriteFolder } from "./favorites/favoritesStore";
import { hasSeenWelcome } from "./welcome/welcomeSeen";
import { useResizablePanelWidth } from "./hooks/useResizablePanelWidth";
import { type SidebarMode, type ExplorerLinkMode } from "./settings/modes";
import { readJson, removeKey, usePersistentState, writeBool, writeJson, writeString } from "./lib/storage";
import { basename, isWindowsPlatform } from "./lib/path";
import { withCodexLaunchFlags } from "./plugins/codexLaunch";
import { atShellPrompt, cdCommand, ptyForeground, type Foreground } from "./terminal/shellDialect";
import { useI18n } from "./i18n";
import { NewTabHost } from "./newtab/NewTabHost";
import { resolveNewTabLayout } from "./newtab/layouts";
import { useNewTabSettings } from "./newtab/newTabSettings";
import { loadPluginNewTabs } from "./newtab/pluginLayouts";
import type { NewTabLaunch } from "./newtab/types";
import { recordRecentTerminal } from "./newtab/recentTerminals";
import { recordCommand } from "./newtab/commandHistory";
import { profileForPath, useProfiles } from "./profiles/profiles";
import { ProfilePicker } from "./profiles/ProfilePicker";
import { ProviderAuthHost } from "./profiles/ProviderAuthHost";
import { openProviderAuth } from "./profiles/providerAuth";
import { activeTabProfile } from "./profiles/activeTabProfile";
import { Icons } from "./app/icons";
import { useStartPath } from "./app/useStartPath";
import { useCliLoginEvent } from "./app/useCliLoginEvent";
import { useRemoteWindowEvents, type RemoteTabOp } from "./app/useRemoteWindowEvents";
import { useReportTabs } from "./app/useReportTabs";
import { useActiveAgentSync } from "./app/useActiveAgentSync";
import { useUsageWatch } from "./app/useUsageWatch";
import { usePanelLayout } from "./app/usePanelLayout";
import type { PanelKey } from "./app/panelLayout";
import { usePerTabPanels } from "./app/usePerTabPanels";
import { useWindowChrome } from "./window/useWindowChrome";
import { useActiveAgent } from "./agents/activeAgent";
import { useGitChangeCount } from "./git/useGitChangeCount";
import { ZoomRow } from "./terminal/ZoomRow";
import {
  cmdTitlePathCandidates,
  firstExistingDir,
  labelForCwd,
} from "./terminal/tabTitle";
import { takeWindowInit, packTabTransfer, tabStripDropIndex, type CursorTarget, type TabTransfer } from "./tabs/transfer";
import { resolveTitle } from "./terminal/titleResolver";
import { newChatPane as newChatPaneIn, patchChatPane as patchChatPaneIn, patchChatTab as patchChatTabIn, showChatSession as showChatSessionIn } from "./tabs/chatPanes";
import { newTabId } from "./tabs/tabId";
import { isDialogTab, listedTabs, makeTermTab, patchTermTab } from "./tabs/tabState";
import "./App.css";
import { AGENT_CLIS, CLI_INFO, cliOfPlugin, type AgentCli } from "./agents/cliInfo";
import type { DelegateInfo } from "./chat/chatModel";
import { staleDelegateTabs, useAllTabDelegations } from "./chat/delegateStore";
import { startRemotePrefsSync } from "./chat/dictationModels";

const appWindow = getCurrentWindow();
/** The window Flowcode starts with - the one that restores the saved session
 * and checks for updates. Every other window was opened from it (a tab
 * dragged out, or a restored extra window). */
const isMainWindow = appWindow.label === "main";

/** What a terminal reports to the New Tab page turning into it: where its
 * prompt will land, and (`null`: never) where it did. */
/** The tab whose agent delegated a task: what a delegate's own tab needs from it (a terminal tab has no agent or profile of its own here). */
interface DelegateParent {
  id: string;
  cwd: string;
  shell?: string;
  profileId?: string;
  agent: AgentCli | null;
}

interface Handoff {
  anchor?: PromptAnchor;
  promptShown?: PromptAnchor | null;
}

// Loaded on demand: CodeMirror (every language grammar) and the flowkit
// onboarding flow are the bulk of the bundle, and plenty of sessions never
// open a file - the welcome flow only ever shows on first launch.
const DiffView = lazy(() => import("./git/DiffView").then((m) => ({ default: m.DiffView })));
const TerminalAgentHeader = lazy(() => import("./agentViews/TerminalAgentHeader").then((m) => ({ default: m.TerminalAgentHeader })));
const AgentSessionView = lazy(() => import("./agentViews/AgentSessionView").then((m) => ({ default: m.AgentSessionView })));
const EditorView = lazy(() => import("./editor/EditorView").then((m) => ({ default: m.EditorView })));
const SettingsPage = lazy(() => import("./settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const RemoteWorkspace = lazy(() => import("./remoteHosts/RemoteWorkspace").then((m) => ({ default: m.RemoteWorkspace })));
const BrowserPanel = lazy(() => import("./browser/BrowserPanel").then((m) => ({ default: m.BrowserPanel })));
const WelcomeFlow = lazy(() => import("./welcome/WelcomeFlow").then((m) => ({ default: m.WelcomeFlow })));

import {
  SIDEBAR_MODE_KEY,
  EXPLORER_LINK_MODE_KEY,
  QUICK_ACTIONS_KEY,
  PLUGIN_APPROVALS_KEY,
  FAVORITES_BUTTON_VISIBLE_KEY,
  SIDEBAR_COLLAPSED_KEY,
  isStringArray,
  commandStamp,
  readQuickActions,
  readTrue,
  readFalse,
  readSidebarMode,
  readLinkMode,
} from "./app/appPrefs";

/** `tabs` with `tab` inserted at strip index `at` (the end when absent or out of range). */
function insertTabAt(tabs: AppTab[], tab: AppTab, at?: number): AppTab[] {
  if (at === undefined || at < 0 || at >= tabs.length) return [...tabs, tab];
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

function Shell() {
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
  const sidebarResize = useResizablePanelWidth({
    storageKey: "flowcode.sidebarWidth",
    defaultWidth: 240,
    min: 180,
    max: 480,
    handleSide: "right",
    getMax: () => layoutLiveRef.current.maxWidth.sidebar ?? Infinity,
    getCurrent: () => layoutLiveRef.current.shown.sidebar,
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

  useEffect(() => {
    let cancelled = false;

    /** Rebuilds one saved window's tabs in this window. */
    async function applySavedWindow(saved: SavedWindow) {
      const restored: AppTab[] = [];
      const settingsLabel = t("settings.title");
      const changelogLabel = t("changelog.title");
      const whatsNewLabel = t("whatsNew.title");
      for (const t of saved.tabs) {
        if (t.kind === "terminal") {
          // A folder deleted since, or a `\\wsl.localhost\...` path a
          // Windows shell can't start in (a WSL one can - pty_spawn turns
          // it into `wsl -d <distro> --cd <path>`): left empty, so the
          // startup-folder fill below gives it the configured start folder
          // instead.
          //
          // A session saved while a command was running in cmd.exe holds
          // its "<cwd> - <command>" title as the cwd (see
          // `cmdTitlePathCandidates`) - the real folder is recovered from
          // it rather than dropping the tab back to the start folder.
          const wslDistro = wslDistroOfShell(t.shell);
          const cwd =
            !!t.cwd && (wslDistro !== undefined || !t.cwd.startsWith("\\\\"))
              ? ((await firstExistingDir(wslDistro !== undefined ? [t.cwd] : cmdTitlePathCandidates(t.cwd))) ?? "")
              : "";
          const id = newTabId("tab");
          restoredTabIdsRef.current.add(id);
          if (t.content && restoreContentRef.current) restoredContentRef.current.set(id, t.content);
          if (t.shell) pendingShellOverrideRef.current.set(id, t.shell);
          restored.push({
            kind: "terminal",
            id,
            cwd,
            explorerPath: cwd,
            label: t.customLabel || !cwd ? t.label : labelForCwd(cwd),
            customLabel: t.customLabel,
            notifyMuted: t.notifyMuted,
            nestedShell: wslDistro !== undefined ? "wsl" : undefined,
            wslDistro: wslDistro ?? undefined,
            profileId: t.profileId,
          });
        } else if (t.kind === "chat") {
          // A folder deleted since can't host the agent: the tab is dropped.
          if (await firstExistingDir([t.cwd])) {
            const keepChat = restoreContentRef.current;
            restored.push({
              kind: "chat",
              id: newTabId("chat"),
              agent: t.agent as AgentCli,
              cwd: t.cwd,
              label: keepChat ? t.label : basename(t.cwd) || CLI_INFO[t.agent as AgentCli].name,
              profileId: t.profileId,
              sessionId: keepChat ? t.sessionId : undefined,
              viewId: t.viewId,
              shell: t.shell,
              // No saved session (or not restoring it): a fresh chat, nothing to resume yet.
              talked: keepChat && t.sessionId ? undefined : false,
              lastActiveAt: keepChat ? t.lastActiveAt : undefined,
            });
          }
        } else if (t.kind === "editor") {
          restored.push({ kind: "editor", id: newTabId("editor"), path: t.path, label: t.label });
        } else if (t.kind === "whatsNew") {
          if (!restored.some((r) => r.kind === "whatsNew")) {
            restored.push({ kind: "whatsNew", id: "whatsnew", label: whatsNewLabel, version: t.version });
          }
        } else if (t.kind === "changelog") {
          if (!restored.some((r) => r.kind === "changelog")) {
            restored.push({ kind: "changelog", id: "changelog", label: changelogLabel });
          }
        } else if (!restored.some((r) => r.kind === "settings")) {
          restored.push({ kind: "settings", id: "settings", label: settingsLabel });
        }
      }
      if (cancelled) return;
      if (restored.length === 0) restored.push(makeTermTab("tab-0", ""));
      const active = restored[Math.min(Math.max(saved.activeIndex, 0), restored.length - 1)];
      setTabs(restored);
      setActiveTabId(active.id);
      setActiveTerminalId(active.kind === "terminal" ? active.id : (restored.find((r) => r.kind === "terminal")?.id ?? ""));
    }

    (async () => {
      const init = await takeWindowInit();
      if (cancelled) return;
      if (init?.kind === "adopt") {
        adoptTabRef.current(init.transfer, true);
      } else if (init?.kind === "restore") {
        await applySavedWindow(init.window);
      } else if (isMainWindow && restoreSessionRef.current) {
        const saved = await loadSession();
        if (saved && !cancelled) {
          await applySavedWindow(saved[0]);
          // Every other saved window reopens as a window of its own, where
          // it was.
          for (const extra of saved.slice(1)) {
            const placement = extra.bounds ? { kind: "bounds", ...extra.bounds } : { kind: "atCursor" };
            invoke("window_open", { init: { kind: "restore", window: extra }, placement }).catch(() => {});
          }
        }
      }
      if (!cancelled) setSessionChecked(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useWindowSession({
    ready: sessionChecked,
    window: appWindow,
    main: isMainWindow,
    dirty: sessionDirtyRef,
    onError: (error) => window.alert(t("app.sessionSaveFailed", { error: String(error) })),
    restore: () => restoreSessionRef.current,
    state: () => ({
      ...latestRef.current,
      restoreContent: restoreContentRef.current,
      dirtyEditors: latestRef.current.tabs.some((tab) => tab.kind === "editor" && (editorRefs.current.get(tab.id)?.isDirty() ?? pendingEditorContentRef.current.has(tab.id))),
      restoredTabIds: restoredTabIdsRef.current,
      terminals: termRefs.current,
      restoredContent: restoredContentRef.current,
      shellOf: tabShell,
    }),
    prepareClose: () => prepareEditorClose(
      () => latestRef.current.tabs.flatMap((tab) => {
        if (tab.kind !== "editor") return [];
        const pending = pendingEditorContentRef.current.get(tab.id);
        const handle = editorRefs.current.get(tab.id) ?? (pending !== undefined ? {
          isDirty: () => true, getContent: () => pending, save: async () => false,
        } : undefined);
        return handle ? [{ id: tab.id, label: tab.label, handle }] : [];
      }),
      async (editor) => {
        const choice = await chooseClose({
          title: t("app.unsaved.title"),
          message: t("app.unsaved.windowMessage", { name: editor.label }),
          confirmLabel: t("app.unsaved.save"),
          alternativeLabel: t("app.unsaved.confirm"),
        });
        return choice === "confirm" ? "save" : choice === "alternative" ? "discard" : "cancel";
      },
    ),
  });

  useEffect(() => {
    if (!homeDir || !startPathChecked || !sessionChecked) return;
    // Every tab still without a folder (the startup one, a restored one
    // whose folder is gone) gets its shell's start folder - see
    // `fillStartDir`.
    for (const t of latestRef.current.tabs) {
      if (t.kind !== "terminal" || t.cwd !== "") continue;
      // A tab that didn't come from `addTab` (restored from the last session)
      // keeps the profile it had, even the default one.
      if (!inheritedProfileRef.current.has(t.id)) explicitProfileRef.current.add(t.id);
      fillStartDir(t.id, pendingShellOverrideRef.current.get(t.id) ?? shellId);
    }
  }, [homeDir, resolvedStartPath, startPathChecked, sessionChecked]);

  useEffect(() => {
    seedExamplePlugins().then(reloadCustomPlugins);
    loadPluginViews().catch(() => {});
    loadPluginNewTabs().catch(() => {});
    // Per-plugin usage profiles used to be remembered here; now they follow
    // the active tab's profile, so the old keys are dead weight.
    try {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("flowcode.usageProfile.")) removeKey(key);
      }
    } catch {
      /* storage unavailable */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const panelLayout = usePanelLayout({
    sidebarMode,
    sidebarCollapsed,
    setSidebarCollapsed,
    browserOpen,
    setBrowserOpen,
    bodyRef: appBodyRef,
    // A chat needs more room than a terminal to stay readable.
    centerMin: tabs.some((t) => t.id === activeTabId && t.kind === "chat") ? 320 : 360,
    panels: {
      sidebar: { width: sidebarResize.width, min: sidebarResize.min },
      browser: { width: browserResize.width, min: browserResize.min },
    },
  });
  const { isNarrow, sidebarPresence, browserPresence, togglePanel, panelPointerDown } = panelLayout;
  layoutLiveRef.current = { maxWidth: panelLayout.maxWidth, shown: panelLayout.shown };
  panelRestoreRef.current = panelLayout.markRestore;

  useCliLoginEvent();
  // The crash dialog's diagnosis chat: opened, shown and closed on its behalf.
  useDiagnosisTabEvents({
    open: (d) => void openChatTab(d.agent, d.cwd, { shell: "host", label: d.label, diagnosis: { reportId: d.reportId, prompt: d.prompt, when: d.when } }).then(d.opened),
    focus: (reportId) => {
      const tab = latestRef.current.tabs.find((t) => t.kind === "chat" && t.diagnosis?.reportId === reportId);
      if (tab) selectTab(tab.id);
    },
    close: (reportId) => {
      const tab = latestRef.current.tabs.find((t) => t.kind === "chat" && t.diagnosis?.reportId === reportId);
      if (tab) void closeTab(tab.id);
    },
  });

  // Agents driving the browser's pages: answers the backend's permission questions for this window's chats and tabs.
  useBrowserControlBridge();
  // The browser's failed-page diagnosis (a chat with the message sent, in the folder of the page's project) and its terminal.
  useBrowserDiagnosisEvents({
    openChat: (d) => {
      const { cwd, shell } = browserHintFolder(d.hintTabId);
      void openChatTab(d.agent, cwd, { shell, label: d.label, firstPrompt: d.prompt, background: true, onCreated: d.onOpened });
    },
    focusTab: (tabId) => {
      if (latestRef.current.tabs.some((t) => t.id === tabId)) selectTab(tabId);
    },
    openTerminal: (d) => {
      const { cwd, shell } = browserHintFolder(d.hintTabId);
      addTab(cwd, shell);
    },
  });

  // A PC in front of the phone-style remote workspace takes the shortcuts.
  const remote = activeHost !== LOCAL_HOST ? activeHost : null;
  // Copy/paste only make sense with a terminal on screen - an editor or
  // input keeps its own native clipboard handling. While another PC is in
  // front the local terminals are hidden: nothing acts on them then.
  const activeTermHandle = () => (!remote && activeTabId === activeTerminalId ? termRefs.current.get(activeTerminalId) : undefined);
  /** The terminal the clipboard/clear shortcuts act on: the remote one on screen, else the local one. */
  const shortcutTerm = () => (remote ? frontRemoteTerminal() : activeTermHandle());
  useEffect(() => onRemoteNotice((message) => showPluginToastRef.current(message)), []);
  // A phone's dictation runs with this computer's dictation settings.
  useEffect(() => startRemotePrefsSync(), []);
  useShortcuts({
    toggleSidebar: () => togglePanel("sidebar"),
    clearTerminal: () => shortcutTerm()?.clear(),
    copy: () => shortcutTerm()?.copySelection(),
    paste: () => shortcutTerm()?.paste(),
    newTab: () => (remote ? remoteShortcuts.newTab(remote) : openNewTab()),
    // Without any profile there is nothing to pick: same as a plain new tab.
    newTabWithProfile: () => (remote ? remoteShortcuts.newTab(remote) : profiles.length > 0 ? setProfilePickerOpen(true) : openNewTab()),
    closeTab: () => (remote ? remoteShortcuts.closeTab(remote) : closeTab(activeTabId)),
    toggleTheme: () => toggleTheme(),
    duplicateTab: () => !remote && duplicateTab(activeTabId),
    nextTab: () => (remote ? remoteShortcuts.step(remote, 1) : stepTab(1)),
    prevTab: () => (remote ? remoteShortcuts.step(remote, -1) : stepTab(-1)),
    moveTabLeft: () => !remote && moveActiveTab(-1),
    moveTabRight: () => !remote && moveActiveTab(1),
    selectTab1: () => (remote ? remoteShortcuts.select(remote, 0) : selectTabAt(0)),
    selectTab2: () => (remote ? remoteShortcuts.select(remote, 1) : selectTabAt(1)),
    selectTab3: () => (remote ? remoteShortcuts.select(remote, 2) : selectTabAt(2)),
    selectTab4: () => (remote ? remoteShortcuts.select(remote, 3) : selectTabAt(3)),
    selectTab5: () => (remote ? remoteShortcuts.select(remote, 4) : selectTabAt(4)),
    selectTab6: () => (remote ? remoteShortcuts.select(remote, 5) : selectTabAt(5)),
    selectTab7: () => (remote ? remoteShortcuts.select(remote, 6) : selectTabAt(6)),
    selectTab8: () => (remote ? remoteShortcuts.select(remote, 7) : selectTabAt(7)),
    lastTab: () => (remote ? remoteShortcuts.select(remote, -1) : selectTabAt(stripTabs.length - 1)),
    zoomIn: () => activeTermHandle() && zoomTabIn(activeTerminalId),
    zoomOut: () => activeTermHandle() && zoomTabOut(activeTerminalId),
    resetZoom: () => activeTermHandle() && resetTabZoom(activeTerminalId),
    toggleAgents: () => toggleAgentTab(),
    toggleBrowser: () => togglePanel("browser"),
    openSettings: () => openSettings(),
    showShortcuts: () => setShortcutsDialogOpen((o) => !o),
  });

  /** Ctrl+Tab / Ctrl+Shift+Tab: the next/previous tab in strip order,
   * wrapping around at the ends. */
  function stepTab(delta: number) {
    if (stripTabs.length < 2) return;
    const i = stripTabs.findIndex((t) => t.id === activeTabId);
    selectTab(stripTabs[(i + delta + stripTabs.length) % stripTabs.length].id);
  }

  /** Ctrl+1..9: the tab at that position - out of range does nothing. */
  function selectTabAt(index: number) {
    const tab = stripTabs[index];
    if (tab) selectTab(tab.id);
  }

  function moveActiveTab(delta: number) {
    const i = stripTabs.findIndex((t) => t.id === activeTabId);
    const to = i + delta;
    if (i !== -1 && to >= 0 && to < stripTabs.length) reorderTab(activeTabId, to);
  }

  function selectTab(id: string) {
    setActiveTabId(id);
    const tab = latestRef.current.tabs.find((t) => t.id === id);
    if (tab?.kind === "terminal") setActiveTerminalId(id);
  }
  const selectTabRef = useRef(selectTab);
  selectTabRef.current = selectTab;
  // The phone-triggered action runner and what it needs, kept current each
  // render for the long-lived "remote://run-action" listener.
  const remoteActionRef = useRef<(id: string, ptyId: string | null) => void>(() => {});
  /** The phone asked to sign a CLI in under a profile (see loginProfile). */
  const remoteProfileLoginRef = useRef<(profileId: string | null, cli: string) => void>(() => {});
  /** The phone asked for a new terminal tab (see useRemoteWindowEvents). */
  const remoteNewTabRef = useRef<(cwd: string | null, cli: string | null, profile: string | null | undefined) => void>(() => {});
  const remoteRenameRef = useRef<(ptyId: string, label: string) => void>(() => {});
  const remoteCloseRef = useRef<(ptyId: string) => void>(() => {});
  /** The phone asked to hand a chat tab over to a terminal / for a new chat tab. */
  const remoteChatTerminalRef = useRef<(tabId: string) => void>(() => {});
  /** How to end each chat tab's agent (see AgentSessionView `onCloser`), so a terminal resuming its session starts only once it is gone. */
  const chatClosersRef = useRef(new Map<string, { close: () => Promise<void>; restart: () => void; clear: () => void; compact: () => void }>());
  const switchingChatsRef = useRef(new Set<string>());
  const remoteTerminalChatRef = useRef<(ptyId: string) => void>(() => {});
  const remoteChatRenameRef = useRef<(tabId: string, label: string) => void>(() => {});
  const remoteChatCloseRef = useRef<(tabId: string) => void>(() => {});
  const remoteTabOpRef = useRef<(target: { ptyId?: string; tabId?: string }, op: RemoteTabOp) => void>(() => {});
  const remoteNewChatRef = useRef<(cwd: string | null, cli: string, profile: string | null | undefined) => void>(() => {});
  const remoteResumeRef = useRef<(cwd: string, sessionId: string, cli: string, wslDistro: string | null | undefined, profile: string | null | undefined, view?: "chat" | "terminal") => void>(() => {});
  const runPluginRef = useRef<(plugin: PluginDef) => void>(() => {});
  const allPluginsRef = useRef<PluginDef[]>([]);

  /** A new tab showing the new tab page (see src/newtab) instead of
   * starting the default shell straight away - what "+", Ctrl+T and "Nuovo
   * terminale" open. With the page turned off in Settings it is the default
   * shell straight away, like the tab strip's per-shell menu entries. */
  function openNewTab(): string {
    if (!newTabPage) return addTab();
    // A layout that is a dialog (see NewTabLayoutDef.dialog): no tab. One at a time.
    if (resolveNewTabLayout(newTabLayoutId).dialog) {
      const open = latestRef.current.tabs.find(isDialogTab);
      if (open) {
        focusNewTabDialog();
        return open.id;
      }
      return addTab(undefined, undefined, true, undefined, true);
    }
    return addTab(undefined, undefined, true);
  }

  function focusNewTabDialog() {
    document.querySelector<HTMLElement>(".glass-newtab.is-dialog .glass-search-input")?.focus();
  }

  /** Closes the new tab dialog without launching anything: the draft tab goes,
   * the tab that was in front never stopped being it. */
  function dismissNewTabDialog(id: string) {
    setTabs((prev) => prev.filter((t) => t.id !== id));
    forgetTab(id);
    // The terminal lost the focus to the dialog's field.
    requestAnimationFrame(() => {
      const fields = document.querySelectorAll<HTMLElement>(".terminal-pane .xterm-helper-textarea");
      Array.from(fields)
        .find((el) => el.offsetParent !== null)
        ?.focus();
    });
  }

  /** `profileId`: `undefined` = automatic (the folder's project default
   * profile, else the active terminal's), `null` = the default profile on
   * purpose, a string = that profile on purpose. */
  function addTab(cwdOverride?: string, shellOverride?: string, newTab = false, profileId?: string | null, dialog = false): string {
    // No longer inherits the active tab's cwd - a fresh tab starts in its
    // shell's start folder (Impostazioni > Cartella di avvio, per shell or
    // the general one), looked up by `fillStartDir` below. `cwdOverride` is
    // still how a caller that *does* want a specific folder (duplicateTab,
    // opening a favorite, resuming an agent session) gets one.
    const id = newTabId("tab");
    // A `\\wsl.localhost\<distro>\...` folder only a WSL shell can start in,
    // whatever the caller (or the configured default) would have picked.
    const pathDistro = cwdOverride ? wslDistroOfPath(cwdOverride) : null;
    if (pathDistro && wslDistroOfShell(shellOverride ?? shellId) === undefined) shellOverride = wslShellId(pathDistro);
    if (shellOverride) pendingShellOverrideRef.current.set(id, shellOverride);
    // A tab whose shell *is* wsl.exe from the moment it spawns never goes
    // through the "user typed `wsl`" detection in handleCommandLine below -
    // there's no host shell first for them to type into - so without this
    // its first WSL prompt's title update is read as a plain host path
    // (nestedShell undefined) and the explorer just never follows it in.
    const wslDistro = wslDistroOfShell(shellOverride ?? shellId);
    const nestedShell = wslDistro !== undefined ? "wsl" : undefined;
    // Env vars don't reach a WSL distro, so a profile means nothing there.
    const canProfile = wslDistro === undefined && !pathDistro;
    const explicit = profileId !== undefined;
    if (explicit) explicitProfileRef.current.add(id);
    const { tabs: openTabs, activeTerminalId: activeId } = latestRef.current;
    inheritedProfileRef.current.set(
      id,
      openTabs.find((t): t is TermTab => t.id === activeId && t.kind === "terminal")?.profileId,
    );
    // Without a folder to open in, left unmounted (empty cwd) until
    // `fillStartDir` has resolved one. An automatic profile needs the
    // folder too (its project default) and a shell's env is fixed at spawn,
    // so such a tab waits for it even when the caller already knows the folder.
    const auto = !explicit && canProfile;
    const cwd = auto || newTab ? "" : (cwdOverride ?? "");
    setTabs((prev) => [
      ...prev,
      {
        kind: "terminal",
        id,
        cwd,
        explorerPath: cwd,
        label: newTab ? t("newTab.title") : labelForCwd(cwdOverride ?? ""),
        nestedShell,
        wslDistro: pathDistro ?? wslDistro ?? undefined,
        ...(typeof profileId === "string" && canProfile ? { profileId } : {}),
        ...(newTab ? { newTab } : {}),
        ...(dialog ? { dialog } : {}),
      },
    ]);
    if (!cwd) fillStartDir(id, shellOverride ?? shellId, cwdOverride);
    // A dialog is over the tab in front, which stays it until a launch.
    if (!dialog) {
      setActiveTabId(id);
      setActiveTerminalId(id);
    }
    return id;
  }

  /** The folder a fresh tab of `shell` starts in: that shell's own start
   * folder if one is set (Impostazioni > Cartella di avvio per shell) and
   * still exists, the general start folder otherwise (itself falling back
   * to the user's home). Except WSL, whose default is the distro's home -
   * the same place `wsl` drops you with a bare `cd`. Starting it in the
   * general start folder instead meant `/mnt/c/...`, which the explorer
   * shows as a plain `C:\...` path: it follows the session fine, but going
   * up stops at `C:\` - the explorer is browsing Windows, not the distro,
   * and never reaches the Linux tree the shell lives in. From the home,
   * going up walks the distro's own tree (`\\wsl.localhost\<distro>` is
   * `/`), in step with the shell. A general start folder that's already
   * inside a distro is kept as is. */
  async function resolveStartDir(shell: string): Promise<string> {
    const fallback = resolvedStartPath || homeDir;
    const custom = shellStartPaths[shellStartKey(shell)] ?? "";
    const distro = wslDistroOfShell(shell);
    if (distro !== undefined) {
      if (!custom && wslDistroOfPath(fallback)) return fallback;
      return (await resolveWslStartDir(distro, custom || "~")) ?? fallback;
    }
    if (custom && (await invoke<boolean>("is_directory", { path: custom }).catch(() => false))) return custom;
    return fallback;
  }

  /** The profile a not-yet-spawned tab should run under when nobody chose one
   * for it: `cwd`'s project default, else the one inherited from the tab that
   * was active at creation. `undefined` for a tab with an explicit profile
   * (left alone) or a WSL one (env vars can't reach the distro). */
  async function automaticProfile(tabId: string, cwd: string, wsl: boolean): Promise<string | undefined> {
    if (wsl || explicitProfileRef.current.has(tabId)) return undefined;
    return (await profileForPath(cwd)) ?? inheritedProfileRef.current.get(tabId);
  }

  /** Gives a tab still without a folder its shell's start folder (see
   * `resolveStartDir`) - or `knownCwd` when the caller already has one - and,
   * unless its profile was chosen on purpose, its automatic profile (see
   * `automaticProfile`). The tab isn't mounted until then, so its shell
   * can still be switched: a start folder inside a distro only a WSL shell
   * can open. */
  function fillStartDir(tabId: string, shell: string, knownCwd?: string) {
    if (startDirPendingRef.current.has(tabId)) return;
    startDirPendingRef.current.add(tabId);
    void (async () => {
      const cwd = knownCwd ?? (await resolveStartDir(shell));
      const pathDistro = wslDistroOfPath(cwd);
      const wslShell = wslDistroOfShell(shell) !== undefined;
      const profile = await automaticProfile(tabId, cwd, !!pathDistro || wslShell);
      startDirPendingRef.current.delete(tabId);
      if (pathDistro && !wslShell) pendingShellOverrideRef.current.set(tabId, wslShellId(pathDistro));
      setTabs((prev) =>
        patchTermTab(prev, tabId, (t) =>
          t.cwd
            ? null
            : {
                cwd,
                explorerPath: cwd,
                // A restored tab whose folder is gone still keeps the name
                // the user gave it.
                label: t.customLabel || t.newTab ? t.label : labelForCwd(cwd),
                nestedShell: pathDistro || wslShell ? "wsl" : t.nestedShell,
                wslDistro: pathDistro ?? t.wslDistro,
                // A restored tab keeps the profile it had; a pick made while
                // the folder was being looked up wins over the automatic one.
                profileId: t.profileId ?? (explicitProfileRef.current.has(tabId) ? undefined : profile),
              },
        ),
      );
    })();
  }

  /** The new tab page's shell selection changed: point the tab's folder
   * (the explorer, the page's prompt) at that shell's own start folder. */
  function previewNewTabShell(tabId: string, shell: string | undefined) {
    const target = shell ?? shellId;
    newTabShellRef.current.set(tabId, target);
    void resolveStartDir(target).then(async (cwd) => {
      const wsl = wslDistroOfShell(target) !== undefined || !!wslDistroOfPath(cwd);
      // The folder may carry a different project default profile.
      const profile = await automaticProfile(tabId, cwd, wsl);
      if (newTabShellRef.current.get(tabId) !== target) return;
      setTabs((prev) =>
        patchTermTab(prev, tabId, (t) => {
          if (!t.newTab) return null;
          const nextProfile = explicitProfileRef.current.has(tabId) ? t.profileId : profile;
          return { cwd, explorerPath: cwd, profileId: nextProfile };
        }),
      );
    });
  }

  /** Turns a tab still on the new tab page into a terminal: `shell`
   * (default: the configured one) started in `cwd` (default: that shell's
   * start folder), running `command` - or with it just typed, for
   * `typeOnly`. */
  function launchFromNewTab(tabId: string, { shell, cwd, command, typeOnly }: NewTabLaunch) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab?.newTab) return;
    // The page's own cwd follows the chosen shell's start folder and
    // whatever the explorer browsed to (see `previewNewTabShell`, `browseExplorer`).
    const nextCwd = cwd ?? tab.cwd;
    const pathDistro = nextCwd ? wslDistroOfPath(nextCwd) : null;
    if (pathDistro && wslDistroOfShell(shell ?? shellId) === undefined) shell = wslShellId(pathDistro);
    if (shell) pendingShellOverrideRef.current.set(tabId, shell);
    if (command) (typeOnly ? pendingTypedCommandsRef : pendingCommandsRef).current.set(tabId, command);
    const wslDistro = wslDistroOfShell(shell ?? shellId);
    const wsl = !!pathDistro || wslDistro !== undefined;
    // A folder other than the one the page showed (a recent terminal, a
    // favorite) may have its own project default profile, and the shell can't
    // be spawned before that is known.
    const lookup = !wsl && !!cwd && cwd !== tab.cwd && !explicitProfileRef.current.has(tabId);
    void (async () => {
      const profile = lookup ? await automaticProfile(tabId, nextCwd, false) : undefined;
      // The dialog closes into the new terminal: it takes the front, no hand-off fade.
      if (tab.dialog) {
        setActiveTabId(tabId);
        setActiveTerminalId(tabId);
      }
      setTabs((prev) =>
        patchTermTab(prev, tabId, (t) => ({
          newTab: undefined,
          dialog: undefined,
          cwd: nextCwd,
          explorerPath: nextCwd,
          label: t.customLabel ? t.label : labelForCwd(nextCwd),
          nestedShell: wsl ? "wsl" : undefined,
          wslDistro: pathDistro ?? wslDistro ?? undefined,
          // Env vars don't reach a WSL distro: its profile is dropped.
          profileId: wsl ? undefined : lookup && !explicitProfileRef.current.has(tabId) ? profile : t.profileId,
        })),
      );
      if (!nextCwd) fillStartDir(tabId, shell ?? shellId);
    })();
  }

  /** What's at the front of a tab's terminal right now - see shellDialect.ts. */
  function tabForeground(tabId: string): Promise<Foreground | null> {
    return ptyForeground(termRefs.current.get(tabId)?.getPtyId());
  }

  /** Runs `command` in a new tab in the same folder and shell as `tabId` -
   * for a command meant for a tab whose input is owned by a running program
   * (a dev server, an editor, an agent): typed there, it would be garbage
   * input to that program instead of a command. Returns the new tab's id. */
  function runInTabLike(tabId: string, command: string): string {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const id = addTab(tab?.cwd, tab ? tabShell(tab) : undefined);
    pendingCommandsRef.current.set(id, command);
    return id;
  }

  /** A fresh terminal tab whose one job is to run `command` - used for a
   * CLI's install/login step offered from the setup-check dialog, so the
   * user's actual working terminal is never hijacked for it. */
  function openTerminalWithCommand(command: string, profileId?: string) {
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => [...prev, makeTermTab(id, homeDir, { label: "setup", profileId })]);
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  /** The command that resumes `sessionId` in `cli` - host (`wsl` false) gets the Codex launch flags. */
  async function resumeCommand(cli: AgentCli, sessionId: string, host: boolean, profileId?: string): Promise<string> {
    if (cli === "claude") return `claude --resume ${sessionId}`;
    if (cli === "vibe") return `vibe --resume ${sessionId}`;
    if (cli === "gemini") return `gemini --resume ${sessionId}`;
    // A named profile has its own data dir: --standalone keeps opencode off the shared background service (default profile).
    if (cli === "opencode") return `opencode${profileId ? " --standalone" : ""} --session ${sessionId}`;
    if (cli === "cline") return `cline --id ${sessionId}`;
    return host ? await withCodexLaunchFlags(`codex resume ${sessionId}`) : `codex resume ${sessionId}`;
  }

  /** Opens a fresh terminal tab in `cwd`, resuming a specific agent session
   * the moment its shell is ready - used from the Agents sidebar for a
   * background/saved session (one this app has no open tab for), so
   * double-clicking it drops the user straight back into that chat instead
   * of a bare shell they'd have to resume by hand. */
  async function openAgentSession(cwd: string, sessionId: string, cli: AgentCli, wslDistro?: string, profileId?: string, at?: number) {
    // Typed into a shell below: an id that isn't a plain token is never run.
    if (!isSafeSessionId(sessionId)) {
      console.warn("refusing to resume a session with an unexpected id", JSON.stringify(sessionId));
      return;
    }
    if (wslDistro) {
      // Saved inside WSL: resumed by the distro's own CLI, in a WSL tab
      // opened on that folder (`cwd` is a Linux path there). The
      // `--no-daemon` check is about Windows' Job Object - not WSL's concern.
      const command = await resumeCommand(cli, sessionId, false, profileId);
      const id = addTab(toWindowsPath(wslDistro, cwd), wslShellId(wslDistro));
      pendingCommandsRef.current.set(id, command);
      return;
    }
    const command = await resumeCommand(cli, sessionId, true, profileId);
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => insertTabAt(prev, makeTermTab(id, cwd, { profileId }), at));
    setActiveTabId(id);
    setActiveTerminalId(id);
  }

  /** The agent view something picked in the History opens in: what a phone asked for, else the kind of tab the History
   * is shown for (a chat's opens a chat, a terminal's a terminal), else the default agent view. */
  function historyView(view?: "chat" | "terminal"): "chat" | "terminal" {
    if (view) return view;
    const { tabs: all, activeTabId: front } = latestRef.current;
    const kind = all.find((t) => t.id === front)?.kind;
    if (kind === "chat" || kind === "terminal") return kind;
    return defaultOpensChat() ? "chat" : "terminal";
  }

  /** The tab running agent session `sessionId` already: a chat (shown or in its background) or a terminal agent. */
  function tabWithSession(sessionId: string): AppTab | undefined {
    return latestRef.current.tabs.find((t) =>
      t.kind === "chat"
        ? t.sessionId === sessionId || (t.parked ?? []).some((p) => p.sessionId === sessionId)
        : t.kind === "terminal" && sessionByTab.get(t.id)?.session_id === sessionId,
    );
  }

  /** Sessions being resumed right now (`cli:sessionId`): a second click meanwhile must not open a second tab. */
  const resumingRef = useRef(new Set<string>());

  /** A saved session picked in the History (or from a phone): resumed in the view `historyView` picks. A session
   * already open in a tab brings that tab forward instead: two processes must never share one session. */
  function resumeAgentSession(cwd: string, sessionId: string, cli: AgentCli, wslDistro?: string, profileId?: string, lastActiveAt?: number, view?: "chat" | "terminal") {
    const holder = sessionId ? tabWithSession(sessionId) : undefined;
    if (holder) {
      openHistoryTab(holder.id, holder.kind === "chat" ? sessionId : undefined);
      return;
    }
    const busyKey = `${cli}:${sessionId}`;
    if (resumingRef.current.has(busyKey)) return;
    resumingRef.current.add(busyKey);
    // Kept a moment past the start, until the new tab is in the strip for tabWithSession to find.
    const done = () => setTimeout(() => resumingRef.current.delete(busyKey), 1000);
    const { tabs: all, activeTabId: front } = latestRef.current;
    if (historyView(view) === "chat") {
      // Saved inside WSL: a chat in that distro, on the folder as Windows sees it (like the WSL terminal).
      const chatCwd = wslDistro ? toWindowsPath(wslDistro, cwd) : cwd;
      // The default distro (shell "wsl") has no name to compare: such a chat is never reused.
      const distroOf = (t: ChatTab) => {
        const shellDistro = wslDistroOfShell(t.shell);
        return shellDistro === null ? "\0wsl" : (shellDistro ?? wslDistroOfPath(t.cwd) ?? undefined);
      };
      // A chat tab already on this folder (same agent, profile, same side of WSL) shows it too, the conversation
      // it had keeps running in the background; only without one does a new tab open.
      const fits = (t: AppTab): t is ChatTab =>
        t.kind === "chat" && !t.delegate && t.agent === cli && t.cwd === chatCwd && (t.profileId ?? null) === (profileId ?? null) && !t.handoffFrom && distroOf(t) === (wslDistro || undefined);
      const target = all.find((t) => t.id === front && fits(t)) ?? all.find(fits);
      if (target) {
        showChatSession(target.id, sessionId, lastActiveAt);
        setActiveTabId(target.id);
        done();
        return;
      }
      // A session is loaded where it was saved (outside WSL or in its distro), whatever the default shell is.
      void openChatTab(cli, chatCwd, { profileId, shell: wslDistro ? wslShellId(wslDistro) : "host", resume: { sessionId, lastActiveAt } }).finally(done);
      return;
    }
    void openAgentSession(cwd, sessionId, cli, wslDistro, profileId).finally(done);
  }

  /** The `pty_spawn` shell id a new terminal needs to land in the same kind
   * of session `tab` is in right now - so "Apri in un altro terminale", a
   * duplicated tab or a favorite saved from a WSL session opens in WSL (same
   * distro), where its path actually exists, and one from a tab opened as
   * PowerShell/cmd/... opens in that same shell. `undefined` = the tab runs
   * the configured default. A path inside a distro's share always means WSL,
   * even once a nested agent/remote session froze the tab (which clears
   * `wslDistro`). */
  function tabShell(tab: TermTab): string | undefined {
    if (tab.nestedShell === "wsl") return wslShellId(tab.wslDistro);
    const pathDistro = wslDistroOfPath(tab.explorerPath || tab.cwd);
    if (pathDistro) return wslShellId(pathDistro);
    return pendingShellOverrideRef.current.get(tab.id);
  }

  /** Opens a saved favorite: in the active terminal (a silent `cd`, same as
   * browsing there from the explorer) when it's the same kind of terminal
   * the favorite was saved from, otherwise in a new tab running that shell -
   * a WSL folder can't be reached from cmd/PowerShell, and a folder saved
   * from PowerShell shouldn't suddenly open in WSL. */
  function openFavorite(fav: FavoriteFolder) {
    const pathDistro = wslDistroOfPath(fav.path);
    const shell = fav.shell ?? (pathDistro ? wslShellId(pathDistro) : undefined);
    if (activeTerminal?.newTab && activeTabId === activeTerminal.id) {
      launchFromNewTab(activeTerminal.id, { shell, cwd: fav.path });
      return;
    }
    const current = activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined;
    if (!shell || !activeTerminal || sameShell(shell, current)) {
      browseExplorer(fav.path);
      return;
    }
    addTab(fav.path, shell);
  }

  /** A second, independent tab alongside `id` - same cwd for a terminal
   * (via addTab's own cwdOverride), same file for an editor (bypassing
   * openFile's own "already open, just switch to it" dedupe, since
   * duplicating an already-open file is exactly asking for a second tab on
   * it). Settings has nothing to duplicate (a singleton tab - see
   * openSettings) so it's simply not offered there (see TabStrip's own menu). */
  function duplicateTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    if (tab.kind === "terminal") {
      addTab(tab.cwd, tabShell(tab), false, tab.profileId ?? null);
      return;
    }
    if (tab.kind === "chat") {
      void openChatTab(tab.agent, tab.cwd, { profileId: tab.profileId, viewId: tab.viewId });
      return;
    }
    if (tab.kind === "editor") {
      const newId = newTabId("editor");
      setTabs((prev) => [...prev, { kind: "editor", id: newId, path: tab.path, label: tab.label }]);
      setActiveTabId(newId);
    }
  }

  function openFile(path: string) {
    const name = basename(path);
    if (!isLikelyTextFile(name)) {
      // Not something the built-in editor can show (image, PDF, archive...):
      // handed to the OS default app instead. The explorer already lists a
      // WSL tab's files by their Windows form, but a bare POSIX path from one
      // is translated too - Windows can't open `/home/...` as-is.
      const wslTab = activeTerminal?.nestedShell === "wsl" ? activeTerminal : undefined;
      const hostPath = wslTab?.wslDistro && path.startsWith("/") ? toWindowsPath(wslTab.wslDistro, path) : path;
      invoke("open_with_default_app", { path: hostPath }).catch((e) =>
        showPluginToast(t("app.openFailed", { name, error: String(e) })),
      );
      return;
    }
    openInEditor(path);
  }

  /** Opens (or focuses) `path` in an editor tab, whatever its extension - the
   * caller already knows it is text (a chat/terminal path link: the backend
   * sniffed it) - and moves to `line` (1-based) when given. */
  function openInEditor(path: string, line?: number) {
    const existing = latestRef.current.tabs.find((t) => t.kind === "editor" && t.path === path);
    // Two opens before the next render both miss `existing`: they share one
    // id, and the updater drops the second add.
    const id = existing?.id ?? reservedTabId(`editor:${path}`, "editor");
    if (!existing) {
      setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { kind: "editor", id, path, label: basename(path) }]));
    }
    setActiveTabId(id);
    if (line && line > 0) {
      // A new tab's editor mounts on a later render; it keeps the line until its text is loaded.
      const reveal = (attempt: number) => {
        const handle = editorRefs.current.get(id);
        if (handle) handle.scrollToLine(line);
        else if (attempt < 40) window.setTimeout(() => reveal(attempt + 1), 50);
      };
      reveal(0);
    }
  }

  // What a path link in a chat or terminal can do in the app; one object for
  // the window's life (the handlers it calls are read fresh each time).
  const fileLinkLatestRef = useRef<FileLinkActions>({ openInEditor, browseFolder: () => {}, openInPreview: openFileInPreview });
  fileLinkLatestRef.current = {
    openInEditor,
    browseFolder: (path) => {
      browseExplorer(path);
      setSidebarCollapsed(false);
    },
    openInPreview: openFileInPreview,
  };
  const [fileLinkActions] = useState<FileLinkActions>(() => ({
    openInEditor: (path, line) => fileLinkLatestRef.current.openInEditor(path, line),
    browseFolder: (path) => fileLinkLatestRef.current.browseFolder(path),
    openInPreview: (path) => fileLinkLatestRef.current.openInPreview(path),
  }));

  /** Opens (or focuses) the diff of one file from the Git tab. */
  function openDiff(root: string, change: GitChange, staged: boolean) {
    const existing = latestRef.current.tabs.find(
      (t) => t.kind === "diff" && t.root === root && t.path === change.path && t.staged === staged,
    );
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }
    const name = basename(change.path);
    const id = reservedTabId(`diff:${root}\u0000${change.path}\u0000${staged}`, "diff");
    const label = t(staged ? "git.stagedLabel" : "git.diffLabel", { name });
    setTabs((prev) =>
      prev.some((t) => t.id === id) ? prev : [...prev, { kind: "diff", id, root, path: change.path, staged, label }],
    );
    setActiveTabId(id);
  }

  /** The id a "open or focus" action uses for the tab it is about to add.
   * Two calls before the next render can't see each other's tab yet; handing
   * both the same id lets the `setTabs` updater tell the second is a repeat. */
  const reservedIdsRef = useRef(new Map<string, string>());
  function reservedTabId(key: string, kind: "editor" | "diff"): string {
    let id = reservedIdsRef.current.get(key);
    if (!id) {
      id = newTabId(kind);
      reservedIdsRef.current.set(key, id);
    }
    return id;
  }

  /** Opens `tab`, or focuses the one of its kind already open (`replace`:
   * swaps that one for `tab` instead). The check is inside the updater so
   * two quick calls can't add it twice. Also shows the side panel even if it
   * was collapsed: each of these pages keeps its navigation there. */
  function openSingleton(tab: Extract<AppTab, { kind: "settings" | "changelog" | "whatsNew" }>, replace = false) {
    setSidebarCollapsed(false);
    setTabs((prev) =>
      prev.some((p) => p.kind === tab.kind)
        ? replace
          ? prev.map((p) => (p.kind === tab.kind ? tab : p))
          : prev
        : [...prev, tab],
    );
    setActiveTabId(tab.id);
  }

  function openSettings() {
    openSingleton({ kind: "settings", id: "settings", label: t("settings.title") });
  }

  function openChangelog() {
    openSingleton({ kind: "changelog", id: "changelog", label: t("changelog.title") });
  }

  /** The "What's new" tab for `version` - replacing one already open (a
   * restored session can bring back the previous update's). */
  function openWhatsNew(version: string) {
    openSingleton({ kind: "whatsNew", id: "whatsnew", label: t("whatsNew.title"), version }, true);
  }

  // First launch after an update: show what it brought. Main window only,
  // once the restored session is in place so the tab lands after it.
  useEffect(() => {
    if (!isMainWindow || !sessionChecked) return;
    getVersion()
      .then((version) => {
        if (consumeUpdatedVersion(version)) openWhatsNew(version);
      })
      .catch(() => {});
  }, [sessionChecked]);

  function reorderTab(id: string, toIndex: number) {
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === id);
      if (from === -1 || from === toIndex) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(Math.max(0, Math.min(toIndex, next.length)), 0, moved);
      return next;
    });
  }

  /** Receives a tab from another window (or, `replaceAll`, as the very
   * first content of a window opened for it). Its id is re-issued here - ids
   * are only unique per window. */
  function adoptTab(transfer: TabTransfer, replaceAll = false) {
    const { tab } = transfer;
    let adopted: AppTab;
    if (tab.kind === "terminal") {
      const id = newTabId("tab");
      if (transfer.terminal) {
        pendingAttachRef.current.set(id, { ptyId: transfer.terminal.ptyId, snapshot: transfer.terminal.snapshot });
        if (transfer.terminal.shell) pendingShellOverrideRef.current.set(id, transfer.terminal.shell);
        if (transfer.terminal.fontSize !== undefined) setTabFontSize(id, transfer.terminal.fontSize);
      }
      adopted = { ...tab, id };
    } else if (tab.kind === "editor") {
      const id = newTabId("editor");
      if (transfer.editor?.dirty) pendingEditorContentRef.current.set(id, transfer.editor.content);
      adopted = { ...tab, id };
    } else if (tab.kind === "diff") {
      adopted = { ...tab, id: newTabId("diff") };
    } else if (tab.kind === "changelog") {
      adopted = { kind: "changelog", id: "changelog", label: t("changelog.title") };
    } else if (tab.kind === "whatsNew") {
      adopted = { ...tab, id: "whatsnew" };
    } else {
      adopted = { kind: "settings", id: "settings", label: t("settings.title") };
    }

    if (replaceAll) {
      // A window always has a terminal: one opened for an editor/settings
      // tab keeps its startup terminal next to it.
      setTabs((prev) => (adopted.kind === "terminal" ? [adopted] : [...prev.filter((t) => t.kind === "terminal"), adopted]));
    } else if (
      (adopted.kind === "settings" || adopted.kind === "changelog" || adopted.kind === "whatsNew") &&
      latestRef.current.tabs.some((t) => t.kind === adopted.kind)
    ) {
      // Already open here (it's a singleton): just switch to it.
    } else {
      const index = tabStripDropIndex(transfer.drop);
      setTabs((prev) => {
        const next = [...prev];
        next.splice(index ?? next.length, 0, adopted);
        return next;
      });
    }
    setActiveTabId(adopted.id);
    if (adopted.kind === "terminal") setActiveTerminalId(adopted.id);
  }
  // Tells the backend which terminal tabs this window has, and which pty
  // each one runs - so the Agents panel of every window can list (and jump
  // to) agents running here. Re-sent periodically: a new tab's pty id only
  // exists once its shell has spawned.
  // Keyed on what is reported, not on `tabs`: a title event that changes
  // nothing the backend shows shouldn't cost an IPC call.
  // Bumped when a terminal learns its pty id: the tab-to-agent match and the
  // tab report both depend on it, and neither is otherwise re-run for it.
  const [ptyVersion, setPtyVersion] = useState(0);
  // In strip order, terminals and chats together: moving a chat past a terminal is reported too.
  const reportedTabsKey = listedTabs(tabs)
    .map((t) => (t.kind === "terminal" ? `t\u0000${t.id}\u0000${t.label}\u0000${t.cwd}\u0000${t.notifyMuted ? 1 : 0}` : t.kind === "chat" ? `c\u0000${t.id}\u0000${t.label}\u0000${t.sessionId ?? ""}` : ""))
    .join("\u0001");
  useReportTabs(reportedTabsKey, ptyVersion, latestRef, termRefs);

  const adoptTabRef = useRef(adoptTab);
  adoptTabRef.current = adoptTab;

  // TerminalView is memoized, so what it gets must keep its identity from one
  // render to the next: the handlers sit behind a ref (always the latest
  // closures), and each tab gets one set of callbacks that call through it.
  const handlersRef = useRef({
    title: handleTitleChange,
    busy: handleBusyChange,
    commandLine: handleCommandLine,
    interceptCommandLine,
    patchHandoff,
    openDelegate: openDelegateTab,
  });
  handlersRef.current = {
    title: handleTitleChange,
    busy: handleBusyChange,
    commandLine: handleCommandLine,
    interceptCommandLine,
    patchHandoff,
    openDelegate: openDelegateTab,
  };
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
  function termCallbacks(tabId: string) {
    let callbacks = termCallbacksRef.current.get(tabId);
    if (!callbacks) {
      callbacks = {
        ref: (handle) => {
          if (handle) termRefs.current.set(tabId, handle);
          else termRefs.current.delete(tabId);
        },
        onTitleChange: (title) => handlersRef.current.title(tabId, title),
        onBusyChange: (busy) => handlersRef.current.busy(tabId, busy),
        onCommandLine: (line) => handlersRef.current.commandLine(tabId, line),
        interceptCommandLine: (line) => handlersRef.current.interceptCommandLine(tabId, line),
        onAnchor: (anchor) => handlersRef.current.patchHandoff(tabId, { anchor }),
        onPromptShown: (promptShown) => handlersRef.current.patchHandoff(tabId, { promptShown }),
        onPtyReady: () => setPtyVersion((v) => v + 1),
        onOpenDelegate: (delegate, wslDistro) => handlersRef.current.openDelegate(tabId, delegate, wslDistro),
      };
      termCallbacksRef.current.set(tabId, callbacks);
    }
    return callbacks;
  }

  useRemoteWindowEvents({
    adoptTabRef,
    selectTabRef,
    latestRef,
    termRefs,
    remoteActionRef,
    remoteProfileLoginRef,
    remoteNewTabRef,
    remoteRenameRef,
    remoteCloseRef,
    remoteChatTerminalRef,
    remoteTerminalChatRef,
    remoteChatRenameRef,
    remoteChatCloseRef,
    remoteTabOpRef,
    remoteNewChatRef,
    remoteResumeRef,
  });

  /** Everything the receiving window needs to rebuild `tab` - for a terminal
   * this detaches its running session from this window (see
   * `TerminalHandle.release`). `null` when it can't move (a terminal whose
   * shell hasn't started yet). */
  function packTab(tab: AppTab): Promise<TabTransfer | null> {
    return packTabTransfer(tab, {
      terminal: termRefs.current.get(tab.id),
      editor: editorRefs.current.get(tab.id),
      pendingEditorContent: pendingEditorContentRef.current.get(tab.id),
      shell: tab.kind === "terminal" ? tabShell(tab) : undefined,
      fontSize: tabFontSizeOverrides[tab.id],
    });
  }

  /** Takes a moved-away tab out of this window without closing anything -
   * its session lives on in the other window. A window left with no
   * terminal gets a fresh one (there's always at least one). */
  function removeMovedTab(id: string) {
    const current = latestRef.current;
    const idx = current.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    let next = current.tabs.filter((t) => t.id !== id);
    if (next.length > 0 && !next.some((t) => t.kind === "terminal")) {
      const cwd = resolvedStartPath || homeDir;
      next = [...next, makeTermTab(newTabId("tab"), cwd)];
    }
    if (id === current.activeTabId) {
      const fallback = next[Math.max(0, idx - 1)] ?? next[0];
      if (fallback) setActiveTabId(fallback.id);
    }
    if (!next.some((t) => t.id === current.activeTerminalId)) {
      const fallbackTerminal = next.find((t) => t.kind === "terminal");
      if (fallbackTerminal) setActiveTerminalId(fallbackTerminal.id);
    }
    setTabs(next);
    forgetTab(id);
  }

  /** A tab dragged out of the tab strip and released - see TabStrip. Where
   * it lands depends on what's under the cursor: another Flowcode window
   * takes it in; empty desktop (or this same window, away from its tab
   * strip) gets a new window for it. Dragging a window's only tab just
   * carries the whole window along, or merges it into the window it's
   * dropped on. */
  async function handleTabDragOut(id: string) {
    const tab = latestRef.current.tabs.find((t) => t.id === id);
    // A chat can't change window: its agent lives in this one.
    if (!tab || tab.kind === "chat") return;
    const target = await invoke<CursorTarget>("window_at_cursor").catch(() => null);
    if (!target) return;
    const alone = listedTabs(latestRef.current.tabs).length === 1;
    const otherWindow = target.label !== null && target.label !== appWindow.label ? target.label : null;
    if (!otherWindow && alone) {
      if (target.label === null) await invoke("window_move_to_cursor").catch(() => {});
      return;
    }
    const transfer = await packTab(tab);
    if (!transfer) return;
    if (!alone) removeMovedTab(id);
    try {
      if (otherWindow) {
        await emitTo(otherWindow, "tab:adopt", { ...transfer, drop: { x: target.x, y: target.y } });
      } else {
        await invoke("window_open", { init: { kind: "adopt", transfer }, placement: { kind: "atCursor" } });
      }
    } catch {
      // Nowhere to go after all: it comes back here, still running.
      if (!alone) adoptTab(transfer);
      return;
    }
    if (alone) appWindow.close();
  }

  /** Drops the per-tab bookkeeping kept outside `tabs` itself. */
  function forgetTab(id: string) {
    forgetBrowserTab(id);
    forgetTabPanels(id);
    termRefs.current.delete(id);
    termCallbacksRef.current.delete(id);
    editorRefs.current.delete(id);
    pendingCommandsRef.current.delete(id);
    pendingShellOverrideRef.current.delete(id);
    explicitProfileRef.current.delete(id);
    inheritedProfileRef.current.delete(id);
    newTabShellRef.current.delete(id);
    pendingTypedCommandsRef.current.delete(id);
    pendingAttachRef.current.delete(id);
    pendingEditorContentRef.current.delete(id);
    restoredContentRef.current.delete(id);
    restoredTabIdsRef.current.delete(id);
    startDirPendingRef.current.delete(id);
    for (const [key, reserved] of reservedIdsRef.current) if (reserved === id) reservedIdsRef.current.delete(key);
    setHandoffs((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    resetTabZoom(id);
    setDirtyIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  async function closeTab(id: string) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    // The new-tab dialog draft doesn't count: closing the only real tab closes the window.
    if (!isDialogTab(tab) && listedTabs(latestRef.current.tabs).length === 1) {
      void appWindow.close();
      return;
    }
    if (tab.kind !== "terminal") {
      const handle = editorRefs.current.get(id);
      if (handle?.isDirty()) {
        const ok = await confirm({
          title: t("app.unsaved.title"),
          message: t("app.unsaved.message", { name: tab.label }),
          confirmLabel: t("app.unsaved.confirm"),
          danger: true,
        });
        if (!ok) return;
      }
      // Conversations parked in the background that are mid-turn end with the tab.
      const working = tab.kind === "chat" ? (tab.parked ?? []).filter((p) => p.status === "busy" || p.status === "waiting").length : 0;
      if (working > 0) {
        const ok = await confirm({
          title: t("app.parkedBusy.title"),
          message: t("app.parkedBusy.message", { count: working }),
          confirmLabel: t("app.parkedBusy.confirm"),
          danger: true,
        });
        if (!ok) return;
      }
    }
    // Read through refs, not the `tabs`/active ids captured when this call
    // started: the confirm above can stay open for a while, and title/cwd
    // updates that landed on other tabs meanwhile must not be overwritten
    // with that stale snapshot.
    const current = latestRef.current;
    const idx = current.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    // Closing the very last tab of any kind mirrors a plain terminal app:
    // nothing left to show, so close the window rather than leave it empty.
    // Any other tab can go, terminals included - a window holding just
    // Settings or an editor is fine.
    if (current.tabs.length === 1 || (!isDialogTab(tab) && listedTabs(current.tabs).length === 1)) {
      appWindow.close();
      return;
    }
    // A chat's delegated children's tabs go with it (the backend closes the children).
    const next = current.tabs.filter((t) => t.id !== id && !(t.kind === "chat" && t.delegate?.parentTabId === id));
    if (next.length === 0) {
      appWindow.close();
      return;
    }
    if (id === current.activeTabId || !next.some((t) => t.id === current.activeTabId)) {
      const fallback = next[Math.max(0, idx - 1)] ?? next[0];
      if (fallback) setActiveTabId(fallback.id);
    }
    if (id === current.activeTerminalId) {
      // No terminal left (e.g. only Settings open) is fine: "" just means
      // no terminal is in front until a new one opens.
      setActiveTerminalId(next.find((t) => t.kind === "terminal")?.id ?? "");
    }
    setTabs((prev) => prev.filter((t) => t.id !== id && !(t.kind === "chat" && t.delegate?.parentTabId === id)));
    forgetTab(id);
  }

  /** A bare agent CLI typed at a host shell prompt (`claude`, `codex`, ...)
   * while chat is the default agent view: opened as a chat tab in the tab's
   * folder instead of running in the terminal. A line with arguments, and a
   * prompt that isn't a plain host shell (busy, WSL, ssh, an agent), runs as typed. */
  function interceptCommandLine(tabId: string, line: string): boolean {
    const match = line.trim().match(/^(claude|codex|vibe|gemini|opencode|cline)(?:\.exe)?$/i);
    if (!match || !defaultOpensChat()) return false;
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab || tab.busy || tab.nestedShell || wslDistroOfShell(tabShell(tab)) !== undefined) return false;
    const cli = match[1].toLowerCase() as AgentCli;
    void profileForPath(tab.cwd).then((wanted) => openChatTab(cli, tab.cwd, { profileId: (wanted ?? tab.profileId) ?? undefined, replaceTabId: tabId }));
    return true;
  }

  /** Recognizes the user having typed `wsl`, `ssh ...` or an interactive
   * `docker exec/run -it` (see the shadow line-buffer in Terminal.tsx) -
   * the terminal-inside-the-terminal cases `handleTitleChange` below needs
   * to treat differently from a plain local `cd`. */
  function handleCommandLine(tabId: string, line: string) {
    sessionDirtyRef.current = true;
    const trimmed = line.trim();
    const commandTab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    // Shown on the new tab page - only lines typed at a shell prompt (not
    // into a full-screen program, an ssh session or an agent), where the
    // tab's folder is really where the command ran.
    if (commandTab && !commandTab.busy && (!commandTab.nestedShell || commandTab.nestedShell === "wsl")) {
      recordRecentTerminal(commandTab.cwd, tabShell(commandTab), trimmed);
      recordCommand(tabShell(commandTab), trimmed);
    }

    const wslMatch = trimmed.match(/^wsl(?:\.exe)?(?:\s+(.*))?$/i);
    if (wslMatch) {
      const rest = wslMatch[1] ?? "";
      const distroMatch = rest.match(/(?:^|\s)(?:-d|--distribution)\s+(\S+)/i);
      setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "wsl", wslDistro: distroMatch?.[1] }));
      return;
    }

    const isInteractiveDocker =
      /^docker\s+(exec|run)\b/i.test(trimmed) && /(^|\s)(-it|-ti)(\s|$)|--interactive\b/i.test(trimmed);
    if (/^ssh\s+\S/i.test(trimmed) || isInteractiveDocker) {
      setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "remote", wslDistro: undefined }));
      return;
    }

    // Same tracking as `markAgentLaunching` (see its doc comment), but for
    // the CLI typed straight into the prompt rather than launched through a
    // shortcut - `checkCliAndMaybeLaunch` only ever sees the shortcut path.
    if (/^(claude|codex|vibe|gemini|opencode|cline)(\.exe)?(?:\s|$)/i.test(trimmed)) {
      setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "agent", wslDistro: undefined }));
    }
  }

  function handleTitleChange(tabId: string, rawTitle: string) {
    // Decided from the committed tabs, outside the updater: an updater must
    // stay pure (StrictMode runs it twice), and this one starts lookups.
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab) return;
    const { patch, after } = resolveTitle(tab, rawTitle, homeDir, setTabs);
    setTabs((prev) => patchTermTab(prev, tabId, patch));
    after?.();
  }

  function renameTab(id: string, label: string) {
    const trimmed = label.trim();
    if (!trimmed) return;
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        if (t.kind === "terminal") return { ...t, label: trimmed, customLabel: true };
        return { ...t, label: trimmed };
      }),
    );
  }

  function toggleTabNotifications(id: string) {
    setTabs((prev) => patchTermTab(prev, id, (t) => ({ notifyMuted: !t.notifyMuted })));
  }

  /** Dumps what the agent detection sees for this tab (see agent_detection_dump) to the clipboard. */
  async function copyAgentDiagnostics(id: string) {
    const ptyId = termRefs.current.get(id)?.getPtyId();
    try {
      const report = await invoke<string>("agent_detection_dump", { ptyId: ptyId ?? null });
      await navigator.clipboard.writeText(report);
      showPluginToast(t("tabs.agentDiagnostics.copied"));
    } catch (e) {
      showPluginToast(String(e));
    }
  }

  function handleEditorRenamed(id: string, newPath: string) {
    const label = basename(newPath);
    setTabs((prev) => prev.map((t) => (t.id === id && t.kind === "editor" ? { ...t, path: newPath, label } : t)));
  }

  function handleBusyChange(tabId: string, busy: boolean) {
    sessionDirtyRef.current = true;
    setTabs((prev) =>
      patchTermTab(prev, tabId, (t) =>
        // The agent's full-screen UI closing is the one signal that it is gone
        // on a POSIX host, where no Windows-shaped title ever clears it.
        !busy && t.nestedShell === "agent" ? { busy, nestedShell: undefined } : { busy },
      ),
    );
  }

  function handleDirtyChange(id: string, dirty: boolean) {
    sessionDirtyRef.current = true;
    setDirtyIds((prev) => {
      const has = prev.has(id);
      if (dirty === has) return prev;
      const next = new Set(prev);
      if (dirty) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** Sidebar navigation actually `cd`s the active shell (so it's really
   * there for the next command), but hides the injected command and its
   * echo completely - the terminal's on-screen content is untouched. `cwd`/
   * label catch up on their own next real prompt (OSC title update), same
   * as after a manually-typed `cd`. Skipped entirely while the explorer is
   * disconnected (by hand, or auto-suspended because a full-screen program
   * owns the shell) - the sidebar still moves, it just stops typing into it. */
  function browseExplorer(path: string) {
    // A chat has no shell to `cd` and no terminal explorer state: it keeps its own.
    const front = tabs.find((t) => t.id === activeTabId);
    if (front?.kind === "chat") {
      patchChatTab(front.id, { explorerPath: path });
      return;
    }
    const active = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
    // Whether the `cd` is typed, and in which shell's syntax, is decided by
    // asking the OS what's in front of the tab (see `cdShell`); alt-screen
    // `busy` is just a free early-out.
    if (explorerLinkMode === "auto" && !active?.busy) void cdShell(activeTerminalId, path);
    // `path` is whatever the explorer itself browses - for a WSL tab that's
    // the translated Windows form (see handleTitleChange).
    const posixPath = active?.nestedShell === "wsl" && active.wslDistro ? toWslPath(active.wslDistro, path) : null;
    // Round-tripped through the POSIX form so a click that lands *inside*
    // the distro's drive mounts (`...\Ubuntu\mnt` lists fine, and `c` is
    // right there in it) becomes the `C:\...` path that can actually be
    // read, rather than the share path that answers ERROR_ACCESS_DENIED -
    // exactly the rewrite `toWindowsPath` already does for a reported title.
    const browsePath =
      posixPath && active?.wslDistro ? toWindowsPath(active.wslDistro, posixPath) : path;
    setTabs((prev) =>
      patchTermTab(prev, activeTerminalId, (t) =>
        // On the new tab page the browsed folder is also where the
        // terminal will start.
        ({ explorerPath: browsePath, ...(t.newTab ? { cwd: browsePath } : {}) }),
      ),
    );
  }

  /** Types the explorer's `cd` into `tabId`'s shell, in that shell's own
   * syntax - only when the OS reports a shell actually waiting at its prompt:
   * never into a running program, never into an ssh session (whose
   * filesystem isn't this one). For WSL, `path` (the Windows/UNC form the
   * explorer browses) is translated to the distro's POSIX one, and the tab's
   * WSL tracking is aligned with what the OS reports. */
  async function cdShell(tabId: string, path: string) {
    const term = termRefs.current.get(tabId);
    const fg = await tabForeground(tabId);
    if (!term || !fg || fg.kind === "program" || fg.kind === "remote") return;
    if (fg.kind !== "wsl") {
      const kind = fg.kind;
      term.navigateSilently((rows) => cdCommand(path, kind, rows), kind !== "cmd");
      return;
    }
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const distro = fg.wsl_distro ?? tab?.wslDistro ?? (await defaultWslDistro());
    const posixPath = distro ? toWslPath(distro, path) : null;
    if (!distro || !posixPath) return;
    setTabs((prev) =>
      patchTermTab(prev, tabId, (t) => (t.nestedShell !== "wsl" || !t.wslDistro ? { nestedShell: "wsl", wslDistro: distro } : null)),
    );
    term.navigateSilently((rows) => cdCommand(posixPath, "posix", rows), true);
  }

  const activeTerminal = tabs.find((t): t is TermTab => t.id === activeTerminalId && t.kind === "terminal");
  // Popups that pick an account profile start from the terminal in front.
  // A chat in front wins over the last terminal, like in useActiveAgentSync.
  const frontChat = tabs.find((t): t is ChatTab => t.id === activeTabId && t.kind === "chat");
  const activeTerminalProfileId = frontChat ? frontChat.profileId : activeTerminal?.profileId;
  const activeTerminalKey = frontChat ? frontChat.id : activeTerminal?.id;
  useEffect(() => {
    if (activeTerminalKey) activeTabProfile.set({ tabId: activeTerminalKey, profileId: activeTerminalProfileId });
  }, [activeTerminalKey, activeTerminalProfileId]);
  // The Agents panel's "This project" scope only makes sense while a terminal
  // is in front: with Settings or the changelog showing, the last terminal's
  // folder may not even be a project open in this window - and the new tab
  // page (a terminal tab with no shell yet) isn't one either.
  // The agent CLI running in each terminal tab, for its logo and status in
  // the tab strip - matched by pty id, same as the Agents panel does.
  const tabAgentsRef = useRef(new Map<string, TabAgent>());
  const { tabAgents, sessionByTab } = useMemo(() => {
    const byTab = new Map<string, AgentSession>();
    for (const session of agentSessions ?? []) {
      const tab = tabs.find((t) => t.kind === "terminal" && termRefs.current.get(t.id)?.getPtyId() === session.pty_id);
      if (tab) byTab.set(tab.id, session);
    }
    const next = new Map<string, TabAgent>();
    for (const [id, session] of byTab) next.set(id, tabAgentOf(session));
    // Same agents as before (a title change re-runs this): keep the old Map,
    // so the notification and auto-resume hooks see no change.
    const prev = tabAgentsRef.current;
    const same =
      prev.size === next.size && [...next].every(([id, a]) => prev.get(id)?.cli === a.cli && prev.get(id)?.state === a.state);
    if (same) return { tabAgents: prev, sessionByTab: byTab };
    tabAgentsRef.current = next;
    return { tabAgents: next, sessionByTab: byTab };
  }, [agentSessions, tabs, ptyVersion]);
  // The active tab's agent, for the usage popovers' context section.
  const activeAgentSession = activeTerminal ? sessionByTab.get(activeTerminal.id) : undefined;
  useActiveAgentSync(
    activeAgentSession,
    activeTerminal?.label,
    frontChat,
    activeTerminal && { id: activeTerminal.id, cwd: activeTerminal.cwd ?? "" },
    frontChat?.delegate ? tabs.find((t): t is ChatTab => t.id === frontChat.delegate?.parentTabId && t.kind === "chat") : undefined,
  );
  useEffect(watchLimitResets, []);
  useUsageWatch(allPluginsRef, quickActionIds);
  const doneTabIds = useAgentNotifications(tabAgents, {
    getTab: (id) => latestRef.current.tabs.find((t): t is TermTab => t.id === id && t.kind === "terminal"),
    isViewing: (id) => document.hasFocus() && latestRef.current.activeTabId === id,
    lastSubmitAt: (id) => lastSubmitAt(termRefs.current.get(id)?.getPtyId()),
  });
  useAgentStateCalls(tabs, tabAgents, doneTabIds);
  const { armed: resumeArmed, cancel: cancelResume } = useAutoResume(tabAgents, {
    getTab: (id) => latestRef.current.tabs.find((t): t is TermTab => t.id === id && t.kind === "terminal"),
    getTerm: (id) => termRefs.current.get(id),
    lastSubmitAt: (id) => lastSubmitAt(termRefs.current.get(id)?.getPtyId()),
  });
  const frontTab = tabs.find((t) => t.id === activeTabId);
  const sidebarCwd = (frontTab?.kind === "chat" ? frontTab.explorerPath || frontTab.cwd : activeTerminal?.explorerPath) || homeDir;
  // The coding agent of the tab in front, if any: a chat, or a terminal with an
  // agent detected in it. Gives the sidebar its History tab. None while another PC is shown: this PC's would act here.
  const historyAgent =
    activeHost !== LOCAL_HOST
      ? undefined
      : frontTab?.kind === "chat"
      ? {
          cwd: frontTab.cwd,
          cli: frontTab.agent,
          sessionId: frontTab.sessionId,
          // A chat running in WSL: its sessions, and a new one, stay in that distro.
          wslDistro: (wslDistroOfShell(frontTab.shell) || wslDistroOfPath(frontTab.cwd)) ?? undefined,
          profileId: frontTab.profileId,
        }
      : activeTerminal && frontTab?.id === activeTerminal.id && activeAgentSession && (AGENT_CLIS as readonly string[]).includes(activeAgentSession.cli)
        ? {
            cwd: activeAgentSession.cwd ?? activeTerminal.cwd,
            cli: activeAgentSession.cli as AgentCli,
            sessionId: activeAgentSession.session_id ?? undefined,
            wslDistro: activeAgentSession.wsl_distro ?? undefined,
            profileId: activeTerminal.profileId,
          }
        : undefined;
  // The agent in front, for the sidebar's Agent tab (its own panel, not a second copy of the history source).
  const activeAgent = useActiveAgent();
  const agentMode = !!(historyAgent && historyAgent.cwd) || !!activeAgent;
  const [sidebarTab, setSidebarTab] = useSidebarTab(agentMode);
  const sidebarVisible = !sidebarCollapsed && !panelLayout.parked.sidebar;
  // The Agent action is a shortcut to the sidebar's Agent tab: it closes the sidebar only when that tab is already showing.
  const agentPinned = useAgentPanelPinned();
  const agentPopoverOpen = useAgentPopoverOpen();
  const showPinnedAgentPanel = () => {
    setSidebarTab("agent");
    if (!sidebarVisible) togglePanel("sidebar");
  };
  // Pinned: a shortcut to the sidebar's Agent tab (closes the sidebar only when that tab is already showing).
  // Not pinned: the agent's header pill popover, when the agent in front is this tab's.
  const toggleAgentTab = () => {
    if (!activeAgent) return togglePanel("sidebar");
    if (agentPinned) {
      if (sidebarVisible && sidebarTab === "agent") return togglePanel("sidebar");
      return showPinnedAgentPanel();
    }
    if (activeAgent.tabId === activeTabId) return toggleAgentPopover();
    togglePanel("sidebar");
  };
  useEffect(() => setAgentPopoverOpen(false), [activeTabId]);
  const renderAgentPanel = (onUnpin?: () => void, onPin?: () => void) => (
    <AgentInsightPanel
      onCompactChat={frontChat ? () => chatClosersRef.current.get(frontChat.paneKey ?? frontChat.id)?.compact() : undefined}
      onUnpin={onUnpin}
      onPin={onPin}
    />
  );
  const agentPanelHost: AgentPanelHost = { renderPanel: (onPin) => renderAgentPanel(undefined, onPin), showPinned: showPinnedAgentPanel };
  // The sidebar button's dot: Git changes in the folder in front while the sidebar is closed (a parked one already shows the parked dot there).
  const gitChangeCount = useGitChangeCount(sidebarCwd, !sidebarVisible);

  const terminalTabs = useMemo(() => stripTabs.filter((t): t is TermTab => t.kind === "terminal"), [stripTabs]);
  // The history lists conversations: a delegated child's tab is none of them.
  const chatTabs = useMemo(() => tabs.filter((t): t is ChatTab => t.kind === "chat" && !t.delegate), [tabs]);
  const delegateTabs = useMemo(() => tabs.filter((t): t is ChatTab => t.kind === "chat" && !!t.delegate), [tabs]);
  // A delegate's tab goes when its orchestrator's chat ends (cleared, restarted, exited, switched away): the child is closed with it.
  const tabDelegations = useAllTabDelegations();
  useEffect(() => {
    for (const id of staleDelegateTabs(delegateTabs, tabDelegations)) void closeTab(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delegateTabs, tabDelegations]);

  // The quick actions a paired phone may trigger.
  const remoteActionsKey = useMemo(
    () =>
      JSON.stringify(
        quickActionIds.flatMap((id) => {
          const plugin = allPlugins.find((p) => p.id === id);
          return plugin && isPhoneAction(plugin.action) ? [{ id, label: plugin.label, icon: plugin.icon, cli: PROFILE_CLI[id] }] : [];
        }),
      ),
    [quickActionIds, allPlugins],
  );
  const remoteLeader = useRemoteLeader();
  useEffect(() => {
    if (remoteLeader) publishRemoteActions(JSON.parse(remoteActionsKey));
  }, [remoteActionsKey, remoteLeader]);
  // A phone's quick action waits here for its tab to become the active one,
  // then runs against that render's state.
  const pendingRemoteRunRef = useRef<{ tabId: string; plugin: PluginDef } | null>(null);
  useEffect(() => {
    const pending = pendingRemoteRunRef.current;
    if (!pending || pending.tabId !== activeTabId) return;
    pendingRemoteRunRef.current = null;
    runPluginRef.current(pending.plugin);
  }, [activeTabId]);

  showPluginToastRef.current = showPluginToast;

  /** Marks a tab as owned by an about-to-launch agent CLI *before* it's
   * actually typed into the shell - see the `nestedShell: "agent"` doc
   * comment in tabs/types.ts. Set from here rather than waiting for a title
   * update to imply it, so there's no window between the launch command
   * landing and the tracking kicking in for a title update racing it to
   * claim a bogus cwd. */
  function markAgentLaunching(tabId: string) {
    setTabs((prev) => patchTermTab(prev, tabId, { nestedShell: "agent", wslDistro: undefined }));
  }

  /** The "X isn't installed" dialog, with a one-click install in a terminal. */
  async function offerCliInstall(cliBin: AgentCli) {
    const label = CLI_INFO[cliBin].label;
    const ok = await confirm({
      title: t("app.cli.notInstalled.title", { name: label }),
      message: t("app.cli.notInstalled.message", { name: label }),
      confirmLabel: t("app.cli.install"),
    });
    if (ok) openTerminalWithCommand(cliInstallCommand(cliBin, isWindowsPlatform()));
  }

  /** Before launching Claude Code / Codex / Mistral Vibe, offers a one-click install (if
   * missing) or login (if installed but signed out) in a fresh terminal
   * instead of the shortcut just quietly doing nothing useful. `check_cli_status`
   * (src-tauri/src/plugins.rs) does the actual detection. Resolves to whether
   * the CLI is ready to launch: true when it is installed and logged in, or
   * when detection itself failed (don't block the launch over it); false after
   * a dialog was shown. `profileId` is the account profile the CLI will run
   * under: its login state is the one checked, and the dedicated dialog uses
   * that same profile. */
  async function ensureCliReady(cliBin: AgentCli, profileId?: string): Promise<boolean> {
    let status: { installed: boolean; logged_in: boolean };
    try {
      status = await invoke("check_cli_status", { cli: cliBin, profile: profileId ?? null });
    } catch {
      // Detection itself failed - don't block the shortcut over it, just
      // fall back to the plain launch as before this check existed.
      return true;
    }

    if (!status.installed) {
      await offerCliInstall(cliBin);
      return false;
    }

    if (!status.logged_in) {
      return openProviderAuth(cliBin, profileId);
    }

    return true;
  }

  /** A CLI shortcut pressed in `tabId`. The project's default profile (see
   * src/profiles) decides which account the CLI should run under; a shell's
   * profile is fixed at spawn (env vars can't change on a running process),
   * so when the tab's own profile differs the CLI is started in a NEW tab
   * under the wanted one instead of being typed into this one. */
  async function checkCliAndMaybeLaunch(
    cliBin: AgentCli,
    launchCommand: string,
    term: TerminalHandle | undefined,
    tabId: string,
  ) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const wanted = tab?.cwd ? await profileForPath(tab.cwd) : null;
    // A WSL tab can't take a profile (the env vars don't reach the distro).
    // Only a project that *has* a default redirects: with none, the tab's own
    // profile (picked from the "+" menu, or a duplicated tab's) is respected.
    if (tab && wanted && tab.nestedShell !== "wsl" && wslDistroOfShell(tabShell(tab)) === undefined && wanted !== tab.profileId) {
      void launchAgentInNewTab(cliBin, tab.cwd, tabShell(tab), wanted);
      return;
    }
    // The default agent view decides how a shortcut starts the agent: as a
    // chat it gets a tab of its own. Chat is host-only, so a WSL or ssh tab
    // keeps running it in the terminal.
    if (tab && defaultOpensChat() && tab.nestedShell !== "wsl" && tab.nestedShell !== "remote" && wslDistroOfShell(tabShell(tab)) === undefined) {
      // A plain idle host shell hands its place to the chat; anything else keeps its tab.
      const idle = !tab.busy && !tab.nestedShell;
      void openChatTab(cliBin, tab.cwd, { profileId: (wanted ?? tab.profileId) ?? undefined, replaceTabId: idle ? tabId : undefined });
      return;
    }
    if (await ensureCliReady(cliBin, tab?.profileId)) await launchInTab(cliBin, launchCommand, term, tabId);
  }

  /** Opens the dedicated provider dialog under this profile (Settings > Profiles). */
  async function loginProfile(profileId: string | null, cli: AgentCli) {
    // A login command for a CLI that isn't installed would only print "command
    // not found" in the terminal - offer the install instead.
    const installed = await invoke<{ installed: boolean }>("check_cli_status", { cli, profile: profileId })
      .then((s) => s.installed)
      .catch(() => true);
    if (!installed) {
      await offerCliInstall(cli);
      return;
    }
    await openProviderAuth(cli, profileId);
  }

  remoteProfileLoginRef.current = (profileId, cli) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    void loginProfile(profileId, cli as AgentCli);
  };

  /** A profile id from the phone: "" = the default profile, an unknown id falls back to it, absent = automatic. */
  function remoteProfileId(profile: string | null | undefined): string | null | undefined {
    return profile == null ? undefined : profiles.some((p) => p.id === profile) ? profile : null;
  }

  remoteNewTabRef.current = (cwd, cli, profile) => {
    const profileId = remoteProfileId(profile);
    if (cli && (AGENT_CLIS as readonly string[]).includes(cli)) {
      const dir = cwd ?? homeDir;
      // Automatic for an agent: the folder's project default, like a shell tab gets.
      const pick = profileId !== undefined ? Promise.resolve(profileId) : profileForPath(dir);
      // The phone picks terminal or chat itself (its own default view).
      const distro = wslDistroOfPath(dir);
      void pick.then((id) => launchAgentInNewTab(cli as AgentCli, dir, distro ? wslShellId(distro) : undefined, id ?? undefined, true));
    } else addTab(cwd ?? undefined, undefined, false, profileId);
  };

  remoteResumeRef.current = (cwd, sessionId, cli, wslDistro, profile, view) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    resumeAgentSession(cwd, sessionId, cli as AgentCli, wslDistro ?? undefined, remoteProfileId(profile) ?? undefined, undefined, view);
  };

  remoteNewChatRef.current = (cwd, cli, profile) => {
    if (!(AGENT_CLIS as readonly string[]).includes(cli)) return;
    const profileId = remoteProfileId(profile);
    const dir = cwd ?? homeDir;
    const pick = profileId !== undefined ? Promise.resolve(profileId) : profileForPath(dir);
    void pick.then((id) => openChatTab(cli as AgentCli, dir, { profileId: id ?? undefined }));
  };

  remoteChatTerminalRef.current = (tabId) => {
    const tab = latestRef.current.tabs.find((t): t is ChatTab => t.id === tabId && t.kind === "chat");
    // Not mid-turn: the terminal would resume a session the agent is still writing (the desktop's own Ctrl+` refuses it too).
    if (!tab || tab.status === "busy" || tab.status === "waiting" || tab.status === "starting") return;
    // `talked === false`: nothing was said, so there is no session to resume.
    if (tab.talked === false || tab.sessionId) switchChatToTerminal(tab, tab.talked === false ? null : (tab.sessionId ?? null));
  };

  remoteTerminalChatRef.current = (ptyId) => {
    let tabId: string | undefined;
    for (const [id, h] of termRefs.current) {
      if (h.getPtyId() === ptyId) tabId = id;
    }
    if (tabId) switchTerminalToChat(tabId);
  };
  remoteChatRenameRef.current = (tabId, label) => {
    if (latestRef.current.tabs.some((t) => t.id === tabId && t.kind === "chat")) renameTab(tabId, label);
  };
  remoteChatCloseRef.current = (tabId) => {
    // Closing the window's last tab would close the window: not from afar.
    if (latestRef.current.tabs.length > 1 && latestRef.current.tabs.some((t) => t.id === tabId && t.kind === "chat")) void closeTab(tabId);
  };

  /** Starts `cli` in a NEW tab opened in `cwd` (the Agents panel's "+" menu: the
   * project folder). `shell` is the shell the
   * project's own tab runs. Uses the CLI plugin's command, which may carry the
   * user's flags. A WSL shell runs the distro's own CLI, so it skips the host
   * install check and the host-only flags, like `openAgentSession`. The new
   * tab runs under account profile `profileId` (default profile when
   * omitted) - ignored for WSL, where the env vars don't reach. Resolves to
   * whether the tab was opened (the CLI may be missing or signed out). Opens as
   * a chat tab when that is the default agent view (Settings > Agents), unless
   * `forceTerminal`. `at` is the strip index a plain (no `shell`) terminal tab
   * takes instead of the end. */
  async function launchAgentInNewTab(cli: AgentCli, cwd: string, shell?: string, profileId?: string, forceTerminal = false, at?: number): Promise<boolean> {
    let command = allPlugins.find((p) => cliOfPlugin(p.id) === cli)?.command ?? cli;
    if (wslDistroOfShell(shell) !== undefined) {
      const id = addTab(cwd, shell);
      pendingCommandsRef.current.set(id, command);
      return true;
    }
    // Opens in the default agent view; chat is host-only, so a WSL shell (above) never gets it.
    if (!forceTerminal && defaultOpensChat()) return openChatTab(cli, cwd, { profileId });
    if (!(await ensureCliReady(cli, profileId))) return false;
    if (cli === "vibe") await invoke("vibe_ensure_model", { profile: profileId ?? null }).catch(() => {});
    if (cli === "codex") command = await withCodexLaunchFlags(command);
    if (shell) {
      // addTab also activates the new tab.
      const id = addTab(cwd, shell, false, profileId ?? null);
      pendingCommandsRef.current.set(id, command);
      return true;
    }
    const id = newTabId("tab");
    pendingCommandsRef.current.set(id, command);
    setTabs((prev) => insertTabAt(prev, makeTermTab(id, cwd, { profileId }), at));
    setActiveTabId(id);
    setActiveTerminalId(id);
    return true;
  }

  /** An agent picked on the new tab page: it starts in a new tab (see
   * `launchAgentInNewTab`) that takes the page's place, in its folder and
   * under its account profile (the folder's own project default, when the pick points elsewhere). The page stays if the agent can't start. */
  async function launchAgentFromNewTab(tabId: string, cli: AgentCli, cwd?: string, shell?: string) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    if (!tab?.newTab) return;
    const startDir = cwd || tab.cwd || homeDir;
    // A folder other than the one the page showed (a recent, a favorite, a
    // folder found by search) may have its own project default profile -
    // unless the profile was picked on purpose (as `launchFromNewTab` does).
    const wsl = !!wslDistroOfPath(startDir) || wslDistroOfShell(shell) !== undefined;
    const lookup = !wsl && !!cwd && cwd !== tab.cwd && !explicitProfileRef.current.has(tabId);
    const profile = lookup ? ((await automaticProfile(tabId, startDir, false)) ?? tab.profileId) : tab.profileId;
    if (!(await launchAgentInNewTab(cli, startDir, shell, profile))) return;
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
    forgetTab(tabId);
    setActiveTerminalId((active) => (active === tabId ? (latestRef.current.tabs.find((t) => t.kind === "terminal" && t.id !== tabId)?.id ?? "") : active));
  }

  /** Opens `cli` as a chat tab in `cwd` (the host file system), after the same
   * install/login check a terminal launch does. With `resume`, the tab resumes
   * that session (and takes its label) instead of starting a new one.
   * `replaceTabId` makes the chat take that terminal's place in the strip and
   * closes the terminal - only once the CLI is ready, so it stays otherwise;
   * `at` is the strip index to open at instead of the end. */
  async function openChatTab(
    cli: AgentCli,
    cwd: string,
    opts: { profileId?: string; viewId?: string; resume?: { sessionId: string; label?: string; handoffFrom?: string; lastActiveAt?: number }; replaceTabId?: string; at?: number; shell?: string; label?: string; diagnosis?: ChatDiagnosis; firstPrompt?: string; background?: boolean; onCreated?: (tabId: string) => void } = {},
  ): Promise<boolean> {
    const { profileId, viewId, resume, replaceTabId, at, shell, label, diagnosis, firstPrompt, background, onCreated } = opts;
    const inWsl = !!wslDistroOfPath(cwd) || wslDistroOfShell(shell) !== undefined;
    if (!inWsl && !(await ensureCliReady(cli, profileId))) return false;
    if (!inWsl && cli === "vibe") await invoke("vibe_ensure_model", { profile: profileId ?? null }).catch(() => {});
    const id = newTabId("chat");
    const tab: ChatTab = { kind: "chat", id, agent: cli, cwd, label: resume?.label ?? label ?? (basename(cwd) || CLI_INFO[cli].name), profileId, viewId: viewId ?? (defaultOpensChat() ? defaultAgentView() : undefined), shell: shell ?? getConfiguredShell(), sessionId: resume?.sessionId, handoffFrom: resume?.handoffFrom, talked: resume ? undefined : false, lastActiveAt: resume?.lastActiveAt, diagnosis, firstPrompt };
    setTabs((prev) => {
      const next = insertTabAt(prev, tab, replaceTabId ? prev.findIndex((t) => t.id === replaceTabId) : at);
      return replaceTabId ? next.filter((t) => t.id !== replaceTabId) : next;
    });
    // `background`: the tab opens behind the one in front (the browser's toast offers the way to it).
    if (!background) setActiveTabId(id);
    if (replaceTabId) dropTerminal(replaceTabId);
    onCreated?.(id);
    return true;
  }

  /** The folder (and shell) a chat or terminal opened for the browser starts in: the tab the page belongs to (the
   * terminal that printed its dev server, or the one it was opened for), else the tab in front, else the home. */
  function browserHintFolder(hintTabId?: string): { cwd: string; shell?: string } {
    const { tabs: all, activeTabId: front } = latestRef.current;
    const pick = (id: string | undefined) => {
      const tab = all.find((x) => x.id === id);
      if (tab?.kind === "terminal" && tab.cwd && !tab.newTab) return { cwd: tab.cwd, shell: tabShell(tab) };
      if (tab?.kind === "chat" && tab.cwd) return { cwd: tab.cwd, shell: tab.shell };
      return null;
    };
    return pick(hintTabId) ?? pick(front) ?? { cwd: homeDir };
  }

  /** Bookkeeping after a terminal tab left the strip: its handles, and the
   * active terminal when it was that one. */
  function dropTerminal(terminalId: string) {
    forgetTab(terminalId);
    setActiveTerminalId((active) => (active === terminalId ? (latestRef.current.tabs.find((t) => t.kind === "terminal" && t.id !== terminalId)?.id ?? "") : active));
  }

  /** Opens the chat of a task `parentTabId`'s agent delegated, in a tab next to its orchestrator's (and the ones of its other
   * delegates). The tab attaches to the child's running chat; opening the same task again brings its tab to the front. */
  function openDelegateTab(parentTabId: string, delegate: DelegateInfo, wslDistro: string | null) {
    const { tabs: all } = latestRef.current;
    const open = all.find((t) => t.kind === "chat" && t.delegate?.taskId === delegate.taskId);
    if (open) {
      setActiveTabId(open.id);
      return;
    }
    const found = all.find((t) => t.id === parentTabId);
    // The orchestrator is a chat or a terminal tab (whose agent delegated through Flowcode's MCP tools).
    const parent: DelegateParent | null =
      found?.kind === "chat"
        ? { id: found.id, cwd: found.cwd, shell: found.shell, profileId: found.profileId, agent: found.agent }
        : found?.kind === "terminal"
          ? { id: found.id, cwd: found.cwd, shell: tabShell(found) ?? "host", profileId: undefined, agent: null }
          : null;
    if (!parent) return;
    const known = (AGENT_CLIS as readonly string[]).includes(delegate.agent) ? (delegate.agent as AgentCli) : parent.agent;
    if (!known) return;
    const agent: AgentCli = known;
    // A finished child may be one the backend already let go (it keeps only the last few): a tab would attach to
    // nothing, so its saved conversation resumes as a chat instead.
    const sessionId = delegate.childSessionId;
    if (sessionId && delegate.status !== "running" && delegate.status !== "waiting_for_user") {
      void invoke("chat_events", { chatId: delegate.childChatId, afterSeq: Number.MAX_SAFE_INTEGER }).then(
        () => attachDelegateTab(parent, delegate, agent, wslDistro),
        () => {
          const holder = tabWithSession(sessionId);
          if (holder) openHistoryTab(holder.id, holder.kind === "chat" ? sessionId : undefined);
          else void openChatTab(agent, parent.cwd, { profileId: agent === parent.agent ? parent.profileId : undefined, shell: parent.shell, resume: { sessionId, label: delegate.title || undefined } });
        },
      );
      return;
    }
    attachDelegateTab(parent, delegate, agent, wslDistro);
  }

  /** The tab of `openDelegateTab`, attached to the child's running chat. */
  function attachDelegateTab(parent: DelegateParent, delegate: DelegateInfo, agent: AgentCli, wslDistro: string | null) {
    const parentTabId = parent.id;
    const { tabs: all } = latestRef.current;
    // Asked twice while the check above ran: one tab.
    const open = all.find((t) => t.kind === "chat" && t.delegate?.taskId === delegate.taskId);
    if (open) {
      setActiveTabId(open.id);
      return;
    }
    const id = newTabId("chat");
    const tab: ChatTab = {
      kind: "chat",
      id,
      agent,
      cwd: parent.cwd,
      label: delegate.title || CLI_INFO[agent].name,
      profileId: parent.profileId,
      shell: parent.shell,
      delegate: { chatId: delegate.childChatId, taskId: delegate.taskId, parentTabId, wslDistro },
    };
    // After the orchestrator and the delegate tabs already open next to it.
    const last = all.reduce((at, t, i) => (t.id === parentTabId || (t.kind === "chat" && t.delegate?.parentTabId === parentTabId) ? i : at), -1);
    setTabs((prev) => insertTabAt(prev, tab, last + 1 || undefined));
    setActiveTabId(id);
  }

  /** Patches a chat tab's fields as its view reports them. */
  function patchChatTab(id: string, patch: Partial<ChatTab>) {
    setTabs((prev) => patchChatTabIn(prev, id, patch));
  }

  /** Patches one conversation of a chat tab: the shown one lives on the tab, a parked one in `parked`. */
  function patchChatPane(tabId: string, paneKey: string, patch: Partial<ChatPane>) {
    setTabs((prev) => patchChatPaneIn(prev, tabId, paneKey, patch));
  }

  /** Shows `sessionId` in chat tab `tabId`: a parked conversation of it is swapped in, otherwise a new one
   * starts resuming it. */
  function showChatSession(tabId: string, sessionId: string, lastActiveAt?: number) {
    setTabs((prev) => showChatSessionIn(prev, tabId, sessionId, lastActiveAt));
  }

  /** Starts a fresh conversation in chat tab `tabId`, beside the one shown (which keeps running in the background). */
  function newChatPane(tabId: string) {
    setTabs((prev) => newChatPaneIn(prev, tabId));
  }

  /** A History row open in a tab was picked: the tab comes forward, showing that conversation if it is a parked one. */
  function openHistoryTab(tabId: string, sessionId?: string) {
    if (sessionId) showChatSession(tabId, sessionId);
    selectTab(tabId);
  }

  /** Ctrl+` in a chat: closes the chat (its view's unmount kills the agent, so
   * the session is free) and resumes that session in a terminal tab at the
   * chat's place. A null `sessionId` (no prompt sent yet: nothing on disk to
   * resume) starts a fresh agent there instead, and the chat stays if it
   * can't start. */
  function switchChatToTerminal(tab: ChatTab, sessionId: string | null, chatDistro?: string | null) {
    // Conversations parked in the background that are mid-turn end with the chat.
    const working = (latestRef.current.tabs.find((t): t is ChatTab => t.id === tab.id && t.kind === "chat")?.parked ?? []).filter((p) => p.status === "busy" || p.status === "waiting").length;
    if (working === 0) {
      doSwitchChatToTerminal(tab, sessionId, chatDistro);
      return;
    }
    void confirm({
      title: t("app.parkedBusy.title"),
      message: t("app.parkedBusy.message", { count: working }),
      confirmLabel: t("app.parkedBusy.confirm"),
      danger: true,
    }).then((ok) => {
      if (ok) doSwitchChatToTerminal(tab, sessionId, chatDistro);
    });
  }

  function doSwitchChatToTerminal(tab: ChatTab, sessionId: string | null, chatDistro?: string | null) {
    // A chat running in WSL keeps its sessions in the distro: the terminal is a WSL one there too.
    const distro = chatDistro || wslDistroOfShell(tab.shell) || null;
    const index = latestRef.current.tabs.findIndex((t) => t.id === tab.id);
    const at = index < 0 ? undefined : index;
    const dropChat = () => {
      setTabs((prev) => prev.filter((t) => t.id !== tab.id));
      forgetTab(tab.id);
    };
    // An id `openAgentSession` would refuse: the chat stays as it is rather than closing for nothing.
    if (sessionId && !isSafeSessionId(sessionId)) {
      console.warn("refusing to resume a session with an unexpected id", JSON.stringify(sessionId));
      return;
    }
    if (sessionId) {
      // The chat's agent is killed first and waited for: two processes must never share one session.
      // The tab stays in place meanwhile, so the terminal still takes its spot.
      // A second Ctrl+` while the first waits must not open a second terminal.
      if (switchingChatsRef.current.has(tab.id)) return;
      switchingChatsRef.current.add(tab.id);
      const closer = chatClosersRef.current.get(tab.paneKey ?? tab.id);
      void (async () => {
        try {
          await closer?.close();
          // A session with no transcript on disk (the only prompt failed before it was saved) can't be resumed:
          // `claude --resume` / `codex resume` would just say it isn't found, so a fresh agent starts instead.
          // Not checked for WSL: its transcripts are in the distro, out of this check's reach (the chat was used, so it has one).
          const saved = distro ? true : await invoke<boolean>("agent_session_saved", { cli: tab.agent, sessionId, profile: tab.profileId ?? null }).catch(() => true);
          if (saved) {
            dropChat();
            await openAgentSession(distro ? (toWslPath(distro, tab.cwd) ?? tab.cwd) : tab.cwd, sessionId, tab.agent, distro ?? undefined, tab.profileId, at);
          } else if (await launchAgentInNewTab(tab.agent, tab.cwd, undefined, tab.profileId, true, at)) {
            dropChat();
          } else {
            // The chat's agent is gone and no terminal took over: the chat starts again.
            closer?.restart();
          }
        } finally {
          switchingChatsRef.current.delete(tab.id);
        }
      })();
      return;
    }
    // The chat's agent ends first (two Codex processes starting together trip over their state store); the fresh terminal then
    // goes in front of the chat, which closes.
    if (switchingChatsRef.current.has(tab.id)) return;
    switchingChatsRef.current.add(tab.id);
    const freshCloser = chatClosersRef.current.get(tab.paneKey ?? tab.id);
    void (async () => {
      try {
        await freshCloser?.close();
        if (await launchAgentInNewTab(tab.agent, tab.cwd, distro ? wslShellId(distro) : undefined, tab.profileId, true, at)) dropChat();
        else freshCloser?.restart();
      } finally {
        switchingChatsRef.current.delete(tab.id);
      }
    })();
  }

  /** The reverse of `switchChatToTerminal`: resumes the session in a chat tab.
   * The terminal's agent is ended first and waited for (two processes must
   * never share one session); the terminal tab stays, at its shell prompt,
   * until the chat has loaded (`finishHandoff`) and closes it. If the chat
   * can't, the session is resumed back in that terminal. Only host agents
   * whose session id is known, and not while the agent is busy. */
  function switchTerminalToChat(tabId: string, viewId?: string) {
    const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
    const session = sessionByTab.get(tabId);
    if (!tab || !session || session.status === "busy" || session.wsl_distro || !(AGENT_CLIS as readonly string[]).includes(session.cli)) return;
    // A second trigger while the agent is still being ended must not open a second chat.
    if (switchingChatsRef.current.has(tabId)) return;
    switchingChatsRef.current.add(tabId);
    const cli = session.cli as AgentCli;
    const sessionId = session.session_id;
    void (async () => {
      try {
        // An agent nobody prompted yet has no transcript to load (the chat would fail and the terminal be
        // sent back to a `--resume` that finds nothing): a fresh chat takes the terminal's place instead.
        // Codex has no thread at all until its first prompt: nothing to resume either.
        const saved = sessionId ? await invoke<boolean>("agent_session_saved", { cli, sessionId, profile: tab.profileId ?? session.profile ?? null }).catch(() => true) : false;
        if (!saved || !sessionId) {
          const at = latestRef.current.tabs.findIndex((t) => t.id === tabId);
          await openChatTab(cli, session.cwd ?? tab.cwd, { profileId: tab.profileId ?? session.profile ?? undefined, viewId, replaceTabId: tabId, shell: "host", at: at < 0 ? undefined : at });
          return;
        }
        // The terminal's agent was just in use.
        const resume = { sessionId, label: tab.label, handoffFrom: tabId, lastActiveAt: Date.now() };
        const ptyId = termRefs.current.get(tabId)?.getPtyId();
        if (ptyId) await invoke("end_pty_agent", { ptyId }).catch(() => {});
        // Opens at the terminal's index, so the chat sits where the terminal was once that closes.
        const at = latestRef.current.tabs.findIndex((t) => t.id === tabId);
        const opened = await openChatTab(cli, session.cwd ?? tab.cwd, { profileId: tab.profileId ?? session.profile ?? undefined, viewId, resume, shell: "host", at: at < 0 ? undefined : at });
        if (!opened) resumeInTerminal(tabId, cli, sessionId);
      } finally {
        switchingChatsRef.current.delete(tabId);
      }
    })();
  }

  /** Resumes `sessionId` again in terminal tab `tabId`, whose agent a handoff ended: the shell is back at its prompt. */
  function resumeInTerminal(tabId: string, cli: AgentCli, sessionId: string) {
    void resumeCommand(cli, sessionId, true, (latestRef.current.tabs.find((t) => t.id === tabId && t.kind === "terminal") as TermTab | undefined)?.profileId ?? undefined).then((command) => termRefs.current.get(tabId)?.runCommandSilently(command));
  }

  /** The chat resumed the session: the terminal it took over closes. */
  function finishHandoff(chatId: string, terminalId: string) {
    patchChatTab(chatId, { handoffFrom: undefined });
    setTabs((prev) => prev.filter((t) => t.id !== terminalId));
    dropTerminal(terminalId);
  }

  /** The chat couldn't resume the session: it goes away and the terminal resumes it again. */
  function failHandoff(chatId: string, error?: string | null) {
    const chat = latestRef.current.tabs.find((t): t is ChatTab => t.id === chatId && t.kind === "chat");
    const terminalId = chat?.handoffFrom;
    setTabs((prev) => prev.filter((t) => t.id !== chatId));
    forgetTab(chatId);
    if (terminalId && latestRef.current.tabs.some((t) => t.id === terminalId)) {
      setActiveTabId(terminalId);
      // The terminal's agent was ended for the handoff: it gets its session back.
      if (chat.sessionId && isSafeSessionId(chat.sessionId)) resumeInTerminal(terminalId, chat.agent, chat.sessionId);
    }
    // Why, when the agent said (Codex: the session is still in use elsewhere): not a silent failure.
    const detail = (error ?? "").replace(/^`[^`]*`:\s*/, "").replace(/^[a-z_]+:\s*/, "").trim().slice(0, 200);
    showPluginToast(detail ? `${t("agents.handoff.failed")} ${detail}` : t("agents.handoff.failed"));
  }


  /** Types the CLI's launch command into `tabId` when a shell is at its
   * prompt there, or runs it in a new tab alongside when something else
   * already owns that tab's input (see `runInTabLike`). */
  async function launchInTab(cliBin: AgentCli, launchCommand: string, term: TerminalHandle | undefined, tabId: string) {
    const fg = await tabForeground(tabId);
    // Mistral Large 4 isn't one of Vibe's own models yet: registered in its
    // config (and made the default, unless the user picked another) before
    // each launch - a no-op once it's there. This host's Vibe only, same as
    // the Codex flags below. Never in the way of the launch itself.
    if (cliBin === "vibe" && fg?.kind !== "wsl" && fg?.kind !== "remote") {
      const tab = latestRef.current.tabs.find((t): t is TermTab => t.id === tabId && t.kind === "terminal");
      await invoke("vibe_ensure_model", { profile: tab?.profileId ?? null }).catch(() => {});
    }
    // Codex on Windows runs with `--no-daemon`, or its background server pops
    // a console window per helper - see plugins/codexLaunch.ts. That's this
    // host's own codex: not one inside WSL or across ssh.
    const hostCodex = cliBin === "codex" && fg?.kind !== "wsl" && fg?.kind !== "remote";
    const command = hostCodex ? await withCodexLaunchFlags(launchCommand) : launchCommand;
    if (fg && !atShellPrompt(fg)) {
      markAgentLaunching(runInTabLike(tabId, command));
      return;
    }
    markAgentLaunching(tabId);
    term?.runCommandSilently(command);
  }

  /** Runs the one thing a plugin (or a dialog-plugin's button) is allowed to
   * do - see PLUGINS.md at the repo root for why this stays a fixed, safe
   * vocabulary instead of arbitrary code. */
  function runPlugin(plugin: PluginDef | PluginButtonDef) {
    const command = plugin.action === "runCommand" || plugin.action === "commandOutput" ? plugin.command : undefined;
    // A plugin is a file anyone can drop in the plugins folder (or send): its
    // command is shown and confirmed before the first run, not just typed.
    // The app's own plugins - built in, or an unedited shipped example - are
    // trusted.
    const shipped = "id" in plugin ? examplePlugins().find((p) => p.id === plugin.id) : undefined;
    const trusted =
      !command ||
      ("builtin" in plugin && !!plugin.builtin) ||
      (!!shipped && shipped.action === plugin.action && shipped.command === command);
    if (trusted) {
      runPluginAction(plugin);
      return;
    }
    // A dialog's button belongs to the dialog plugin that is open.
    const owner = "id" in plugin ? plugin.id : (pluginDialog?.id ?? "");
    const approvalKey = `${owner}:${commandStamp(command)}`;
    const approved = readJson(PLUGIN_APPROVALS_KEY, isStringArray, []);
    if (approved.includes(approvalKey)) {
      runPluginAction(plugin);
      return;
    }
    void confirm({
      title: t("plugin.confirmRun.title"),
      message: t("plugin.confirmRun.message", { name: "id" in plugin ? plugin.label : (pluginDialog?.label ?? plugin.label), command }),
      confirmLabel: t("plugin.confirmRun.confirm"),
    }).then((ok) => {
      if (!ok) return;
      writeJson(PLUGIN_APPROVALS_KEY, [...readJson(PLUGIN_APPROVALS_KEY, isStringArray, []), approvalKey]);
      runPluginAction(plugin);
    });
  }

  function runPluginAction(plugin: PluginDef | PluginButtonDef) {
    switch (plugin.action) {
      case "newTerminal":
        openNewTab();
        break;
      case "clearTerminal":
        activeTermHandle()?.clear();
        break;
      case "toggleSidebar":
        togglePanel("sidebar");
        break;
      case "toggleAgentsSidebar":
        toggleAgentTab();
        break;
      case "toggleBrowser":
        togglePanel("browser");
        break;
      case "runCommand": {
        if (!plugin.command) break;
        const term = termRefs.current.get(activeTerminalId);
        // Claude Code / Codex CLI / Mistral Vibe take over the whole screen the moment
        // they start - unlike an arbitrary user-defined runCommand plugin,
        // there's no reason to leave the typed launch command sitting in
        // the scrollback above their UI. They're also the only plugins with
        // a known CLI binary behind them, which is what makes the
        // install/login pre-check possible - a plain runCommand plugin has
        // no such notion and always just runs.
        const cliBin = "id" in plugin ? cliOfPlugin(plugin.id) : undefined;
        if (cliBin) {
          checkCliAndMaybeLaunch(cliBin, plugin.command, term, activeTerminalId);
        } else {
          const tabId = activeTerminalId;
          const command = plugin.command;
          void tabForeground(tabId).then((fg) => {
            if (fg && !atShellPrompt(fg)) runInTabLike(tabId, command);
            else term?.runCommand(command);
          });
        }
        break;
      }
      case "notify":
        showPluginToast(plugin.message || plugin.label);
        break;
      case "dialog":
        // Only a top-level PluginDef can carry `action: "dialog"` - a
        // button's action type deliberately excludes it (dialogs don't nest).
        setPluginDialog(plugin as PluginDef);
        break;
      case "commandOutput":
        if (!plugin.command) break;
        // The backend resolves the command from the installed manifest: only the plugin id (and a dialog button's index) goes over.
        invoke<string>("run_plugin_command", {
          pluginId: "id" in plugin ? plugin.id : (pluginDialog?.id ?? ""),
          button: "id" in plugin ? null : (pluginDialog?.buttons?.indexOf(plugin as PluginButtonDef) ?? -1),
        })
          .then((output) => setPluginDialog({ id: "__result", label: plugin.label, action: "dialog", title: plugin.label, message: output }))
          .catch((err) =>
            setPluginDialog({ id: "__result", label: plugin.label, action: "dialog", title: plugin.label, message: String(err) }),
          );
        break;
      case "openInVsCode":
        void openInVsCode();
        break;
    }
  }

  /** The "Apri in VS Code" feature: the active terminal's folder (or the
   * one the explorer is on, before the shell has reported any). A folder
   * inside WSL opens through VS Code's WSL remote, by its Linux path. */
  async function openInVsCode() {
    const tab = activeTerminal;
    if (tab?.nestedShell === "remote") {
      showPluginToast(t("plugin.openInVsCode.remote"));
      return;
    }
    const folder = tab?.cwd || tab?.explorerPath || "";
    if (!folder) {
      showPluginToast(t("plugin.openInVsCode.noFolder"));
      return;
    }
    const distro = wslDistroOfPath(folder);
    const posix = distro ? toWslPath(distro, folder) : null;
    try {
      await invoke("open_in_vscode", { folder: posix ?? folder, wslDistro: posix ? distro : null });
    } catch (e) {
      showPluginToast(
        String(e) === "vscode-not-found"
          ? t("plugin.openInVsCode.notInstalled")
          : t("app.openFailed", { name: "VS Code", error: String(e) }),
      );
    }
  }

  function pluginMenuEntries() {
    return allPlugins.map((p) => ({
      id: p.id,
      label: p.label,
      agent: cliOfPlugin(p.id) !== undefined,
      icon: pluginIconNode(p),
      detail: p.description || (p.builtin ? t("features.builtin") : undefined),
      pinned: quickActionIds.includes(p.id),
      run: () => runPlugin(p),
      onTogglePin: () => toggleQuickAction(p.id),
    }));
  }

  // The side panel is contextual to whatever tab is active: the file
  // explorer for a terminal, a jump-to-function outline for a code file,
  // a section index for the settings page, the version list for the
  // changelog and What's new - falling back to the explorer otherwise, since that's the
  // most broadly useful default.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  let sidebarPanel: ReactNode;
  if (activeHost !== LOCAL_HOST) {
    // Another PC in front: its history and folders, never this PC's.
    sidebarPanel = <RemoteSidebar key={activeHost} hostId={activeHost} />;
  } else if (activeTab?.kind === "settings") {
    sidebarPanel = <SettingsNav />;
  } else if (activeTab?.kind === "changelog") {
    sidebarPanel = <ChangelogNav view="changelog" />;
  } else if (activeTab?.kind === "whatsNew") {
    sidebarPanel = <ChangelogNav view="whatsNew" defaultVersion={activeTab.version} />;
  } else if (activeTab?.kind === "editor") {
    const editorTab: EditorTab = activeTab;
    sidebarPanel = (
      <SymbolOutline
        key={editorTab.id}
        label={editorTab.label}
        getContent={() => editorRefs.current.get(editorTab.id)?.getContent() ?? ""}
        onJump={(line) => editorRefs.current.get(editorTab.id)?.scrollToLine(line)}
      />
    );
  } else {
    sidebarPanel = (
      <Sidebar
        cwd={sidebarCwd}
        tab={sidebarTab}
        onTabChange={setSidebarTab}
        agent={
          activeAgent && agentPinned ? renderAgentPanel(() => setAgentPanelPinned(false)) : undefined
        }
        onNavigate={browseExplorer}
        onGoHome={() =>
          void resolveStartDir(activeTerminal ? (tabShell(activeTerminal) ?? shellId) : shellId).then(browseExplorer)
        }
        onOpenFile={openFile}
        onOpenDiff={openDiff}
        onOpenTerminal={(path) => addTab(path, activeTerminal ? tabShell(activeTerminal) : undefined)}
        shell={activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined}
        linkMode={explorerLinkMode}
        onSetLinkMode={setExplorerLinkMode}
        terminalBusy={frontTab?.kind === "chat" ? false : (activeTerminal?.busy ?? false)}
        history={
          historyAgent && historyAgent.cwd
            ? (visible) => (
                <AgentHistoryPanel
                  projectCwd={historyAgent.cwd}
                  wslDistro={historyAgent.wslDistro}
                  currentSessionId={historyAgent.sessionId}
                  currentCli={historyAgent.cli}
                  visible={visible}
                  sessions={agentSessions}
                  tabs={terminalTabs}
                  chatTabs={chatTabs}
                  delegateTabs={delegateTabs}
                  getPtyId={(id) => termRefs.current.get(id)?.getPtyId() ?? null}
                  onOpenTab={openHistoryTab}
                  onResume={resumeAgentSession}
                  onOpenDelegate={openDelegateTab}
                  currentProfileId={historyAgent.profileId}
                  onNewSession={(cli, cwd, profileId) => {
                    // An idle chat in front starts its new conversation in place, like "/clear" -
                    // unless another agent or profile was picked.
                    const same = cli === historyAgent.cli && profileId === historyAgent.profileId;
                    // A delegate's tab is attached to its child: never cleared from here.
                    const chat = same && frontTab?.kind === "chat" && !frontTab.delegate ? frontTab : undefined;
                    const closer = chat && chatClosersRef.current.get(chat.paneKey ?? chat.id);
                    // Mid-turn it must not end: it goes on in the background, found again in the History.
                    if (closer && (chat.status === "busy" || chat.status === "waiting")) newChatPane(chat.id);
                    else if (closer) closer.clear();
                    // Otherwise a new tab, of the same kind as the one the History is shown for: a chat's opens a chat
                    // (in the same shell, so a WSL chat stays in its distro), a terminal's a terminal.
                    else if (frontTab?.kind === "chat") void openChatTab(cli, cwd, { profileId, shell: frontTab.shell });
                    // A WSL agent's new session stays in its distro (its cwd is a Linux path).
                    else void launchAgentInNewTab(cli, cwd, historyAgent.wslDistro ? wslShellId(historyAgent.wslDistro) : undefined, profileId, true);
                  }}
                />
              )
            : undefined
        }
      />
    );
  }

  const themeModeLabels: Record<ThemeMode, string> = {
    auto: t("theme.auto"),
    light: t("theme.light"),
    dark: t("theme.dark"),
  };

  function moreMenuItems(): ContextMenuItem[] {
    return [
      {
        label: "zoom-row",
        custom: <ZoomRow tabId={activeTerminalId} />,
      },
      { separator: true, label: "sep-zoom" },
      { label: t("menu.newTerminal"), icon: Icons.newTerminal, onSelect: () => openNewTab() },
      ...(noPairedHosts
        ? [{ label: t("remoteHosts.connectAnother"), icon: <MonitorIcon size={14} />, onSelect: () => setPairingHost(true) }]
        : [{ label: t("remoteHosts.switchPc"), icon: <MonitorIcon size={14} />, onSelect: openHostMenu }]),
      {
        label: isFullscreen ? t("menu.exitFullscreen") : t("menu.fullscreen"),
        icon: isFullscreen ? Icons.fullscreenExit : Icons.fullscreen,
        onSelect: toggleFullscreen,
      },
      {
        label: t("favorites.title"),
        icon: <StarIcon />,
        submenu: [
          favoritesMenuItem({
            activeCwd: activeTerminal && !activeTerminal.busy ? activeTerminal.cwd || undefined : undefined,
            activeShell: activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined,
            onOpenFolder: openFavorite,
            hide: hideMenu,
          }),
        ],
      },
      { separator: true, label: "sep-actions" },
      {
        label: t("menu.theme"),
        icon: mode === "auto" ? Icons.themeAuto : mode === "light" ? Icons.sun : Icons.moon,
        submenu: (["auto", "light", "dark"] as ThemeMode[]).map((m) => ({
          label: themeModeLabels[m],
          icon: m === "auto" ? Icons.themeAuto : m === "light" ? Icons.sun : Icons.moon,
          checked: mode === m,
          onSelect: () => setMode(m),
        })),
      },
      { separator: true, label: "sep-theme" },
      { label: t("changelog.title"), icon: Icons.changelog, onSelect: openChangelog },
      { label: t("shortcuts.title"), icon: Icons.keyboard, onSelect: () => setShortcutsDialogOpen(true) },
      { label: t("settings.title"), icon: Icons.settings, onSelect: openSettings },
    ];
  }

  allPluginsRef.current = allPlugins;
  runPluginRef.current = runPlugin;
  remoteRenameRef.current = (ptyId, label) => {
    let tabId: string | undefined;
    for (const [id, h] of termRefs.current) {
      if (h.getPtyId() === ptyId) tabId = id;
    }
    if (tabId) renameTab(tabId, label);
  };
  remoteTabOpRef.current = (target, op) => {
    let tabId = target.tabId;
    if (target.ptyId) {
      for (const [id, h] of termRefs.current) {
        if (h.getPtyId() === target.ptyId) tabId = id;
      }
    }
    const tab = tabId ? latestRef.current.tabs.find((t) => t.id === tabId) : undefined;
    if (!tab || (tab.kind !== "terminal" && tab.kind !== "chat")) return;
    if (op.kind === "duplicate") {
      // Same rule as the tab menu: a delegated child's view has no agent of its own to start again.
      if (tab.kind === "terminal" || !tab.delegate) duplicateTab(tab.id);
    } else if (op.kind === "notify") {
      if (tab.kind === "terminal" && !!tab.notifyMuted === op.on) toggleTabNotifications(tab.id);
    } else if (op.kind === "move") {
      // `index` counts the strip's listed tabs; reorderTab works on all of them.
      const strip = listedTabs(latestRef.current.tabs);
      const dest = strip[Math.min(op.index, strip.length - 1)];
      const to = dest ? latestRef.current.tabs.findIndex((t) => t.id === dest.id) : -1;
      if (to !== -1) reorderTab(tab.id, to);
    }
  };
  remoteCloseRef.current = (ptyId) => {
    let tabId: string | undefined;
    for (const [id, h] of termRefs.current) {
      if (h.getPtyId() === ptyId) tabId = id;
    }
    // Closing the window's last tab would close the window: not from a phone.
    if (tabId && latestRef.current.tabs.length > 1) void closeTab(tabId);
  };
  remoteActionRef.current = (id, ptyId) => {
    const plugin = quickActionIds.includes(id) ? allPlugins.find((p) => p.id === id) : undefined;
    if (!plugin || !isPhoneAction(plugin.action)) return;
    // Plugins act on the active tab: bring the phone's tab forward first and
    // run once the re-render has made it the active one.
    let tabId: string | undefined;
    if (ptyId) {
      for (const [id, h] of termRefs.current) {
        if (h.getPtyId() === ptyId) tabId = id;
      }
    }
    if (tabId && tabId !== latestRef.current.activeTabId) {
      pendingRemoteRunRef.current = { tabId, plugin };
      selectTabRef.current(tabId);
      // If the tab never comes forward, don't run it later on a surprise tab.
      setTimeout(() => {
        if (pendingRemoteRunRef.current?.plugin === plugin) pendingRemoteRunRef.current = null;
      }, 2000);
    } else {
      runPlugin(plugin);
    }
  };

  // The header's panel toggles and tools: in the header when wide, on a row of their own below the terminal when narrow.
  const sidebarToggle = (
    <button
      className={"icon-button" + (!sidebarCollapsed ? " is-active" : "") + (panelLayout.parked.sidebar ? " is-parked" : "")}
      aria-pressed={!sidebarCollapsed}
      onClick={() => togglePanel("sidebar")}
      onContextMenu={(e) =>
        openMenu(
          e,
          (
            [
              ["auto", t("sidebarMode.auto")],
              ["docked", t("sidebarMode.docked")],
              ["floating", t("sidebarMode.floating")],
            ] as [SidebarMode, string][]
          ).map(([m, label]) => ({
            label,
            icon: m === "auto" ? MenuIcons.sidebarAuto : m === "docked" ? MenuIcons.sidebarDocked : MenuIcons.sidebarFloating,
            checked: sidebarMode === m,
            onSelect: () => setSidebarMode(m),
          })),
        )
      }
      aria-label={t("app.toggleSidebar")}
      title={sidebarCollapsed && gitChangeCount > 0 ? t("app.toggleSidebar.titleChanges", { count: gitChangeCount }) : t("app.toggleSidebar.title")}
    >
      <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
        <path d="M9.5 4.5v15" />
        {sidebarVisible && <path className="sidebar-toggle-fill" d="M6 4.5h3.5v15H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5z" />}
      </svg>
      {sidebarCollapsed && gitChangeCount > 0 && <span className="sidebar-toggle-dot" aria-hidden="true" />}
    </button>
  );

  const headerTools = (
    <>
      {quickActionIds.length > 0 && (
        <div
          className={"quick-actions" + (quickActionReorder.draggingId ? " is-reordering" : "")}
          aria-label={t("app.reorderShortcuts")}
          onClickCapture={quickActionReorder.onClickCapture}
          onDragStart={(e) => e.preventDefault()}
        >
          {quickActionReorder.ids.map((id) => {
            const plugin = allPlugins.find((p) => p.id === id);
            if (!plugin) return null;
            return (
              <div
                key={id}
                data-shortcut-id={id}
                className={"quick-action" + (quickActionReorder.draggingId === id ? " is-dragging" : "")}
                onPointerDown={(e) => quickActionReorder.onPointerDown(e, id)}
                onContextMenu={(e) => {
                  if (quickActionReorder.draggingId) e.preventDefault();
                  else openMenu(e, [{ label: t("app.removeShortcut"), icon: MenuIcons.trash, danger: true, onSelect: () => toggleQuickAction(id) }]);
                }}
              >
                <PluginUsageButton
                  plugin={plugin}
                  icon={pluginIconNode(plugin)}
                  active={
                    plugin.action === "toggleAgentsSidebar"
                      ? agentPinned
                        ? sidebarVisible && sidebarTab === "agent" && !!activeAgent
                        : agentPopoverOpen && !!activeAgent
                      : undefined
                  }
                  parked={
                    (plugin.action === "toggleBrowser" && panelLayout.parked.browser) ||
                    (plugin.action === "toggleSidebar" && panelLayout.parked.sidebar)
                  }
                  onRun={() => runPlugin(plugin)}
                />
              </div>
            );
          })}
        </div>
      )}
      {favoritesButtonVisible && (
        <FavoritesButton
          activeCwd={activeTerminal && !activeTerminal.busy ? activeTerminal.cwd || undefined : undefined}
          activeShell={activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined}
          onOpenFolder={openFavorite}
        />
      )}
      <button
        ref={pluginBtnRef}
        type="button"
        className="icon-button"
        onClick={() => setPluginMenuAnchor((r) => (r ? null : pluginBtnRef.current?.getBoundingClientRect() ?? null))}
        aria-label={t("settings.section.features")}
        title={t("settings.section.features")}
      >
        {Icons.features}
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={t("app.moreOptions")}
        title={t("app.moreOptions")}
        data-host-menu-anchor
        onClick={(e) => openMenu(e, moreMenuItems())}
      >
        {Icons.kebab}
      </button>
    </>
  );

  return (
    <AgentPanelHostContext.Provider value={agentPanelHost}>
    <FileLinkActionsContext.Provider value={fileLinkActions}>
    <div className={`app-shell${isNarrow ? " is-narrow" : ""}${isMaximized ? " maximized" : ""}${isEdgeFlush ? " edge-flush" : ""}`}>
      <header className="app-headerbar" data-tauri-drag-region>
        {!isNarrow && sidebarToggle}
        <HostSelector
          isNarrow={isNarrow}
          onManage={() => {
            // Settings is a local tab: bring the local PC back in front first.
            setActiveHost(LOCAL_HOST);
            setSettingsSection("remote");
            openSettings();
          }}
        />
        {activeHost !== LOCAL_HOST ? (
          <RemoteTabStrip hostId={activeHost} />
        ) : (
        <TabStrip
          compact={isNarrow}
          tabs={stripTabs}
          activeId={activeTabId}
          dirtyIds={dirtyIds}
          agents={tabAgents}
          doneIds={doneTabIds}
          resumeAt={resumeArmed}
          onCancelResume={cancelResume}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={(shellId, profileId) =>
            profileId !== undefined
              ? addTab(undefined, shellId, false, profileId)
              : shellId
                ? addTab(undefined, shellId)
                : openNewTab()
          }
          onRename={renameTab}
          onDuplicate={duplicateTab}
          onToggleNotifications={toggleTabNotifications}
          onAgentDiagnostics={(id) => void copyAgentDiagnostics(id)}
          onReorder={reorderTab}
          onDragOut={(id) => void handleTabDragOut(id)}
        />
        )}
        <CallBubble
          tabs={stripTabs}
          agents={tabAgents}
          narrow={isNarrow}
          scope={(call) => (activeHost === LOCAL_HOST ? !parseRemoteCallTab(call.tabId) : parseRemoteCallTab(call.tabId)?.hostId === activeHost)}
          onGoTo={(tabId, sessionId) => {
            const remote = parseRemoteCallTab(tabId);
            if (remote) selectRemoteKey(remote.hostId, remote.key);
            else openHistoryTab(tabId, sessionId);
          }}
        />
        <div className="header-right">
          {!isNarrow && headerTools}
          {pluginMenuAnchor && (
            <PluginMenu items={pluginMenuEntries()} anchorRect={pluginMenuAnchor} onClose={() => setPluginMenuAnchor(null)} />
          )}
          <div className="window-controls">
            <button className="icon-button" aria-label={t("window.minimize")} onClick={() => appWindow.minimize()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
                <line x1="6" y1="12" x2="18" y2="12" />
              </svg>
            </button>
            <button className="icon-button" aria-label={t("window.maximize")} onClick={() => appWindow.toggleMaximize()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.6">
                <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
              </svg>
            </button>
            <button className="icon-button icon-button-close" aria-label={t("window.close")} onClick={() => appWindow.close()}>
              <svg viewBox="0 0 24 24" strokeWidth="1.8" strokeLinecap="round">
                <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
                <line x1="17.5" y1="6.5" x2="6.5" y2="17.5" />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <div className="app-body" ref={appBodyRef}>
        {sidebarPresence.mounted && (
          <div
            className={
              "resizable-panel resizable-panel-left" +
              (sidebarPresence.shown ? "" : " is-hidden") +
              (sidebarResize.dragging ? " is-dragging" : "")
            }
            style={{ width: sidebarPresence.shown ? panelLayout.widthOf("sidebar") : 0 }}
            onPointerDownCapture={panelPointerDown("sidebar")}
          >
            <div className="panel-card">
              <div className="panel-card-content" style={{ width: panelLayout.widthOf("sidebar") - 2 }}>
                {sidebarPanel}
              </div>
            </div>
            <div
              className={"resize-handle resize-handle-right" + (sidebarResize.dragging ? " is-dragging" : "")}
              onPointerDown={sidebarResize.onHandlePointerDown}
            />
          </div>
        )}
        {activeHost !== LOCAL_HOST && <Suspense key={activeHost} fallback={null}><RemoteWorkspace hostId={activeHost} /></Suspense>}
        {/* Hidden, never unmounted: the local terminals keep running. */}
        <div className="terminal-stack" style={activeHost !== LOCAL_HOST ? { display: "none" } : undefined}>
          {homeDir &&
            tabs.map((tab) => {
              if (tab.kind === "terminal") {
                const showPage = tab.newTab || handoffs.has(tab.id);
                // The startup tab has no cwd until the start folder is
                // resolved (see above) - mounting it earlier would spawn its
                // shell in whatever directory the app itself started in.
                const showTerminal = !tab.newTab && !!tab.cwd;
                const callbacks = termCallbacks(tab.id);
                // An agent running here gets the chat's header on top.
                const agentSession = sessionByTab.get(tab.id);
                const agentCli = agentSession && (AGENT_CLIS as readonly string[]).includes(agentSession.cli) ? (agentSession.cli as AgentCli) : undefined;
                return (
                  <Fragment key={tab.id}>
                    {showTerminal && (
                      <div
                        className={"terminal-pane" + (agentCli ? " has-agent-header" : "")}
                        style={agentCli && tab.id !== activeTabId ? { display: "none" } : undefined}
                        onKeyDownCapture={
                          agentCli
                            ? (e) => {
                                // Ctrl+` mirrors the chat's: opens the session as a chat.
                                if (e.ctrlKey && e.key === "`") {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  switchTerminalToChat(tab.id);
                                }
                              }
                            : undefined
                        }
                      >
                      {agentCli && agentSession && (
                        <Suspense fallback={null}>
                          <TerminalAgentHeader
                            cli={agentCli}
                            session={agentSession}
                            title={tab.label}
                            cwd={agentSession.cwd ?? tab.cwd}
                            tabId={tab.id}
                            onSwitchToChat={(viewId) => switchTerminalToChat(tab.id, viewId)}
                            onStop={() => {
                              const ptyId = termRefs.current.get(tab.id)?.getPtyId();
                              if (ptyId) invoke("pty_write", { id: ptyId, data: "\x1b" }).catch(() => {});
                            }}
                          />
                        </Suspense>
                      )}
                      <TerminalView
                        tabId={tab.id}
                        ref={callbacks.ref}
                        cwd={tab.cwd || undefined}
                        hidden={tab.id !== activeTabId}
                        onTitleChange={callbacks.onTitleChange}
                        onBusyChange={callbacks.onBusyChange}
                        onCommandLine={callbacks.onCommandLine}
                        interceptCommandLine={callbacks.interceptCommandLine}
                        runOnStart={pendingCommandsRef.current.get(tab.id)}
                        typeOnStart={pendingTypedCommandsRef.current.get(tab.id)}
                        shellOverride={pendingShellOverrideRef.current.get(tab.id)}
                        profileId={tab.profileId}
                        restoredContent={restoredContentRef.current.get(tab.id)}
                        attach={pendingAttachRef.current.get(tab.id)}
                        onAnchor={callbacks.onAnchor}
                        onPromptShown={callbacks.onPromptShown}
                        onPtyReady={callbacks.onPtyReady}
                        wslDistro={wslDistroOfShell(tabShell(tab)) ?? null}
                        onOpenDelegate={callbacks.onOpenDelegate}
                      />
                      </div>
                    )}
                    {showPage && (
                      <NewTabHost
                        hidden={!tab.dialog && tab.id !== activeTabId}
                        dialog={tab.dialog}
                        onDismiss={() => dismissNewTabDialog(tab.id)}
                        defaultShell={shellId}
                        startDir={tab.cwd}
                        termFontSize={getTabFontSize(tab.id)}
                        onLaunch={(launch) => {
                          if (!tab.dialog) setHandoffs((prev) => new Map(prev).set(tab.id, {}));
                          launchFromNewTab(tab.id, launch);
                        }}
                        onLaunchAgent={(cli, cwd, shell) => void launchAgentFromNewTab(tab.id, cli, cwd, shell)}
                        onShellChange={(shell) => previewNewTabShell(tab.id, shell)}
                        profileId={tab.profileId}
                        onProfileChange={(id) => {
                          explicitProfileRef.current.add(tab.id);
                          setTabs((prev) => patchTermTab(prev, tab.id, { profileId: id ?? undefined }));
                        }}
                        anchor={handoffs.get(tab.id)?.anchor}
                        promptShown={handoffs.get(tab.id)?.promptShown}
                        onDone={() =>
                          setHandoffs((prev) => {
                            const next = new Map(prev);
                            next.delete(tab.id);
                            return next;
                          })
                        }
                      />
                    )}
                  </Fragment>
                );
              }
              if (tab.kind === "chat") {
                // The shown conversation (its fields are the tab's) and the parked ones, all mounted: a hidden one keeps its agent running.
                const panes: (ChatPane & { shown: boolean })[] = [
                  { paneKey: tab.paneKey ?? tab.id, label: tab.label, sessionId: tab.sessionId, viewId: tab.viewId, status: tab.status, talked: tab.talked, lastActiveAt: tab.lastActiveAt, shown: true },
                  ...(tab.parked ?? []).map((p) => ({ ...p, shown: false })),
                ];
                return (
                  <Fragment key={tab.id}>
                    {panes.map((pane) => {
                      const handoff = pane.shown ? tab.handoffFrom : undefined;
                      return (
                        <Suspense key={pane.paneKey} fallback={null}>
                          {/* Paths in this chat resolve against its folder and open on this PC. */}
                          <FileLinkCwdContext.Provider value={tab.cwd}>
                          <AgentSessionView
                            agent={tab.agent}
                            cwd={tab.cwd}
                            profileId={tab.profileId}
                            resumeSessionId={pane.sessionId}
                            strictResume={!!handoff}
                            shell={tab.shell}
                            lastActiveAt={pane.lastActiveAt}
                            attachChatId={tab.delegate?.chatId}
                            attachWslDistro={tab.delegate?.wslDistro}
                            tabId={pane.shown ? tab.id : undefined}
                            openTabId={tab.id}
                            onOpenDelegate={(delegate, wslDistro) => openDelegateTab(tab.id, delegate, wslDistro)}
                            viewId={pane.viewId}
                            diagnosis={pane.shown ? tab.diagnosis : undefined}
                            firstPrompt={pane.shown ? tab.firstPrompt : undefined}
                            onFirstPromptSent={() => patchChatTab(tab.id, { firstPrompt: undefined })}
                            hidden={tab.id !== activeTabId || !pane.shown}
                            title={pane.label}
                            onSessionId={(sessionId) => {
                              patchChatPane(tab.id, pane.paneKey, { sessionId });
                              if (handoff) finishHandoff(tab.id, handoff);
                            }}
                            onStatus={(status, error) => {
                              if (status === "exited" && handoff) failHandoff(tab.id, error);
                              else {
                                // Real activity: a turn starting, or ending (busy/waiting -> idle). Starting up and replaying a resumed history is not.
                                const working = (s: string | undefined) => s === "busy" || s === "waiting";
                                const active = working(status) || (status === "idle" && working(pane.status));
                                patchChatPane(tab.id, pane.paneKey, active ? { status, lastActiveAt: Date.now() } : { status });
                              }
                            }}
                            onViewChange={(viewId) => patchChatPane(tab.id, pane.paneKey, { viewId })}
                            onTalked={(talked) => {
                              // Absent counts as talked (a restored or resumed chat); only a real change is written.
                              if (talked ? pane.talked === false : pane.talked !== false) patchChatPane(tab.id, pane.paneKey, { talked });
                            }}
                            onCloser={(closer) => {
                              if (closer) chatClosersRef.current.set(pane.paneKey, closer);
                              else chatClosersRef.current.delete(pane.paneKey);
                            }}
                            onSwitchToTerminal={(sessionId, wslDistro) => switchChatToTerminal(tab, sessionId, wslDistro)}
                            onOpenFile={openFile}
                            onOpenLogin={() => { void openProviderAuth(tab.agent, tab.profileId); }}
                          />
                          </FileLinkCwdContext.Provider>
                        </Suspense>
                      );
                    })}
                  </Fragment>
                );
              }
              if (tab.kind === "editor") {
                return (
                  <Suspense key={tab.id} fallback={null}>
                    <EditorView
                      ref={(handle) => {
                        if (handle) editorRefs.current.set(tab.id, handle);
                        else editorRefs.current.delete(tab.id);
                      }}
                      path={tab.path}
                      hidden={tab.id !== activeTabId}
                      onDirtyChange={(dirty) => handleDirtyChange(tab.id, dirty)}
                      onRenamed={(newPath) => handleEditorRenamed(tab.id, newPath)}
                      initialContent={pendingEditorContentRef.current.get(tab.id)}
                    />
                  </Suspense>
                );
              }
              if (tab.kind === "diff") {
                return (
                  <Suspense key={tab.id} fallback={null}>
                    <DiffView root={tab.root} path={tab.path} staged={tab.staged} hidden={tab.id !== activeTabId} />
                  </Suspense>
                );
              }
              if (tab.id !== activeTabId) return null;
              if (tab.kind === "changelog") return <ChangelogPage key={tab.id} />;
              if (tab.kind === "whatsNew") {
                return <WhatsNewPage key={tab.id} version={tab.version} onOpenChangelog={openChangelog} />;
              }
              return (
                <Suspense key={tab.id} fallback={null}>
                <SettingsPage
                  quickActionIds={quickActionIds}
                  onToggleQuickAction={toggleQuickAction}
                  sidebarMode={sidebarMode}
                  onSetSidebarMode={setSidebarMode}
                  plugins={allPlugins}
                  onAddPlugin={addPlugin}
                  onDeletePlugin={deletePlugin}
                  favoritesButtonVisible={favoritesButtonVisible}
                  onSetFavoritesButtonVisible={setFavoritesButtonVisible}
                  onOpenShortcutsGuide={() => setShortcutsDialogOpen(true)}
                  onProfileLogin={loginProfile}
                />
                </Suspense>
              );
            })}
        </div>
        {panelLayout.sidebarOverlay && (
          <div className="sidebar-floating-backdrop" onClick={panelLayout.dismissSidebarOverlay}>
            <div
              className="sidebar-floating-panel"
              style={{ width: sidebarResize.width }}
              onClick={(e) => e.stopPropagation()}
            >
              {sidebarPanel}
            </div>
          </div>
        )}
        {isNarrow && panelLayout.overlay === "browser" && <div className="sidebar-floating-backdrop" onClick={panelLayout.dismissOverlay} />}
        {browserPresence.mounted && (
          <div
            className={
              "resizable-panel resizable-panel-right resizable-panel-browser" +
              (browserPresence.shown ? "" : " is-hidden") +
              (browserResize.dragging ? " is-dragging" : "")
            }
            style={{ width: browserPresence.shown ? panelLayout.widthOf("browser") : 0 }}
            onPointerDownCapture={panelPointerDown("browser")}
          >
            <div
              className={"resize-handle resize-handle-left" + (browserResize.dragging ? " is-dragging" : "")}
              onPointerDown={browserResize.onHandlePointerDown}
            />
            <div className="panel-card">
              <div className="panel-card-content" style={{ width: panelLayout.widthOf("browser") - 2 }}>
                <Suspense fallback={null}>
                  <BrowserPanel dragging={browserResize.dragging} />
                </Suspense>
              </div>
            </div>
          </div>
        )}
      </div>
      {isNarrow && (
        <div className="narrow-toolbar" data-tauri-drag-region>
          {sidebarToggle}
          <div className="narrow-toolbar-tools">{headerTools}</div>
        </div>
      )}
      {shortcutsDialogOpen && (
        <ShortcutsDialog
          onClose={() => setShortcutsDialogOpen(false)}
          onCustomize={() => {
            setShortcutsDialogOpen(false);
            setSettingsSection("shortcuts");
            openSettings();
          }}
        />
      )}
      {profilePickerOpen && (
        <ProfilePicker
          onClose={() => setProfilePickerOpen(false)}
          onPick={(id) => {
            setProfilePickerOpen(false);
            addTab(undefined, undefined, false, id);
          }}
        />
      )}
      {pluginToast && <PluginToast message={pluginToast} />}
      {pairingHost && <PairHostDialog onClose={() => setPairingHost(false)} />}
      {isMainWindow && <CrashReportDialog />}
      {pluginDialog && (
        <PluginDialog plugin={pluginDialog} onRunButton={(button) => runPlugin(button)} onClose={() => setPluginDialog(null)} />
      )}
    </div>
    </FileLinkActionsContext.Provider>
    </AgentPanelHostContext.Provider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      {!hasSeenWelcome() && (
        <Suspense fallback={null}>
          <WelcomeFlow />
        </Suspense>
      )}
      <TerminalSettingsProvider>
        <SettingsSectionProvider>
          <ChangelogProvider>
            <ConfirmDialogProvider>
              <UpdateProvider>
                <ContextMenuProvider>
                  <ShortcutsProvider>
                    <Shell />
                    <ProviderAuthHost />
                    <RemoteSettingsBridge />
                    <RemoteBrowserBridge />
                    <RemoteUpdateBridge />
                    <RemotePairConfirm />
                  </ShortcutsProvider>
                </ContextMenuProvider>
              </UpdateProvider>
            </ConfirmDialogProvider>
          </ChangelogProvider>
        </SettingsSectionProvider>
      </TerminalSettingsProvider>
    </ThemeProvider>
  );
}
