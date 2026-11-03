import type { ChatItem } from "./chatModel";
import type { ChatToolCall } from "./chatTypes";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function isCodexSubagentLaunch(call: ChatToolCall): boolean {
  const input = object(call.rawInput);
  return call.toolName === "spawn_agent" ||
    (call.title === "spawnAgent" && typeof input.senderThreadId === "string" && Array.isArray(input.receiverThreadIds));
}

const threadsOf = (call: ChatToolCall): string[] => {
  const ids = object(call.rawInput).receiverThreadIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id !== "") : [];
};

const terminal = (status: unknown) => typeof status === "string" &&
  ["completed", "errored", "failed", "shutdown", "notFound", "cancelled", "disconnected"].includes(status);

/** Legacy Codex ACP reports spawn completion before the child's work ends.
 * Keep its launch alive using the child states on later collaboration calls.
 * Activity calls belong to that launch, rather than the main conversation. */
export function updateCodexSubagents(items: ChatItem[], updatedId: string, at: number): ChatItem[] {
  const updated = items.find((item) => item.type === "tool" && item.id === updatedId);
  if (updated?.type !== "tool") return items;
  const input = object(updated.call.rawInput);
  // A plain tool call (every call of Claude and most of Codex's) says nothing about subagents: skip the scans below.
  if (!isCodexSubagentLaunch(updated.call) && input.agentThreadId === undefined && input.senderThreadId === undefined && input.agentsStates === undefined) return items;
  const states = { ...object(input.agentsStates) };
  const activityThread = typeof input.agentThreadId === "string" ? input.agentThreadId : null;
  if (activityThread) {
    if (input.activityKind === "started") states[activityThread] = { status: "running" };
    if (updated.call.status === "completed" && (input.activityKind === "completed" || input.activityKind === "interrupted")) {
      states[activityThread] = { status: input.activityKind === "completed" ? "completed" : "cancelled" };
    }
  }
  const launches = items.filter((item) => item.type === "tool" && isCodexSubagentLaunch(item.call));
  if (launches.length === 0) return items;
  const owner = (thread: unknown) => typeof thread === "string" ? launches.find((item) =>
    item.type === "tool" && threadsOf(item.call).includes(thread)) : undefined;

  return items.map((item) => {
    if (item.type !== "tool") return item;
    let call = item.call;
    const ownInput = object(call.rawInput);
    const parent = owner(ownInput.agentThreadId ?? ownInput.senderThreadId);
    if (parent && parent.id !== item.id && !call.parentToolUseId) call = { ...call, parentToolUseId: parent.id };
    if (isCodexSubagentLaunch(call)) {
      const threads = threadsOf(call);
      const changes = Object.fromEntries(threads.filter((id) => states[id] !== undefined).map((id) => [id, states[id]]));
      const isActivity = activityThread !== null && threads.includes(activityThread);
      if (item.id === updatedId || Object.keys(changes).length > 0 || isActivity) {
        const merged = { ...object(ownInput.agentsStates) };
        for (const [id, value] of Object.entries(changes)) {
          const previous = object(merged[id]);
          const next = object(value);
          // A completion activity may repeat the outcome without its report.
          merged[id] = { ...(terminal(next.status) && previous.status === next.status ? previous : {}), ...next };
        }
        const childStates = threads.map((id) => object(merged[id]));
        const finished = childStates.length > 0 && childStates.every((s) => terminal(s.status));
        const failed = finished && childStates.some((s) => s.status !== "completed");
        const status = finished ? (failed ? "failed" : "completed") : threads.length === 0 && call.status === "failed" ? "failed" : "in_progress";
        const report = finished ? childStates.map((s) => typeof s.message === "string" ? s.message : "").filter(Boolean).join("\n\n") : "";
        const name = isActivity && typeof input.agentPath === "string" ? input.agentPath.split("/").filter(Boolean).pop() : undefined;
        call = {
          ...call, status, rawInput: { ...ownInput, agentsStates: merged },
          ...(name ? { subagentName: name } : {}),
          content: report ? [{ type: "content", content: { type: "text", text: report } }] : status === "failed" && threads.length === 0 ? call.content : [],
          startedAt: call.startedAt ?? at,
          endedAt: status === "in_progress" ? undefined : call.endedAt ?? at,
        };
      }
    }
    return call === item.call ? item : { ...item, call };
  });
}

/** Cancellation and process exit leave no live child to keep in the tray. */
export function closeCodexSubagents(items: ChatItem[], at: number): ChatItem[] {
  return items.map((item) => item.type === "tool" && isCodexSubagentLaunch(item.call) &&
    item.call.status !== "completed" && item.call.status !== "failed"
    ? { ...item, call: { ...item.call, status: "failed", endedAt: at } }
    : item);
}
