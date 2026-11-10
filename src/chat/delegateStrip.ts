import { delegateFinished, type DelegateInfo, type DelegateStatus } from "./chatModel";

/** How many delegates of a launch stand in each status. */
export type DelegateCounts = Record<DelegateStatus, number>;

export function delegateCounts(items: DelegateInfo[]): DelegateCounts {
  const counts: DelegateCounts = { running: 0, waiting_for_user: 0, done: 0, failed: 0, cancelled: 0 };
  for (const d of items) counts[d.status]++;
  return counts;
}

/** Something in the launch still moves or needs the user: the strip stays open. */
export const delegatesActive = (counts: DelegateCounts): boolean => counts.running + counts.waiting_for_user > 0;

/** The statuses in the order the strip's summary lists them. */
export const DELEGATE_STATUS_ORDER: DelegateStatus[] = ["running", "waiting_for_user", "done", "failed", "cancelled"];

/** The first non-empty line of a text: what a finished delegate's row says. */
export function firstLine(text: string | undefined): string {
  return text?.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** A finished delegate's duration as m:ss, or "" while it runs or when its times are unknown. */
export function delegateDuration(d: DelegateInfo): string {
  if (!delegateFinished(d) || d.endedAt === undefined || d.startedAt <= 0) return "";
  const seconds = Math.max(0, Math.round((d.endedAt - d.startedAt) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Each agent's colour in the strip (logo, stack); unknown agents take the accent. */
const AGENT_COLORS: Record<string, string> = { claude: "#d97757", codex: "#6cc4b4", gemini: "#7aa2f7", opencode: "#c7a0e8" };

export const delegateAgentColor = (agent: string): string => AGENT_COLORS[agent] ?? "var(--accent)";
