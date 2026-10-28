import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chatModel";
import { applyEvent, initialChat, settleChat } from "./chatModel";
import type { ChatEvent } from "./chatTypes";
import { buildTimeline, findSubagent, subagentTimeline, liveTool, nestSubagents, subagentInfo, subagentReport, subagentState, summarizeSteps } from "./chatTimeline";

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

  it("hides approved and running guardian reviews, keeps denied ones", () => {
    const segments = buildTimeline([
      tool("t1", "execute", "completed"),
      tool("guardian_assessment:a", "think", "completed"),
      tool("guardian_assessment:b", "think", "in_progress"),
      tool("guardian_assessment:c", "think", "failed"),
      tool("t2", "read"),
    ]);
    expect(segments).toHaveLength(1);
    const steps = segments[0].type === "group" ? segments[0].steps : [];
    expect(steps.map((s) => (s.type === "tool" ? s.call.toolCallId : s.id))).toEqual(["t1", "guardian_assessment:c", "t2"]);
  });

  describe("subagents", () => {
    let seq = 0;
    const launch = (id: string, type: string, description: string, at: number): ChatEvent => ({
      kind: "update", seq: ++seq, at,
      update: { sessionUpdate: "tool_call", toolCallId: id, title: description, kind: "think", status: "in_progress", rawInput: { subagent_type: type, description, prompt: "go" }, content: [{ type: "content", content: { type: "text", text: "go" } }], _meta: { claudeCode: { toolName: "Agent" } } },
    });
    const step = (id: string, parent: string, status: string, title = id): ChatEvent => ({
      kind: "update", seq: ++seq, at: 0,
      update: { sessionUpdate: "tool_call", toolCallId: id, title, kind: "read", status, _meta: { claudeCode: { parentToolUseId: parent, toolName: "Read" } } },
    });
    const finish = (id: string, status: string, text: string, at: number): ChatEvent => ({
      kind: "update", seq: ++seq, at,
      update: { sessionUpdate: "tool_call_update", toolCallId: id, status, content: [{ type: "content", content: { type: "text", text } }] },
    });
    const mainTool: ChatEvent = { kind: "update", seq: 0, at: 0, update: { sessionUpdate: "tool_call", toolCallId: "m1", title: "Read a", kind: "read", status: "completed" } };

    it("nests the steps of three parallel subagents under their launches", () => {
      seq = 0;
      const events: ChatEvent[] = [
        { ...mainTool, seq: ++seq },
        launch("s1", "Explore", "code", 1000), launch("s2", "Explore", "tests", 1000), launch("s3", "Plan", "plan", 1000),
        step("a1", "s1", "completed"), step("b1", "s2", "completed"), step("c1", "s3", "in_progress"),
        step("b2", "s2", "failed"), step("b3", "s2", "completed"), step("a2", "s1", "completed"),
        finish("s1", "completed", "report one", 8000), finish("s2", "completed", "report two", 10000),
      ];
      const state = events.reduce(applyEvent, settleChat(initialChat()));
      const segments = buildTimeline(state.items);
      expect(segments.map((s) => s.type)).toEqual(["group", "subagent", "subagent", "subagent"]);
      const subs = segments.flatMap((s) => (s.type === "subagent" ? [s.item] : []));
      expect(subs.map((s) => s.steps.length)).toEqual([2, 3, 1]);
      expect(subagentInfo(subs[0].call)).toEqual({ type: "Explore", description: "code" });
      expect(subagentReport(subs[0].call)).toBe("report one");
      expect(subagentReport(subs[2].call)).toBe("");
      expect(subagentState(subs[0])).toMatchObject({ running: false, failed: false, seconds: 7 });
      expect(subagentState(subs[1])).toMatchObject({ running: false, failedSteps: 1 });
      expect(subagentState(subs[2])).toMatchObject({ running: true });
      expect(subagentState(subs[2]).current?.toolCallId).toBe("c1");
      // The main agent's own group holds only its call.
      expect(segments[0].type === "group" && segments[0].steps).toHaveLength(1);
    });

    it("leaves tool calls with an unknown parent where they are", () => {
      const items = [tool("t1", "read"), { type: "tool", id: "x", call: { toolCallId: "x", parentToolUseId: "ghost" } } as ChatItem];
      expect(nestSubagents(items)).toEqual(items);
      expect(buildTimeline(items).map((s) => s.type)).toEqual(["group"]);
    });
  });
});

