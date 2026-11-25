import type { ReactNode } from "react";
import { Sidebar } from "../sidebar/Sidebar";
import { setAgentPanelPinned } from "../agents/agentPanelState";
import { AgentHistoryPanel } from "../agents/AgentHistoryPanel";
import { RemoteSidebar } from "../remoteHosts/RemoteSidebar";
import { LOCAL_HOST } from "../remoteHosts/remoteHosts";
import { SymbolOutline } from "../editor/SymbolOutline";
import type { EditorTab } from "../tabs/types";
import { wslShellId } from "../terminal/wslPath";
import { ChangelogNav } from "../changelog/ChangelogPage";
import { SettingsNav } from "../settings/SettingsNav";
import type { ShellCtx } from "./shellContext";

export function renderSidebarPanel(S: ShellCtx): ReactNode {
  const {
    activeAgent, activeHost, activeTab, activeTerminal, addTab, agentPinned, agentSessions, browseExplorer,
    chatClosersRef, chatTabs, delegateTabs, editorRefs, explorerLinkMode, frontTab, historyAgent,
    launchAgentInNewTab, newChatPane, openChatTab, openDelegateTab, openDiff, openFile, openHistoryTab,
    renderAgentPanel, resolveStartDir, resumeAgentSession, setExplorerLinkMode, setSidebarTab, shellId, sidebarCwd,
    sidebarTab, tabShell, termRefs, terminalTabs,
  } = S;
  // The side panel is contextual to whatever tab is active: the file
  // explorer for a terminal, a jump-to-function outline for a code file,
  // a section index for the settings page, the version list for the
  // changelog and What's new - falling back to the explorer otherwise, since that's the
  // most broadly useful default.
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
  return sidebarPanel;
}
