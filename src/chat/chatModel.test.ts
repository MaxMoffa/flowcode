import { describe, expect, it } from "vitest";
import { applyEvent, initialChat, lineDiff, settleChat, type ChatModelState } from "./chatModel";
import type { ChatEvent, ChatToolCall } from "./chatTypes";

let seq = 0;
const next = () => ++seq;
const update = (u: Record<string, unknown>, s = next()): ChatEvent => ({ kind: "update", seq: s, at: 0, update: { sessionUpdate: "x", ...u } });
const chunk = (sessionUpdate: string, text: string): ChatEvent => update({ sessionUpdate, content: { type: "text", text } });
const run = (events: ChatEvent[], from: ChatModelState = settleChat(initialChat())) => events.reduce(applyEvent, from);
const tool = (state: ChatModelState, id: string) => {
  const item = state.items.find((i) => i.type === "tool" && i.id === id);
  return item?.type === "tool" ? item.call : undefined;
};

describe("chat model", () => {
  it("starts in 'starting' and settles to idle", () => {
    expect(initialChat().status).toBe("starting");
    expect(settleChat(initialChat()).status).toBe("idle");
  });

  it("merges consecutive text chunks and splits on other items", () => {
    const s = run([
      chunk("agent_message_chunk", "Ciao "),
      chunk("agent_message_chunk", "mondo"),
      chunk("agent_thought_chunk", "hm"),
      chunk("agent_thought_chunk", "m"),
      chunk("agent_message_chunk", "ok"),
    ]);
    expect(s.items.map((i) => [i.type, "text" in i ? i.text : ""])).toEqual([
      ["agent", "Ciao mondo"],
      ["thought", "hmm"],
      ["agent", "ok"],
    ]);
  });

  it("ignores non-text content", () => {
    const s = run([update({ sessionUpdate: "agent_message_chunk", content: { type: "image" } })]);
    expect(s.items).toEqual([]);
  });

  it("merges replayed user chunks into one item", () => {
    const s = run([chunk("user_message_chunk", "uno "), chunk("user_message_chunk", "due"), chunk("agent_message_chunk", "r")]);
    expect(s.items[0]).toMatchObject({ type: "user", text: "uno due" });
    expect(s.items).toHaveLength(2);
  });

  it("upserts a tool call by id, keeping its position", () => {
    const s = run([
      update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read a.ts", kind: "read", status: "pending" }),
      chunk("agent_message_chunk", "intanto"),
      update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }),
    ]);
    expect(s.items.map((i) => i.type)).toEqual(["tool", "agent"]);
    expect(tool(s, "t1")).toMatchObject({ title: "Read a.ts", kind: "read", status: "completed" } satisfies Partial<ChatToolCall>);
  });

  it("keeps the plan, commands and mode from their updates", () => {
    const s = run([
      update({ sessionUpdate: "plan", entries: [{ content: "a", status: "pending" }] }),
      update({ sessionUpdate: "plan", entries: [{ content: "a", status: "completed" }] }),
      update({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "init" }] }),
      update({ sessionUpdate: "current_mode_update", currentModeId: "plan" }),
    ]);
    expect(s.plan).toEqual([{ content: "a", status: "completed" }]);
    expect(s.commands).toEqual([{ name: "init" }]);
    expect(s.currentModeId).toBe("plan");
  });

  it("goes busy -> waiting -> busy -> idle around a permission", () => {
    let s = run([{ kind: "user", seq: next(), at: 0, text: "fai" }]);
    expect(s.status).toBe("busy");
    s = run([{ kind: "permission", seq: next(), at: 0, requestId: "r1", toolCall: { toolCallId: "t" }, options: [] }], s);
    expect(s.status).toBe("waiting");
    s = run([{ kind: "permissionResolved", seq: next(), at: 0, requestId: "r1", optionId: "allow" }], s);
    expect(s.status).toBe("busy");
    expect(s.items.find((i) => i.type === "permission")).toMatchObject({ resolved: "allow" });
    s = run([{ kind: "turnEnd", seq: next(), at: 0, stopReason: "end_turn" }], s);
    expect(s.status).toBe("idle");
  });

  it("exits for good", () => {
    const s = run([{ kind: "exit", seq: next(), at: 0, code: 1 }, chunk("agent_message_chunk", "late")]);
    expect(s.status).toBe("exited");
  });

  it("skips events at or below lastSeq", () => {
    const a = chunk("agent_message_chunk", "x");
    const once = run([a]);
    const twice = run([a, a], once);
    expect(twice.items).toEqual(once.items);
    expect(twice.lastSeq).toBe(a.seq);
  });

  it("shows a retrying notice until the agent makes progress again", () => {
    const user: ChatEvent = { kind: "user", seq: next(), at: 0, text: "a" };
    const retrying: ChatEvent = {
      kind: "ext",
      seq: next(),
      at: 0,
      method: "_session/retrying",
      params: { sessionId: "s", category: "rate_limited", detail: "HTTP 429" },
    };
    let s = run([user, retrying]);
    expect(s.notice).toEqual({ kind: "retrying", category: "rate_limited", detail: "HTTP 429" });
    expect(s.status).toBe("busy");
    s = run([chunk("agent_message_chunk", "ok")], s);
    expect(s.notice).toBeNull();
  });

  it("ignores a retry reported after the turn ended", () => {
    const s = run([
      { kind: "user", seq: next(), at: 0, text: "a" },
      { kind: "turnEnd", seq: next(), at: 0, stopReason: "cancelled" },
      { kind: "ext", seq: next(), at: 0, method: "_session/retrying", params: { category: "rate_limited" } },
    ]);
    expect(s.notice).toBeNull();
  });

  it("clears the retrying notice on turnEnd", () => {
    const s = run([
      { kind: "ext", seq: next(), at: 0, method: "_session/retrying", params: { category: "rate_limited" } },
      { kind: "turnEnd", seq: next(), at: 0, stopReason: "end_turn" },
    ]);
    expect(s.notice).toBeNull();
  });

  it("ignores other extension notifications", () => {
    const s = run([{ kind: "ext", seq: next(), at: 0, method: "_other", params: {} }]);
    expect(s.notice).toBeNull();
    expect(s.status).toBe("idle");
  });

  it("turns an error into a notice and stops the turn", () => {
    const s = run([{ kind: "user", seq: next(), at: 0, text: "a" }, { kind: "error", seq: next(), at: 0, message: "boom" }]);
    expect(s.items[1]).toMatchObject({ type: "error", message: "boom" });
    expect(s.status).toBe("idle");
  });
});

