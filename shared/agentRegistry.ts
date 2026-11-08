/** Every agent CLI Flowcode supports and what each one can do here - the one
 * place to touch when an agent is added or gains a feature (see
 * docs/agents-integration-map.md). No imports: shared by desktop and phone. */

export type AgentCli = "claude" | "codex" | "vibe" | "gemini";
export const AGENT_CLIS: readonly AgentCli[] = ["claude", "codex", "vibe", "gemini"];

export interface AgentCaps {
  /** Flowcode reads its session transcripts: context fill, agent insight (MCP, skills, memory, cost). */
  readsSessions: boolean;
  /** Has a subscription usage limit worth watching (limit-reset notice, auto-resume). */
  usageLimit: boolean;
  /** Prompt-cache TTL warning in chat. */
  cacheWarning: boolean;
  /** Its browser sign-in may ask to paste a code back. */
  authManualCode: boolean;
  /** Its sign-in runs the CLI in a terminal (Vibe signs in over ACP instead). */
  authNativeTerminal: boolean;
}

export const AGENT_CAPS: Record<AgentCli, AgentCaps> = {
  claude: { readsSessions: true, usageLimit: true, cacheWarning: true, authManualCode: true, authNativeTerminal: true },
  codex: { readsSessions: true, usageLimit: true, cacheWarning: false, authManualCode: false, authNativeTerminal: true },
  vibe: { readsSessions: false, usageLimit: false, cacheWarning: false, authManualCode: false, authNativeTerminal: false },
  gemini: { readsSessions: false, usageLimit: false, cacheWarning: false, authManualCode: true, authNativeTerminal: true },
};

export const isAgentCli = (value: unknown): value is AgentCli => (AGENT_CLIS as readonly unknown[]).includes(value);

/** Whether `cli` is a known agent with capability `cap`. */
export const hasCap = (cli: string | null | undefined, cap: keyof AgentCaps): cli is AgentCli => isAgentCli(cli) && AGENT_CAPS[cli][cap];
