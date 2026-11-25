import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { AgentPanelHostContext } from "./agents/agentPanelState";
import { openFileInPreview, setBrowserOpen } from "./browser/browserStore";
import { TabStrip } from "./terminal/TabStrip";
import { HostSelector } from "./remoteHosts/HostSelector";
import { PairHostDialog } from "./remoteHosts/PairHostDialog";
import { CrashReportDialog } from "./crash/CrashReportDialog";
import { useDiagnosisTabEvents } from "./crash/diagnosis";
import { useBrowserDiagnosisEvents } from "./browser/browserDiagnosis";
import { useBrowserControlBridge } from "./browser/control";
import { RemoteTabStrip } from "./remoteHosts/RemoteTabStrip";
import { frontRemoteTerminal, LOCAL_HOST, onRemoteNotice, parseRemoteCallTab, remoteShortcuts, selectRemoteKey, setActiveHost } from "./remoteHosts/remoteHosts";
import type { ChatTab, TermTab } from "./tabs/types";
import { loadPluginViews } from "./agentViews/pluginViews";
import { ThemeProvider } from "./themes/ThemeContext";
import { TerminalSettingsProvider } from "./terminal/TerminalSettingsContext";
import { UpdateProvider } from "./update/UpdateContext";
import { CallBubble } from "./calls/CallBubble";
import { isPhoneAction, PROFILE_CLI, publishRemoteActions } from "./plugins/remotePublish";
import { useRemoteLeader } from "./remote/leader";
import { useShortcuts } from "./shortcuts/useShortcuts";
import { ContextMenuProvider } from "./context-menu/ContextMenuContext";
import { ConfirmDialogProvider } from "./dialog/ConfirmDialogContext";
import { FileLinkActionsContext, type FileLinkActions } from "./lib/fileLinks";
import { ChangelogProvider } from "./changelog/ChangelogPage";
import { consumeUpdatedVersion } from "./changelog/lastRunVersion";
import { SettingsSectionProvider } from "./settings/SettingsSectionContext";
import { RemoteSettingsBridge } from "./remote/RemoteSettingsBridge";
import { RemoteBrowserBridge } from "./remote/RemoteBrowserBridge";
import { RemoteUpdateBridge } from "./remote/RemoteUpdateBridge";
import { RemotePairConfirm } from "./remote/RemotePairConfirm";
import { ShortcutsProvider } from "./shortcuts/ShortcutsContext";
import { ShortcutsDialog } from "./shortcuts/ShortcutsDialog";
import { PluginMenu } from "./plugins/PluginMenu";
import { PluginToast } from "./plugins/PluginToast";
import { PluginDialog } from "./plugins/PluginDialog";
import { hasSeenWelcome } from "./welcome/welcomeSeen";
import { removeKey } from "./lib/storage";
import { loadPluginNewTabs } from "./newtab/pluginLayouts";
import { ProfilePicker } from "./profiles/ProfilePicker";
import { ProviderAuthHost } from "./profiles/ProviderAuthHost";
import { useCliLoginEvent } from "./app/useCliLoginEvent";
import { useReportTabs } from "./app/useReportTabs";
import { usePanelLayout } from "./app/usePanelLayout";
import { listedTabs } from "./tabs/tabState";
import { staleDelegateTabs, useAllTabDelegations } from "./chat/delegateStore";
import { startRemotePrefsSync } from "./chat/dictationModels";
import type { ShellCtx } from "./app/shellContext";
import { appWindow, isMainWindow } from "./app/appWindow";
import { useShellBase } from "./app/useShellBase";
import { renderTabStack } from "./app/TabStack";
import { renderSidebarPanel } from "./app/SidebarPanel";
import { renderHeaderTools } from "./app/HeaderTools";
import { useTabs } from "./app/useTabs";
import { useNewTabs } from "./app/useNewTabs";
import { useTerminalHandlers } from "./app/useTerminalHandlers";
import { useAgentLaunch } from "./app/useAgentLaunch";
import { usePluginActions } from "./app/usePluginActions";
import { useSessionRestore } from "./app/useSessionRestore";
import { useRemoteHandlers } from "./app/useRemoteHandlers";
import { useTabAgents } from "./app/useTabAgents";
import { useSidebarState } from "./app/useSidebarState";
import "./App.css";

// Loaded on demand: the flowkit onboarding flow is a big part of the bundle and
// only ever shows on first launch.
const RemoteWorkspace = lazy(() => import("./remoteHosts/RemoteWorkspace").then((m) => ({ default: m.RemoteWorkspace })));
const BrowserPanel = lazy(() => import("./browser/BrowserPanel").then((m) => ({ default: m.BrowserPanel })));
const WelcomeFlow = lazy(() => import("./welcome/WelcomeFlow").then((m) => ({ default: m.WelcomeFlow })));

