// Publishes the agent running in the active terminal, for the usage
// popovers' context section.
import { useEffect } from "react";
import { setActiveAgent } from "../agents/activeAgent";
import type { AgentSession } from "../agents/agentSessions";
import type { ChatTab } from "../tabs/types";

/** `chatTab`: the chat in front, if any - it wins over the last terminal, whose
 * agent isn't the one on screen. A chat has no pty, so no "compact". */
export function useActiveAgentSync(
  activeAgentSession: AgentSession | undefined,
  tabLabel: string | undefined,
  chatTab?: ChatTab,
  terminalTab?: { id: string; cwd: string },
) {
  const [aaCli, aaId, aaProfile, aaWsl, aaLabel, aaPty, aaStatus] = chatTab
    ? [chatTab.agent as string, chatTab.sessionId ?? null, chatTab.profileId ?? null, false, chatTab.label, "", chatTab.status ?? null]
    : [
        activeAgentSession?.cli,
        activeAgentSession?.session_id ?? null,
        activeAgentSession?.profile ?? null,
        !!activeAgentSession?.wsl_distro,
        tabLabel ?? "",
        activeAgentSession?.pty_id ?? "",
        activeAgentSession?.status ?? null,
      ];
  const aaKind = chatTab ? "chat" : "terminal";
  const aaTabId = chatTab ? chatTab.id : (terminalTab?.id ?? null);
  const aaCwd = chatTab ? chatTab.cwd : (terminalTab?.cwd ?? "");
  useEffect(() => {
    setActiveAgent(
      aaCli
        ? {
            cli: aaCli,
            sessionId: aaId,
            profile: aaProfile,
            wsl: aaWsl,
            tabLabel: aaLabel,
            ptyId: aaPty,
            status: aaStatus,
            kind: aaKind,
            tabId: aaTabId,
            cwd: aaCwd,
          }
        : null,
    );
  }, [aaCli, aaId, aaProfile, aaWsl, aaLabel, aaPty, aaStatus, aaKind, aaTabId, aaCwd]);
}
