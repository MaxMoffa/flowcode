import type { UsageMetric } from "../plugins/usage";

/** Mirrors the Rust `AgentTools` (src-tauri/src/agent_insight.rs). */
export interface AgentTools {
  mcp: { name: string; scope: string; transport: string; target: string }[];
  skills: { name: string; scope: string; estTokens: number }[];
  memoryChars: number;
  memoryFiles: string[];
}

/** Mirrors the Rust `SessionUsage`. */
export interface SessionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number[];
  cost: number | null;
  model: string | null;
}

/** Roughly 4 characters per token - an estimate, always shown as one. */
export const estTokensOfChars = (chars: number) => Math.ceil(Math.max(0, chars) / 4);

export interface ContextSegments {
  memory: number;
  skills: number;
  conversation: number;
  free: number;
}

/** Splits the used context into what the config explains (memory files,
 * skills - both estimates) and the rest; the estimates never exceed `used`. */
export function contextSegments(used: number, window: number, memoryChars: number, skillTokens: number): ContextSegments {
  const u = Math.max(0, used);
  const memory = Math.min(u, estTokensOfChars(memoryChars));
  const skills = Math.min(u - memory, Math.max(0, skillTokens));
  return { memory, skills, conversation: u - memory - skills, free: Math.max(0, window - u) };
}

/** Share of the prompt tokens served from the cache, 0-1; null with no prompt tokens. */
export function cacheHitRatio(u: Pick<SessionUsage, "input" | "cacheRead" | "cacheWrite">): number | null {
  const total = u.cacheRead + u.input + u.cacheWrite;
  return total > 0 ? u.cacheRead / total : null;
}

/** Bar heights (percent of the tallest, min 4) for the per-turn sparkline, and the index of the tallest. */
export function sparkBars(turns: number[]): { heights: number[]; max: number } {
  const peak = Math.max(0, ...turns);
  if (peak <= 0) return { heights: turns.map(() => 4), max: -1 };
  return { heights: turns.map((v) => Math.max(4, Math.round((v / peak) * 100))), max: turns.indexOf(peak) };
}

/** What the usage metrics describe: a subscription's limits, pay-per-token spend, or neither. */
export function planKind(metrics: UsageMetric[]): "plan" | "payg" | "other" {
  if (metrics.some((m) => m.kind === "session" || m.kind === "week")) return "plan";
  if (metrics.some((m) => m.kind === "billing" || m.kind === "spend")) return "payg";
  return "other";
}
