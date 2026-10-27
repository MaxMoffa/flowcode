import type { ChatItem } from "./chatModel";
import type { ChatToolCall } from "./chatTypes";

type ToolItem = Extract<ChatItem, { type: "tool" }>;
type PermissionItem = Extract<ChatItem, { type: "permission" }>;

/** One step on a timeline rail: a tool call, or an answered permission request. */
export type TimelineStep = ToolItem | (PermissionItem & { resolved: string | null });

/** What the column draws, in order: a lone item, or a run of steps on one rail. */
export type TimelineSegment =
  | { type: "item"; item: ChatItem }
  | { type: "group"; id: string; steps: TimelineStep[] };

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

/** Splits the conversation into segments: consecutive tool calls (and the
 * permission requests answered between them) form one group, the steps of an
 * agent turn. Pending permission requests are left out - they are drawn above
 * the composer, not in the flow. */
export function buildTimeline(items: ChatItem[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  for (const item of items) {
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
