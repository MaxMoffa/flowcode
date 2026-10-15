// Publishes the agent running in the active terminal, for the usage
// popovers' context section.
import { useEffect } from "react";
import { setActiveAgent } from "../agents/activeAgent";
import type { AgentSession } from "../agents/agentSessions";

export function useActiveAgentSync(activeAgentSession: AgentSession | undefined, tabLabel: string | undefined) {
  const [aaCli, aaId, aaProfile, aaWsl, aaLabel, aaPty, aaStatus] = [
    activeAgentSession?.cli,
    activeAgentSession?.session_id ?? null,
    activeAgentSession?.profile ?? null,
    !!activeAgentSession?.wsl_distro,
    tabLabel ?? "",
    activeAgentSession?.pty_id ?? "",
    activeAgentSession?.status ?? null,
  ];
  useEffect(() => {
    setActiveAgent(
      aaCli
        ? { cli: aaCli, sessionId: aaId, profile: aaProfile, wsl: aaWsl, tabLabel: aaLabel, ptyId: aaPty, status: aaStatus }
        : null,
    );
  }, [aaCli, aaId, aaProfile, aaWsl, aaLabel, aaPty, aaStatus]);
}
