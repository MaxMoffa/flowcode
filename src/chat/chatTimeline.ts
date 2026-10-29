import { isSubagentLaunch, streamOf, type ChatItem } from "./chatModel";
import type { ChatToolCall } from "./chatTypes";

type ToolItem = Extract<ChatItem, { type: "tool" }>;
type PermissionItem = Extract<ChatItem, { type: "permission" }>;

/** One step on a timeline rail: a tool call, or an answered permission request. */
export type TimelineStep = ToolItem | (PermissionItem & { resolved: string | null });

/** What the column draws, in order: a lone item, or a run of steps on one rail. */
export type TimelineSegment =
  | { type: "item"; item: ChatItem }
  | { type: "group"; id: string; steps: TimelineStep[] }
  | { type: "subagents"; id: string; items: SubagentItem[] };

/** A subagent: the Agent/Task tool call that launched it, and the tool calls it made (in order). */
export interface SubagentItem {
  type: "subagent";
  id: string;
  call: ChatToolCall;
  steps: ToolItem[];
  /** Everything the subagent did, in order: its tool calls and its own messages and thoughts (also those of subagents it launched itself). */
  children: ChatItem[];
}

/** One pass over the conversation: the main flow with every subagent folded in (its tool calls leave the flow and become the `steps` of its launch call, which turns into a `subagent` item; tool calls whose launch is unknown, and every other agent's, stay as they are), plus every subagent by launch id, nested ones included. */
export function indexSubagents(items: ChatItem[]): { flow: Array<ChatItem | SubagentItem>; byId: Map<string, SubagentItem> } {
  const tools = new Map<string, ToolItem>();
  for (const item of items) if (item.type === "tool") tools.set(item.id, item);
  // A child may follow a launch that isn't marked as one (no tool name yet): any known tool call can be a parent.
  const parentOf = (item: ChatItem): string | null => {
    const parent = streamOf(item);
    return parent && parent !== item.id && tools.has(parent) ? parent : null;
  };
  const byId = new Map<string, SubagentItem>();
  const launchOf = (owner: ToolItem): SubagentItem => {
    let launch = byId.get(owner.id);
    if (!launch) {
      launch = { type: "subagent", id: owner.id, call: owner.call, steps: [], children: [] };
      byId.set(owner.id, launch);
    }
    return launch;
  };
  for (const item of items) if (item.type === "tool" && isSubagentLaunch(item.call)) launchOf(item);
  const parents = items.map(parentOf);
  items.forEach((item, i) => {
    const parent = parents[i];
    if (!parent) return;
    // Only tool calls are steps; the subagent's words live in `children`.
    const direct = launchOf(tools.get(parent)!);
    if (item.type === "tool") direct.steps.push(item);
    // Its transcript holds what runs under it, directly or through a subagent it launched.
    const seen = new Set<string>([item.id]);
    for (let up: string | null = parent; up && !seen.has(up); up = parentOf(tools.get(up)!)) {
      seen.add(up);
      launchOf(tools.get(up)!).children.push(item);
    }
  });
  const flow: Array<ChatItem | SubagentItem> = [];
  items.forEach((item, i) => {
    if (parents[i]) return;
    flow.push((item.type === "tool" && byId.get(item.id)) || item);
  });
  return { flow, byId };
}

/** The conversation with every subagent folded in (see `indexSubagents`). */
export function nestSubagents(items: ChatItem[]): Array<ChatItem | SubagentItem> {
  return indexSubagents(items).flow;
}

/** The subagent's own words for the user: its type and what it was asked, from the launch call. */
export function subagentInfo(call: ChatToolCall): { type: string | null; description: string } {
  const input = (call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}) as Record<string, unknown>;
  const type = typeof input.subagent_type === "string" && input.subagent_type !== "" ? input.subagent_type : null;
  const description = typeof input.description === "string" && input.description !== "" ? input.description : (call.title ?? call.toolCallId);
  return { type, description };
}

/** The subagent with this launch id, if the conversation still has it. */
export function findSubagent(items: ChatItem[], id: string): SubagentItem | null {
  return indexSubagents(items).byId.get(id) ?? null;
}

/** The task the subagent was given (the launch call's prompt); empty when unknown. */
export function subagentPrompt(call: ChatToolCall): string {
  const input = (call.rawInput && typeof call.rawInput === "object" ? call.rawInput : {}) as Record<string, unknown>;
  return typeof input.prompt === "string" ? input.prompt.trim() : "";
}

