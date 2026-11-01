import { describe, expect, it } from "vitest";
import type { ChatItem } from "./chatModel";
import { applyEvent, initialChat, settleChat } from "./chatModel";
import type { ChatEvent } from "./chatTypes";
import { buildTimeline, findSubagent, subagentTimeline, liveTool, nestSubagents, subagentInfo, subagentPrompt, subagentReport, subagentState, summarizeSteps } from "./chatTimeline";

const tool = (id: string, kind: string, status?: string): ChatItem =>
  ({ type: "tool", id, call: { toolCallId: id, kind, status } }) as ChatItem;
const agent = (id: string): ChatItem => ({ type: "agent", id, text: "x" });
const perm = (id: string, resolved?: string | null): ChatItem =>
  ({ type: "permission", id, requestId: id, toolCall: { toolCallId: "t" }, options: [], resolved }) as ChatItem;

describe("Codex subagents", () => {
  const update = (seq: number, toolCallId: string, fields: Record<string, unknown>): ChatEvent => ({
    kind: "update", seq, at: seq * 1000,
    update: { sessionUpdate: "tool_call_update", toolCallId, ...fields },
  });
  const spawn = (seq: number, id: string, thread: string): ChatEvent => update(seq, id, {
    sessionUpdate: "tool_call", title: "spawnAgent", status: "in_progress", kind: "other",
    rawInput: { prompt: `Inspect ${thread}`, senderThreadId: "root", receiverThreadIds: [], agentsStates: {} },
  });
  const spawned = (seq: number, id: string, thread: string): ChatEvent => update(seq, id, {
    status: "completed", rawInput: { prompt: `Inspect ${thread}`, senderThreadId: "root", receiverThreadIds: [thread], agentsStates: { [thread]: { status: "running" } }, status: "completed" },
  });

  it("shows parallel launches and keeps them running after spawn returns", () => {
    const state = [spawn(1, "s1", "a"), spawned(2, "s1", "a"), spawn(3, "s2", "b"), spawned(4, "s2", "b")].reduce(applyEvent, settleChat(initialChat()));
    const subs = buildTimeline(state.items).flatMap((s) => s.type === "subagents" ? s.items : []);
    expect(subs.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(subs.every((s) => subagentState(s).running)).toBe(true);
    expect(subagentInfo(subs[0].call).description).toBe("Inspect a");
    expect(subagentPrompt(subs[0].call)).toBe("Inspect a");
    expect(subagentReport(subs[0].call)).toBe("");
  });

  it("finishes only the reported child and uses its report, not the spawn prompt", () => {
    const state = [spawn(1, "s1", "a"), spawned(2, "s1", "a"), spawn(3, "s2", "b"), spawned(4, "s2", "b"), update(5, "wait", {
      title: "wait", status: "completed", rawInput: { senderThreadId: "root", receiverThreadIds: ["a", "b"], agentsStates: { a: { status: "completed", message: "Found the cause" }, b: { status: "running" } } },
    })].reduce(applyEvent, settleChat(initialChat()));
    expect(subagentState(findSubagent(state.items, "s1")!)).toMatchObject({ running: false, failed: false, seconds: 4 });
    expect(subagentReport(findSubagent(state.items, "s1")!.call)).toBe("Found the cause");
    expect(subagentState(findSubagent(state.items, "s2")!).running).toBe(true);
    expect(findSubagent(state.items, "wait")).toBeNull();
  });

  it("links activity to its launch and supports failure and resume", () => {
    let state = [spawn(1, "s1", "a"), spawned(2, "s1", "a"), update(3, "activity", {
      title: "Start subagent reviewer", status: "completed", rawInput: { agentThreadId: "a", agentPath: "/root/reviewer", activityKind: "started" },
    }), update(4, "wait", {
      title: "wait", status: "completed", rawInput: { agentsStates: { a: { status: "errored", message: "Failed to read" } } },
    })].reduce(applyEvent, settleChat(initialChat()));
    const failed = findSubagent(state.items, "s1")!;
    expect(failed.steps.map((s) => s.id)).toEqual(["activity"]);
    expect(subagentInfo(failed.call).type).toBe("reviewer");
    expect(subagentState(failed)).toMatchObject({ running: false, failed: true });
    state = applyEvent(state, update(5, "resume", { title: "resumeAgent", status: "completed", rawInput: { agentsStates: { a: { status: "running" } } } }));
    expect(subagentState(findSubagent(state.items, "s1")!)).toMatchObject({ running: true, seconds: null });
    expect(subagentReport(findSubagent(state.items, "s1")!.call)).toBe("");
  });

  it("keeps the report when a later completion activity has no message", () => {
    const state = [spawn(1, "s1", "a"), spawned(2, "s1", "a"), update(3, "wait", {
      title: "wait", status: "completed", rawInput: { agentsStates: { a: { status: "completed", message: "Final report" } } },
    }), update(4, "activity", {
      title: "Complete subagent reviewer", status: "completed", rawInput: { agentThreadId: "a", agentPath: "/root/reviewer", activityKind: "completed" },
    })].reduce(applyEvent, settleChat(initialChat()));
    expect(subagentReport(findSubagent(state.items, "s1")!.call)).toBe("Final report");
    expect(findSubagent(state.items, "s1")!.call.endedAt).toBe(3000);
  });

  it("nests a child launched by a known Codex subagent", () => {
    const state = [spawn(1, "s1", "a"), spawned(2, "s1", "a"), update(3, "s2", {
      title: "spawnAgent", status: "completed", rawInput: { senderThreadId: "a", receiverThreadIds: ["b"], agentsStates: { b: { status: "running" } } },
    })].reduce(applyEvent, settleChat(initialChat()));
    expect(nestSubagents(state.items).map((s) => s.id)).toEqual(["s1"]);
    expect(findSubagent(state.items, "s2")).not.toBeNull();
  });

  it("ends a spawn that fails before a child thread exists", () => {
    const state = [spawn(1, "s1", "a"), update(2, "s1", { status: "failed", content: [{ type: "content", content: { type: "text", text: "No slots available" } }] })].reduce(applyEvent, settleChat(initialChat()));
    expect(subagentState(findSubagent(state.items, "s1")!)).toMatchObject({ running: false, failed: true, seconds: 1 });
    expect(subagentReport(findSubagent(state.items, "s1")!.call)).toBe("No slots available");
  });

  it("removes running Codex children after cancellation or process exit", () => {
    const state = [spawn(1, "s1", "a"), spawned(2, "s1", "a")].reduce(applyEvent, settleChat(initialChat()));
    for (const event of [{ kind: "turnEnd", stopReason: "cancelled" }, { kind: "exit", code: 1 }] as const) {
      const closed = applyEvent(state, { ...event, seq: 3, at: 3000 });
      expect(subagentState(findSubagent(closed.items, "s1")!).running).toBe(false);
    }
  });
});

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
      expect(segments.map((s) => s.type)).toEqual(["group", "subagents"]);
      const subs = segments.flatMap((s) => (s.type === "subagents" ? s.items : []));
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

    it("counts a finished subagent woken by a message as running while its new steps are open", () => {
      seq = 0;
      const events: ChatEvent[] = [launch("s1", "Explore", "code", 1000), step("a1", "s1", "completed"), finish("s1", "completed", "report", 3000), step("a2", "s1", "in_progress")];
      const state = events.reduce(applyEvent, settleChat(initialChat()));
      const sub = findSubagent(state.items, "s1")!;
      expect(subagentState(sub)).toMatchObject({ running: true, seconds: null });
      expect(subagentState(sub).current?.toolCallId).toBe("a2");
      // Its last step ends: finished again.
      const done = applyEvent(state, { kind: "update", seq: ++seq, at: 0, update: { sessionUpdate: "tool_call_update", toolCallId: "a2", status: "completed" } });
      expect(subagentState(findSubagent(done.items, "s1")!).running).toBe(false);
    });

    it("closes the open steps of a finished subagent when the turn ends, the chat settles or the agent exits", () => {
      seq = 0;
      const events: ChatEvent[] = [launch("s1", "Explore", "code", 1000), finish("s1", "completed", "report", 3000), step("a2", "s1", "in_progress")];
      const open = events.reduce(applyEvent, settleChat(initialChat()));
      const running = (s: typeof open) => subagentState(findSubagent(s.items, "s1")!).running;
      expect(running(open)).toBe(true);
      expect(running(applyEvent(open, { kind: "turnEnd", seq: 99, at: 0, stopReason: "cancelled" } as ChatEvent))).toBe(false);
      expect(running(settleChat(open))).toBe(false);
      expect(running(applyEvent(open, { kind: "exit", seq: 99, at: 0 } as ChatEvent))).toBe(false);
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