function Shell() {
  const S = useShellBase() as ShellCtx;
  // No hooks with effects in these five (refs only): what they define calls each other through `S`.
  Object.assign(S, useTabs(S));
  Object.assign(S, useNewTabs(S));
  Object.assign(S, useTerminalHandlers(S));
  Object.assign(S, useAgentLaunch(S));
  Object.assign(S, usePluginActions(S));
  const {
    activeHost, activeTabId, activeTerminalId, addTab, allPlugins, appBodyRef, browseExplorer, browserHintFolder,
    browserOpen, browserPanelRef, browserResize, closeTab, copyAgentDiagnostics, dirtyIds, duplicateTab,
    explicitProfileRef, fillStartDir, handleTabDragOut, homeDir, inheritedProfileRef, isEdgeFlush, isMaximized,
    latestRef, layoutLiveRef, moveActiveTab, openChatTab, openHistoryTab, openInEditor, openNewTab, openSettings,
    openWhatsNew, pairingHost, panelRestoreRef, pendingRemoteRunRef, pendingShellOverrideRef, pluginDialog,
    pluginMenuAnchor, pluginMenuEntries, pluginToast, profilePickerOpen, profiles, ptyVersion, quickActionIds,
    reloadCustomPlugins, renameTab, reorderTab, resetTabZoom, resolvedStartPath, runPlugin, runPluginRef,
    seedExamplePlugins, selectTab, selectTabAt, sessionChecked, setPairingHost, setPluginDialog,
    setPluginMenuAnchor, setProfilePickerOpen, setSettingsSection, setShortcutsDialogOpen, setSidebarCollapsed,
    shellId, shortcutsDialogOpen, showPluginToastRef, sidebarCollapsed, sidebarMode, sidebarPanelRef,
    sidebarResize, startPathChecked, stepTab, stripTabs, t, tabs, termRefs, toggleTabNotifications, toggleTheme,
    zoomTabIn, zoomTabOut,
  } = S;
  useSessionRestore(S);

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
    liveRef: layoutLiveRef,
  });
  const { isNarrow, sidebarPresence, browserPresence, togglePanel, panelPointerDown } = panelLayout;
  panelRestoreRef.current = panelLayout.markRestore;
  S.panelLayout = panelLayout;
  S.togglePanel = togglePanel;

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
    toggleAgents: () => S.toggleAgentTab(),
    toggleBrowser: () => togglePanel("browser"),
    openSettings: () => openSettings(),
    showShortcuts: () => setShortcutsDialogOpen((o) => !o),
  });
  S.activeTermHandle = activeTermHandle;

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

  // Tells the backend which terminal tabs this window has, and which pty
  // each one runs - so the Agents panel of every window can list (and jump
  // to) agents running here. Re-sent periodically: a new tab's pty id only
  // exists once its shell has spawned.
  // Keyed on what is reported, not on `tabs`: a title event that changes
  // nothing the backend shows shouldn't cost an IPC call.
  // In strip order, terminals and chats together: moving a chat past a terminal is reported too.
  const reportedTabsKey = listedTabs(tabs)
    .map((t) => (t.kind === "terminal" ? `t\u0000${t.id}\u0000${t.label}\u0000${t.cwd}\u0000${t.notifyMuted ? 1 : 0}` : t.kind === "chat" ? `c\u0000${t.id}\u0000${t.label}\u0000${t.sessionId ?? ""}` : ""))
    .join("\u0001");
  useReportTabs(reportedTabsKey, ptyVersion, latestRef, termRefs);

  useRemoteHandlers(S);
  const tabAgentState = useTabAgents(S);
  Object.assign(S, tabAgentState);
  const { tabAgents, doneTabIds, resumeArmed, cancelResume } = tabAgentState;
  const sidebarState = useSidebarState(S);
  Object.assign(S, sidebarState);
  const { agentPanelHost } = sidebarState;

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
  useEffect(() => {
    const pending = pendingRemoteRunRef.current;
    if (!pending || pending.tabId !== activeTabId) return;
    pendingRemoteRunRef.current = null;
    runPluginRef.current(pending.plugin);
  }, [activeTabId]);
  S.terminalTabs = terminalTabs;
  S.chatTabs = chatTabs;
  S.delegateTabs = delegateTabs;

  const sidebarPanel = renderSidebarPanel(S);
  const { sidebarToggle, headerTools } = renderHeaderTools(S);

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
            ref={sidebarPanelRef}
            className={"resizable-panel resizable-panel-left" + (sidebarResize.dragging ? " is-dragging" : "")}
            data-state={sidebarPresence.state}
            style={{ "--panel-w": `${panelLayout.widthOf("sidebar")}px` } as CSSProperties}
            onPointerDownCapture={panelPointerDown("sidebar")}
          >
            <div className="panel-card" onAnimationEnd={sidebarPresence.onAnimationEnd}>
              <div className="panel-card-content">
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
          {renderTabStack(S)}
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
            ref={browserPanelRef}
            className={"resizable-panel resizable-panel-right resizable-panel-browser" + (browserResize.dragging ? " is-dragging" : "")}
            data-state={browserPresence.state}
            style={{ "--panel-w": `${panelLayout.widthOf("browser")}px` } as CSSProperties}
            onPointerDownCapture={panelPointerDown("browser")}
          >
            <div
              className={"resize-handle resize-handle-left" + (browserResize.dragging ? " is-dragging" : "")}
              onPointerDown={browserResize.onHandlePointerDown}
            />
            <div className="panel-card" onAnimationEnd={browserPresence.onAnimationEnd}>
              <div className="panel-card-content">
                <Suspense fallback={null}>
                  <BrowserPanel dragging={browserResize.dragging} motion={browserPresence.state} />
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