/** A subagent's own chat as a list of items: what it said and did, then its final report as the last message once it finished (unless it already said the same). */
export function subagentItems(sub: SubagentItem): ChatItem[] {
  const items = [...sub.children];
  const report = subagentReport(sub.call);
  if (report) {
    const last = [...items].reverse().find((i) => i.type === "agent");
    if (!last || (last as { text: string }).text.trim() !== report) items.push({ type: "agent", id: `${sub.id}-report`, text: report });
  }
  return items;
}

/** What a subagent's own chat draws on the desktop. */
export function subagentTimeline(sub: SubagentItem): TimelineSegment[] {
  return buildTimeline(subagentItems(sub));
}

/** The subagent's final report: the text of its launch call once that finished (before, the content is the prompt it was given). */
export function subagentReport(call: ChatToolCall): string {
  if (call.status !== "completed" && call.status !== "failed") return "";
  return (call.content ?? [])
    .map((c) => (c.type === "content" && c.content.type === "text" ? (c.content.text ?? "") : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export interface SubagentState {
  running: boolean;
  failed: boolean;
  /** Tool calls of the subagent that failed (an error it recovered from when the subagent itself did not fail). */
  failedSteps: number;
  /** The step in progress, if any (the last unfinished one). */
  current: ChatToolCall | null;
  /** Seconds the subagent took, once finished and timed; null otherwise. */
  seconds: number | null;
}

export function subagentState(item: SubagentItem): SubagentState {
  const { call, steps } = item;
  const running = call.status !== "completed" && call.status !== "failed";
  const open = steps.filter((s) => s.call.status !== "completed" && s.call.status !== "failed");
  const seconds = !running && call.startedAt !== undefined && call.endedAt !== undefined && call.endedAt - call.startedAt >= 1000 ? Math.round((call.endedAt - call.startedAt) / 1000) : null;
  return {
    running,
    failed: call.status === "failed",
    failedSteps: steps.filter((s) => s.call.status === "failed").length,
    current: running ? (open[open.length - 1]?.call ?? null) : null,
    seconds,
  };
}

/** The categories a finished group is summarised by. */
export type StepCategory = "read" | "search" | "edit" | "execute" | "fetch" | "other";

export const STEP_CATEGORIES: StepCategory[] = ["read", "search", "edit", "execute", "fetch", "other"];

export function categoryOf(call: ChatToolCall): StepCategory {
  switch (call.kind) {
    case "read":
      return "read";
    case "search":
      return "search";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "execute":
      return "execute";
    case "fetch":
      return "fetch";
    default:
      return "other";
  }
}

/** Splits the conversation into segments: consecutive subagents form one block of cards; consecutive tool calls (and the
 * permission requests answered between them) form one group, the steps of an
 * agent turn. Pending permission requests are left out - they are drawn above
 * the composer, not in the flow. */
export function buildTimeline(items: ChatItem[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const item of nestSubagents(items)) {
    if (item.type !== "subagent" && hiddenGuardian(item)) continue;
    if (item.type === "subagent") {
      const last = segments[segments.length - 1];
      if (last?.type === "subagents") last.items.push(item);
      else segments.push({ type: "subagents", id: item.id, items: [item] });
      continue;
    }
    if (item.type === "permission" && item.resolved === undefined) continue;
    if (item.type === "tool" || item.type === "permission") {
      const step = item as TimelineStep;
      const last = segments[segments.length - 1];
      if (last?.type === "group") last.steps.push(step);
      else segments.push({ type: "group", id: item.id, steps: [step] });
    } else {
      segments.push({ type: "item", item });
    }
  }
  return segments;
}

export interface GroupSummary {
  counts: Record<StepCategory, number>;
  failed: number;
}

export function summarizeSteps(steps: TimelineStep[]): GroupSummary {
  const counts: Record<StepCategory, number> = { read: 0, search: 0, edit: 0, execute: 0, fetch: 0, other: 0 };
  let failed = 0;
  for (const step of steps) {
    if (step.type !== "tool") continue;
    counts[categoryOf(step.call)]++;
    if (step.call.status === "failed") failed++;
  }
  return { counts, failed };
}

/** Codex's automatic approval reviewer ("Guardian"): a tool call of its own per review. */
export function isGuardianReview(call: ChatToolCall): boolean {
  return call.toolCallId.startsWith("guardian_assessment:");
}

/** A guardian review that stays out of the conversation: approved or still running. Denied, aborted or timed-out ones stay, since they explain why a command did not run. */
export function hiddenGuardian(item: ChatItem): boolean {
  return item.type === "tool" && isGuardianReview(item.call) && item.call.status !== "failed";
}

/** The tool call the agent is working on right now, if any. */
export function liveTool(items: ChatItem[]): ChatToolCall | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type !== "tool") continue;
    const status = item.call.status;
    if (status !== "completed" && status !== "failed") return item.call;
    return null;
  }
  return null;
}
