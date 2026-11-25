import { Fragment, lazy, Suspense, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TerminalView } from "../terminal/Terminal";
import type { ChatPane } from "../tabs/types";
import { wslDistroOfShell } from "../terminal/wslPath";
import { FileLinkCwdContext } from "../lib/fileLinks";
import { ChangelogPage, WhatsNewPage } from "../changelog/ChangelogPage";
import { NewTabHost } from "../newtab/NewTabHost";
import { openProviderAuth } from "../profiles/providerAuth";
import { patchTermTab } from "../tabs/tabState";
import { AGENT_CLIS, type AgentCli } from "../agents/cliInfo";
import type { ShellCtx } from "./shellContext";

// Loaded on demand: CodeMirror (every language grammar) is the bulk of the
// bundle, and plenty of sessions never open a file.
const DiffView = lazy(() => import("../git/DiffView").then((m) => ({ default: m.DiffView })));
const TerminalAgentHeader = lazy(() => import("../agentViews/TerminalAgentHeader").then((m) => ({ default: m.TerminalAgentHeader })));
const AgentSessionView = lazy(() => import("../agentViews/AgentSessionView").then((m) => ({ default: m.AgentSessionView })));
const EditorView = lazy(() => import("../editor/EditorView").then((m) => ({ default: m.EditorView })));
const SettingsPage = lazy(() => import("../settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));

/** Every local tab's content, all mounted (hidden ones keep running) - except the singleton pages, only while in front. */
export function renderTabStack(S: ShellCtx): ReactNode {
  const {
    activeTabId, addPlugin, allPlugins, chatClosersRef, deletePlugin, dismissNewTabDialog, editorRefs,
    explicitProfileRef, failHandoff, favoritesButtonVisible, finishHandoff, getTabFontSize, handleDirtyChange,
    handleEditorRenamed, handoffs, homeDir, launchAgentFromNewTab, launchFromNewTab, loginProfile, openChangelog,
    openDelegateTab, openFile, patchChatPane, patchChatTab, pendingAttachRef, pendingCommandsRef,
    pendingEditorContentRef, pendingShellOverrideRef, pendingTypedCommandsRef, previewNewTabShell, quickActionIds,
    restoredContentRef, sessionByTab, setFavoritesButtonVisible, setHandoffs, setShortcutsDialogOpen,
    setSidebarMode, setTabs, shellId, sidebarMode, stableChatCallbacks, switchChatToTerminal, switchTerminalToChat,
    tabShell, tabs, termCallbacks, termRefs, toggleQuickAction,
  } = S;
  return (
    homeDir &&
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
              // Stable callbacks (the memoized view must not re-render with every App render); they call through to this render's closures.
              const cb = stableChatCallbacks(pane.paneKey, {
                onOpenDelegate: (delegate, wslDistro) => openDelegateTab(tab.id, delegate, wslDistro),
                onFirstPromptSent: () => patchChatTab(tab.id, { firstPrompt: undefined }),
                onSessionId: (sessionId) => {
                  patchChatPane(tab.id, pane.paneKey, { sessionId });
                  if (handoff) finishHandoff(tab.id, handoff);
                },
                onStatus: (status, error) => {
                  if (status === "exited" && handoff) failHandoff(tab.id, error);
                  else {
                    // Real activity: a turn starting, or ending (busy/waiting -> idle). Starting up and replaying a resumed history is not.
                    const working = (s: string | undefined) => s === "busy" || s === "waiting";
                    const active = working(status) || (status === "idle" && working(pane.status));
                    patchChatPane(tab.id, pane.paneKey, active ? { status, lastActiveAt: Date.now() } : { status });
                  }
                },
                onViewChange: (viewId) => patchChatPane(tab.id, pane.paneKey, { viewId }),
                onTalked: (talked) => {
                  // Absent counts as talked (a restored or resumed chat); only a real change is written.
                  if (talked ? pane.talked === false : pane.talked !== false) patchChatPane(tab.id, pane.paneKey, { talked });
                },
                onCloser: (closer) => {
                  if (closer) chatClosersRef.current.set(pane.paneKey, closer);
                  else chatClosersRef.current.delete(pane.paneKey);
                },
                onSwitchToTerminal: (sessionId, wslDistro) => switchChatToTerminal(tab, sessionId, wslDistro),
                onOpenFile: openFile,
                onOpenLogin: () => { void openProviderAuth(tab.agent, tab.profileId); },
              });
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
                    onOpenDelegate={cb.onOpenDelegate}
                    viewId={pane.viewId}
                    diagnosis={pane.shown ? tab.diagnosis : undefined}
                    firstPrompt={pane.shown ? tab.firstPrompt : undefined}
                    onFirstPromptSent={cb.onFirstPromptSent}
                    hidden={tab.id !== activeTabId || !pane.shown}
                    title={pane.label}
                    onSessionId={cb.onSessionId}
                    onStatus={cb.onStatus}
                    onViewChange={cb.onViewChange}
                    onTalked={cb.onTalked}
                    onCloser={cb.onCloser}
                    onSwitchToTerminal={cb.onSwitchToTerminal}
                    onOpenFile={cb.onOpenFile}
                    onOpenLogin={cb.onOpenLogin}
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
    })
  );
}