describe("subagent transcripts", () => {
  let seq = 0;
  const text = (kind: "agent_message_chunk" | "agent_thought_chunk", t: string, parent?: string): ChatEvent => ({
    kind: "update", seq: ++seq, at: 0,
    update: { sessionUpdate: kind, content: { type: "text", text: t }, ...(parent ? { _meta: { claudeCode: { parentToolUseId: parent } } } : {}) },
  });
  const launch = (id: string): ChatEvent => ({
    kind: "update", seq: ++seq, at: 0,
    update: { sessionUpdate: "tool_call", toolCallId: id, title: id, kind: "think", status: "in_progress", rawInput: { subagent_type: "Explore", description: id, prompt: `task ${id}` }, _meta: { claudeCode: { toolName: "Agent" } } },
  });
  const step = (id: string, parent: string): ChatEvent => ({
    kind: "update", seq: ++seq, at: 0,
    update: { sessionUpdate: "tool_call", toolCallId: id, kind: "read", status: "completed", _meta: { claudeCode: { parentToolUseId: parent, toolName: "Read" } } },
  });

  it("keeps interleaved chunks of the main agent and two subagents apart", () => {
    seq = 0;
    const events = [
      text("agent_message_chunk", "Hel"),
      launch("s1"), launch("s2"),
      text("agent_thought_chunk", "a-think ", "s1"),
      text("agent_message_chunk", "lo ", undefined),
      text("agent_message_chunk", "A1 ", "s1"),
      text("agent_message_chunk", "B1", "s2"),
      text("agent_message_chunk", "world"),
      step("a-read", "s1"),
      text("agent_message_chunk", "A2", "s1"),
      text("agent_message_chunk", "A3", "s1"),
    ];
    const state = events.reduce(applyEvent, settleChat(initialChat()));
    const flow = nestSubagents(state.items);
    // The main flow reads as if the subagents said nothing.
    expect(flow.map((i) => i.type)).toEqual(["agent", "subagent", "subagent", "agent"]);
    // The launches break the main run as any tool call does; subagent chunks in between do not.
    expect(flow[0]).toMatchObject({ text: "Hel" });
    expect(flow[3]).toMatchObject({ text: "lo world" });
    const [s1, s2] = flow.slice(1, 3) as ReturnType<typeof nestSubagents> & Array<{ children: ChatItem[]; steps: unknown[] }>;
    expect(s1.children.map((c) => [c.type, "text" in c ? c.text : c.id])).toEqual([
      ["thought", "a-think "],
      ["agent", "A1 "],
      ["tool", "a-read"],
      ["agent", "A2A3"],
    ]);
    expect(s1.steps).toHaveLength(1);
    expect(s2.children.map((c) => ("text" in c ? c.text : ""))).toEqual(["B1"]);
  });

  it("appends the report once the subagent finished, unless it just said it", () => {
    seq = 0;
    const done = (id: string, report: string): ChatEvent => ({
      kind: "update", seq: ++seq, at: 0,
      update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "content", content: { type: "text", text: report } }] },
    });
    const state = [launch("s1"), text("agent_message_chunk", "same", "s1"), done("s1", "same"), launch("s2"), text("agent_message_chunk", "part", "s2"), done("s2", "final")].reduce(applyEvent, settleChat(initialChat()));
    const subs = nestSubagents(state.items).filter((i) => i.type === "subagent") as ReturnType<typeof findSubagent>[];
    expect(subagentTimeline(subs[0]!)).toHaveLength(1);
    expect(subagentTimeline(subs[1]!)).toHaveLength(2);
    expect(findSubagent(state.items, "nope")).toBeNull();
  });

  it("keeps a subagent launched by a subagent out of the main flow, but findable", () => {
    const child = (id: string, parent: string): ChatItem => ({ type: "tool", id, call: { toolCallId: id, kind: "read", parentToolUseId: parent } }) as ChatItem;
    const launchItem = (id: string, parent?: string): ChatItem =>
      ({ type: "tool", id, call: { toolCallId: id, kind: "think", parentToolUseId: parent, rawInput: { subagent_type: "general" }, _meta: { claudeCode: { toolName: "Agent" } } } }) as ChatItem;
    const items = [launchItem("s1"), launchItem("s2", "s1"), child("r1", "s2")];
    const flow = nestSubagents(items);
    expect(flow.filter((i) => i.type === "subagent").map((i) => i.id)).toEqual(["s1"]);
    expect(flow).toHaveLength(1);
    const s1 = flow[0] as { children: ChatItem[] };
    expect(s1.children.map((c) => c.id)).toEqual(["s2", "r1"]);
    expect(findSubagent(items, "s2")?.steps.map((c) => c.id)).toEqual(["r1"]);
  });
});
