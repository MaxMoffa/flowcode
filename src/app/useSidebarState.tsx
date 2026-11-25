import { useEffect } from "react";
import { useSidebarTab } from "../sidebar/Sidebar";
import { AgentInsightPanel } from "../agents/AgentInsightPanel";
import { setAgentPopoverOpen, toggleAgentPopover, useAgentPanelPinned, useAgentPopoverOpen, type AgentPanelHost } from "../agents/agentPanelState";
import { LOCAL_HOST } from "../remoteHosts/remoteHosts";
import { wslDistroOfPath, wslDistroOfShell } from "../terminal/wslPath";
import { useActiveAgent } from "../agents/activeAgent";
import { useGitChangeCount } from "../git/useGitChangeCount";
import { AGENT_CLIS, type AgentCli } from "../agents/cliInfo";
import type { SidebarStateCtx } from "./shellContext";

/** The sidebar's folder and tabs, and the agent panel (pinned in the sidebar or the header popover). */
export function useSidebarState(S: SidebarStateCtx) {
  const {
    activeAgentSession, activeHost, activeTabId, activeTerminal, chatClosersRef, frontChat, frontTab, homeDir,
    panelLayout, sidebarCollapsed, togglePanel,
  } = S;
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
  return {
    sidebarCwd, historyAgent, activeAgent, sidebarVisible, agentPinned, agentPopoverOpen, toggleAgentTab,
    renderAgentPanel, agentPanelHost, gitChangeCount, sidebarTab, setSidebarTab,
  };
}
