import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chatModel";
import { buildTimeline, liveTool, summarizeSteps } from "./chatTimeline";

const tool = (id: string, kind: string, status?: string): ChatItem =>
  ({ type: "tool", id, call: { toolCallId: id, kind, status } }) as ChatItem;
const agent = (id: string): ChatItem => ({ type: "agent", id, text: "x" });
const perm = (id: string, resolved?: string | null): ChatItem =>
  ({ type: "permission", id, requestId: id, toolCall: { toolCallId: "t" }, options: [], resolved }) as ChatItem;

describe("chat timeline", () => {
  it("groups consecutive tool calls and keeps messages apart", () => {
    const segments = buildTimeline([agent("a"), tool("t1", "read"), tool("t2", "edit"), agent("b"), tool("t3", "search")]);
    expect(segments.map((s) => s.type)).toEqual(["item", "group", "item", "group"]);
    expect(segments[1].type === "group" && segments[1].steps).toHaveLength(2);
  });

  it("draws answered permissions as steps and leaves pending ones out", () => {
    const segments = buildTimeline([tool("t1", "execute"), perm("p1", "allow"), perm("p2")]);
    expect(segments).toHaveLength(1);
    expect(segments[0].type === "group" && segments[0].steps).toHaveLength(2);
  });

  it("counts steps per category and failures", () => {
    const segments = buildTimeline([tool("a", "read"), tool("b", "read"), tool("c", "search"), tool("d", "edit", "failed"), tool("e", "think")]);
    const { counts, failed } = summarizeSteps(segments[0].type === "group" ? segments[0].steps : []);
    expect(counts).toMatchObject({ read: 2, search: 1, edit: 1, other: 1 });
    expect(failed).toBe(1);
  });

  it("finds the tool still running", () => {
    expect(liveTool([tool("a", "read", "completed"), tool("b", "edit", "in_progress")])?.toolCallId).toBe("b");
    expect(liveTool([tool("a", "read", "completed")])).toBeNull();
  });
});
