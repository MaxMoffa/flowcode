// Publishes the agent running in the active terminal, for the usage
// popovers' context section.
import { useEffect } from "react";
import { setActiveAgent } from "../agents/activeAgent";
import type { AgentSession } from "../agents/agentSessions";

export function useActiveAgentSync(activeAgentSession: AgentSession | undefined, tabLabel: string | undefined) {
  const [aaCli, aaId, aaProfile, aaWsl, aaLabel] = [
    activeAgentSession?.cli,
    activeAgentSession?.session_id ?? null,
    activeAgentSession?.profile ?? null,
    !!activeAgentSession?.wsl_distro,
    tabLabel ?? "",
  ];
  useEffect(() => {
    setActiveAgent(aaCli ? { cli: aaCli, sessionId: aaId, profile: aaProfile, wsl: aaWsl, tabLabel: aaLabel } : null);
  }, [aaCli, aaId, aaProfile, aaWsl, aaLabel]);
}
