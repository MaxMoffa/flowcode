export type AgentCli = "claude" | "codex" | "vibe";
export const AGENT_CLIS: readonly AgentCli[] = ["claude", "codex", "vibe"];

interface CliInfo {
  /** Id of the example plugin that launches it (also the usage fetcher key). */
  pluginId: string;
  /** Short name, used in notifications. */
  name: string;
  /** Full label, used in menus and settings. */
  label: string;
  /** Command that signs in. */
  loginCommand: string;
}

export const CLI_INFO: Record<AgentCli, CliInfo> = {
  claude: { pluginId: "claude-code", name: "Claude Code", label: "Claude Code", loginCommand: "claude auth login" },
  codex: { pluginId: "codex-cli", name: "Codex", label: "Codex CLI", loginCommand: "codex login" },
  vibe: { pluginId: "mistral-vibe", name: "Mistral Vibe", label: "Mistral Vibe", loginCommand: "vibe --setup" },
};

export const cliOfPlugin = (pluginId: string): AgentCli | undefined => AGENT_CLIS.find((c) => CLI_INFO[c].pluginId === pluginId);

/** Short display name; the raw id for a CLI this build doesn't know. */
export const cliName = (cli: string): string => CLI_INFO[cli as AgentCli]?.name ?? cli;