describe("lineDiff", () => {
  it("lists all lines as added for a new file", () => {
    expect(lineDiff(null, "a\nb\n")).toEqual([
      { type: "add", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  it("marks changed lines and keeps the common ones", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "ctx", text: "c" },
    ]);
  });

  it("handles an emptied file", () => {
    expect(lineDiff("a", "")).toEqual([{ type: "del", text: "a" }]);
  });

  it("falls back to the first 200 additions on big inputs", () => {
    const big = Array.from({ length: 500 }, (_, i) => `l${i}`).join("\n");
    const rows = lineDiff("x", big);
    expect(rows).toHaveLength(200);
    expect(rows.every((r) => r.type === "add")).toBe(true);
  });
});

describe("forward compatibility", () => {
  it("ignores an event kind it does not know", () => {
    const state = applyEvent(initialChat(), { seq: 1, at: 0, kind: "fromTheFuture" } as unknown as ChatEvent);
    expect(state.items).toEqual([]);
    expect(state.lastSeq).toBe(1);
  });
});

describe("prompt echo", () => {
  it("drops user chunks echoing a prompt sent from this app", () => {
    let n = 1000;
    const s = [
      { kind: "user", seq: ++n, at: 0, text: "Rispondi solo OK" },
      { kind: "update", seq: ++n, at: 0, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Rispondi solo OK" } } },
      { kind: "update", seq: ++n, at: 0, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } } },
    ].reduce((st, ev) => applyEvent(st, ev as ChatEvent), settleChat(initialChat()));
    expect(s.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["Rispondi solo OK", "OK"]);
  });

  it("still rebuilds replayed history from user chunks", () => {
    const s = applyEvent(initialChat(), { kind: "update", seq: 1, at: 0, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "ciao" } } } as ChatEvent);
    expect(s.items).toMatchObject([{ type: "user", text: "ciao" }]);
  });
});
