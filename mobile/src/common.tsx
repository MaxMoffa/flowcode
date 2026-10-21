import type { Tab } from "./remote";

/** Last two path segments: a full path never fits a phone. */
export function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length <= 2 ? cwd : `.../${parts.slice(-2).join("/")}`;
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", vibe: "Mistral Vibe", gemini: "Gemini CLI" };

/** An agent CLI's name as the desktop shows it. */
export const agentName = (cli: string): string => AGENT_NAMES[cli] ?? cli;

export function formatSize(n?: number): string {
  if (n === undefined) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function contextPercent(tab: Tab): number | null {
  const c = tab.context;
  if (!c || !c.window) return null;
  return Math.min(100, Math.round((c.used / c.window) * 100));
}
