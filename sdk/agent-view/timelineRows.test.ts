import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyEvent, initialChat, settleChat, type ChatModelState } from "../../src/chat/chatModel";
import type { ChatEvent } from "../../src/chat/chatTypes";
import { lineDiff } from "./index";

// The Timeline plugin's rows.js is a classic script for the view's page: run it
// the way the page does, with `FlowcodeView` and `self` in scope.
interface Timeline {
  plan: { done: number; total: number } | null;
  thoughts: boolean;
  rows: Record<string, unknown>[];
}
interface TimelineRows {
  formatDuration(ms: number): string | null;
  buildTimeline(model: ChatModelState, timing: Map<string, { start: number; end: number }>, showThoughts?: boolean): Timeline;
}
const scope: { TimelineRows?: TimelineRows } = {};
const source = readFileSync(new URL("../../docs/agent-views/timeline/rows.js", import.meta.url), "utf8");
new Function("FlowcodeView", "self", source)({ lineDiff }, scope);
const { buildTimeline, formatDuration } = scope.TimelineRows!;

const update = (seq: number, u: Record<string, unknown>): ChatEvent => ({ kind: "update", seq, at: 1000 * seq, update: { sessionUpdate: "x", ...u } });
const text = (seq: number, sessionUpdate: string, value: string) => update(seq, { sessionUpdate, content: { type: "text", text: value } });

// What the SDK does for `client.timing`.
function replay(events: ChatEvent[]) {
  let model = settleChat(initialChat());
  const timing = new Map<string, { start: number; end: number }>();
  for (const event of events) {
    const before = model.items;
    model = applyEvent(model, event);
    model.items.forEach((item, i) => {
      if (item !== before[i]) timing.set(item.id, { start: timing.get(item.id)?.start ?? event.at, end: event.at });
    });
  }
  return { model, timing };
}

const events: ChatEvent[] = [
  { kind: "user", seq: 1, at: 1000, text: "Sistema il bug" },
  text(2, "agent_thought_chunk", "Vediamo"),
  text(3, "agent_message_chunk", "Guardo "),
  text(4, "agent_message_chunk", "il file."),
  update(5, { sessionUpdate: "tool_call", toolCallId: "r", title: "Read a.ts", kind: "read", status: "in_progress", locations: [{ path: "/p/src/a.ts", line: 3 }] }),
  update(6, { sessionUpdate: "tool_call_update", toolCallId: "r", status: "completed" }),
  update(7, {
    sessionUpdate: "tool_call",
    toolCallId: "e",
    title: "Edit a.ts",
    kind: "edit",
    status: "failed",
    content: [{ type: "diff", path: "/p/src/a.ts", oldText: "a\nb\n", newText: "a\nc\nd\n" }],
  }),
  update(8, { sessionUpdate: "plan", entries: [{ content: "x", status: "completed" }, { content: "y", status: "in_progress" }, { content: "z", status: "pending" }, { content: "w", status: "pending" }] }),
  { kind: "error", seq: 9, at: 9000, message: "boom" },
];

describe("timeline rows", () => {
  const { model, timing } = replay(events);
  const built = buildTimeline(model, timing);

  it("builds one row per item, thoughts hidden", () => {
    expect(built.rows.map((r) => r.kind)).toEqual(["user", "agent", "tool", "tool", "error"]);
    expect(built.thoughts).toBe(true);
    expect(built.rows[1]).toMatchObject({ text: "Guardo il file.", at: 3000 });
    expect(buildTimeline(model, timing, true).rows.map((r) => r.kind)).toContain("thought");
  });

  it("derives tool icon, status, duration and files", () => {
    expect(built.rows[2]).toMatchObject({ icon: "read", status: "completed", duration: "1.0s", files: [{ path: "/p/src/a.ts", line: 3 }], diffs: [] });
  });

  it("shows an edit as its changed lines", () => {
    const edit = built.rows[3] as { icon: string; status: string; duration: string | null; files: unknown[]; diffs: { added: number; removed: number; rows: { type: string; text: string }[] }[] };
    expect(edit).toMatchObject({ icon: "edit", status: "failed", duration: null, files: [{ path: "/p/src/a.ts", line: null }] });
    expect(edit.diffs[0]).toMatchObject({ added: 2, removed: 1 });
    expect(edit.diffs[0].rows).toEqual([
      { type: "del", text: "b" },
      { type: "add", text: "c" },
      { type: "add", text: "d" },
    ]);
  });

  it("counts the plan", () => {
    expect(built.plan).toMatchObject({ done: 1, total: 4 });
  });

  it("formats durations", () => {
    expect([50, 400, 3200, 12000, 65000].map(formatDuration)).toEqual([null, "0.4s", "3.2s", "12s", "1m 05s"]);
  });
});
