import type { AppTab } from "../tabs/types";
import { withCodexLaunchFlags } from "../plugins/codexLaunch";
import type { AgentCli } from "../agents/cliInfo";

/** `tabs` with `tab` inserted at strip index `at` (the end when absent or out of range). */
export function insertTabAt(tabs: AppTab[], tab: AppTab, at?: number): AppTab[] {
  if (at === undefined || at < 0 || at >= tabs.length) return [...tabs, tab];
  return [...tabs.slice(0, at), tab, ...tabs.slice(at)];
}

/** The command that resumes `sessionId` in `cli` - host (`wsl` false) gets the Codex launch flags. */
export async function resumeCommand(cli: AgentCli, sessionId: string, host: boolean, profileId?: string): Promise<string> {
  if (cli === "claude") return `claude --resume ${sessionId}`;
  if (cli === "vibe") return `vibe --resume ${sessionId}`;
  if (cli === "gemini") return `gemini --resume ${sessionId}`;
  // A named profile has its own data dir: --standalone keeps opencode off the shared background service (default profile).
  if (cli === "opencode") return `opencode${profileId ? " --standalone" : ""} --session ${sessionId}`;
  if (cli === "cline") return `cline --id ${sessionId}`;
  return host ? await withCodexLaunchFlags(`codex resume ${sessionId}`) : `codex resume ${sessionId}`;
}
