import { invoke } from "@tauri-apps/api/core";

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

export interface CliStatus {
  installed: boolean;
  logged_in: boolean;
}

const CLI_STATUS_TTL_MS = 60_000;
/** Last `check_cli_status` answer per CLI for the default profile, shared by
 * every caller; concurrent asks share one in-flight probe. Failures are not cached. */
const cliStatusCache = new Map<AgentCli, { at: number; status: CliStatus }>();
const cliStatusInFlight = new Map<AgentCli, Promise<CliStatus | null>>();

/** Whether a CLI is installed and signed in under the default profile (the
 * probe may spawn the CLI, hence the cache); `null` when the check failed.
 * `fresh` skips the cached answer. */
export function defaultCliStatus(cli: AgentCli, fresh = false): Promise<CliStatus | null> {
  const hit = cliStatusCache.get(cli);
  if (!fresh && hit && Date.now() - hit.at < CLI_STATUS_TTL_MS) return Promise.resolve(hit.status);
  const pending = cliStatusInFlight.get(cli);
  if (pending) return pending;
  const probe = invoke<CliStatus>("check_cli_status", { cli })
    .then((status) => {
      cliStatusCache.set(cli, { at: Date.now(), status });
      return status;
    })
    .catch(() => null)
    .finally(() => cliStatusInFlight.delete(cli));
  cliStatusInFlight.set(cli, probe);
  return probe;
}
