import { describe, expect, it } from "vitest";
import { applyEvent, applyLocalError, configModels, configModelValue, forceCancels, initialChat, liveModels, MODEL_EXT_METHOD, normalizeModels, isAgentBusy, isAgentExited, lineDiff, liveThought, mergeReplay, normalizeThought, THOUGHT_EXT_METHOD, settleChat, stopKind, type ChatModelState } from "./chatModel";
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

  it("lists replayed files and images as attachments of the user item", () => {
    const file = (content: Record<string, unknown>) => update({ sessionUpdate: "user_message_chunk", content });
    const s = run([chunk("user_message_chunk", "guarda"), file({ type: "resource_link", name: "a.pdf", uri: "file:///a.pdf" }), file({ type: "image", data: "x" })]);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ type: "user", text: "guarda", attachments: ["a.pdf", "image"] });
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

  it("marks permission requests still open at exit as cancelled, and keeps answered ones", () => {
    const s = run([
      { kind: "user", seq: next(), at: 0, text: "fai" },
      { kind: "permission", seq: next(), at: 0, requestId: "a", toolCall: { toolCallId: "t" }, options: [] },
      { kind: "permissionResolved", seq: next(), at: 0, requestId: "a", optionId: "allow" },
      { kind: "permission", seq: next(), at: 0, requestId: "b", toolCall: { toolCallId: "t" }, options: [] },
      { kind: "exit", seq: next(), at: 0, code: null },
    ]);
    const perms = s.items.filter((i) => i.type === "permission");
    expect(perms.map((p) => (p.type === "permission" ? p.resolved : "x"))).toEqual(["allow", null]);
    expect(s.status).toBe("exited");
    expect(s.turnActive).toBe(false);
  });

  it("says why a turn stopped when it did not just finish or get cancelled", () => {
    const end = (stopReason: string): ChatEvent => ({ kind: "turnEnd", seq: next(), at: 0, stopReason });
    const s = run([end("end_turn"), end("cancelled"), end(""), end("max_tokens"), end("max_turn_requests"), end("refusal"), end("something_new")]);
    expect(s.items.map((i) => (i.type === "stop" ? i.reason : i.type))).toEqual(["max_tokens", "max_turn_requests", "refusal", "something_new"]);
    expect(new Set(s.items.map((i) => i.id)).size).toBe(4);
    expect(s.status).toBe("idle");
    expect(["max_tokens", "max_turn_requests", "refusal", "something_new"].map(stopKind)).toEqual(["maxTokens", "maxTurnRequests", "refusal", "other"]);
  });

  describe("compaction", () => {
    const comp = (u: Record<string, unknown>, at = 0): ChatEvent => ({ kind: "update", seq: next(), at, update: { sessionUpdate: "compaction_update", compactionId: "c1", ...u } });
    const summaryChunk = (text: string): ChatEvent => update({ sessionUpdate: "compaction_summary_chunk", compactionId: "c1", content: { type: "text", text } });
    const item = (s: ChatModelState) => s.items.find((i) => i.type === "compaction");

    it("creates the item on the first update and finishes it on the next", () => {
      const s1 = run([comp({ status: "in_progress" }, 5)]);
      expect(item(s1)).toMatchObject({ id: "compaction:c1", status: "in_progress", summary: "", at: 5, manual: false });
      const s2 = run([comp({ status: "completed", summary: [{ type: "text", text: "Done " }, { type: "text", text: "well" }] })], s1);
      expect(s2.items).toHaveLength(1);
      expect(item(s2)).toMatchObject({ status: "completed", summary: "Done well", at: 5 });
    });

    it("streams the summary through chunks, creating the item if needed", () => {
      const s = run([summaryChunk("Hel"), summaryChunk("lo")]);
      expect(item(s)).toMatchObject({ status: "in_progress", summary: "Hello" });
    });

    it("keeps the settled status on a duplicate terminal or a late in_progress", () => {
      const s = run([comp({ status: "completed" }), comp({ status: "in_progress" }), comp({ status: "completed" })]);
      expect(s.items).toHaveLength(1);
      expect(item(s)).toMatchObject({ status: "completed" });
    });

    it("keeps the streamed summary when the terminal update carries none", () => {
      const s = run([summaryChunk("kept"), comp({ status: "completed" })]);
      expect(item(s)).toMatchObject({ status: "completed", summary: "kept" });
    });

    it("is manual when the last user message is /compact", () => {
      const user = (text: string): ChatEvent => ({ kind: "user", seq: next(), at: 0, text });
      expect(item(run([user("hi"), comp({ status: "in_progress" })]))).toMatchObject({ manual: false });
      expect(item(run([user("hi"), user("  /compact keep this"), comp({ status: "in_progress" })]))).toMatchObject({ manual: true });
    });

    it("records the error of a failed compaction", () => {
      const s = run([comp({ status: "in_progress" }), comp({ status: "failed", error: "prompt too long" })]);
      expect(item(s)).toMatchObject({ status: "failed", error: "prompt too long" });
    });

    it("keeps unchanged items by reference", () => {
      const s1 = run([chunk("agent_message_chunk", "a"), comp({ status: "in_progress" })]);
      const s2 = run([comp({ status: "completed" })], s1);
      expect(s2.items[0]).toBe(s1.items[0]);
    });

    it("clears the retry notice", () => {
      const base = { ...settleChat(initialChat()), notice: { kind: "retrying" as const, category: "x", detail: "" } };
      expect(run([comp({ status: "in_progress" })], base).notice).toBeNull();
    });
  });

  it("times the turn from the event, counts streamed characters, and clears it at turnEnd", () => {
    const at = (ev: ChatEvent, t: number): ChatEvent => ({ ...ev, at: t });
    let s = run([at({ kind: "user", seq: next(), at: 0, text: "a" }, 5000)]);
    expect(s.turn).toEqual({ startedAt: 5000, outChars: 0 });
    s = run([at(chunk("agent_thought_chunk", "abc"), 5100), at(chunk("agent_message_chunk", "de"), 5200)], s);
    expect(s.turn).toEqual({ startedAt: 5000, outChars: 5 });
    s = run([{ kind: "turnEnd", seq: next(), at: 6000, stopReason: "end_turn" } as ChatEvent], s);
    expect(s.turn).toBeNull();
  });

  it("starts the turn at the first update when joined mid-way", () => {
    // Joining a running turn (a phone opening a busy chat) marks the model busy without a turn start; the next update times it.
    const joined: ChatModelState = { ...settleChat(initialChat()), turnActive: true, status: "busy" };
    const s = run([{ ...chunk("agent_message_chunk", "hello"), at: 7000 }], joined);
    expect(s.turn).toEqual({ startedAt: 7000, outChars: 5 });
    expect(settleChat(s).turn).toBeNull();
  });

  // Before: agent chunks, tool calls and plans set turnActive, so a resumed
  // session's replayed history (or a stray update after turnEnd) left the chat
  // "busy" with no turnEnd to come. Now only a `user` event starts a turn.
  it("does not start a turn from replayed history or stray updates", () => {
    const s = run([
      chunk("user_message_chunk", "ciao"),
      chunk("agent_message_chunk", "risposta"),
      update({ sessionUpdate: "tool_call", toolCallId: "h1", title: "Read", status: "completed" }),
      update({ sessionUpdate: "plan", entries: [{ content: "a", status: "pending" }] }),
    ]);
    expect(s.turnActive).toBe(false);
    expect(s.status).toBe("idle");
    expect(s.turn).toBeNull();
    expect(s.items.map((i) => i.type)).toEqual(["user", "agent", "tool"]);
  });

  it("stays busy through a turn started here until its turnEnd", () => {
    let s = run([{ kind: "user", seq: next(), at: 10, text: "vai" }, chunk("agent_message_chunk", "ok"), update({ sessionUpdate: "tool_call", toolCallId: "t9", status: "in_progress" })]);
    expect(s.status).toBe("busy");
    expect(s.turn?.startedAt).toBe(10);
    s = run([{ kind: "turnEnd", seq: next(), at: 0, stopReason: "end_turn" }], s);
    expect(s.status).toBe("idle");
    // A late update after the turn ended doesn't bring "busy" back.
    s = run([chunk("agent_message_chunk", " tardi")], s);
    expect(s.status).toBe("idle");
  });

  it("replaces only the item that changed, so unchanged items keep their identity", () => {
    const a = run([chunk("agent_message_chunk", "uno"), update({ sessionUpdate: "tool_call", toolCallId: "k", status: "pending" }), chunk("agent_message_chunk", "due")]);
    const b = run([chunk("agent_message_chunk", " tre")], a);
    expect(b.items[0]).toBe(a.items[0]);
    expect(b.items[1]).toBe(a.items[1]);
    expect(b.items[2]).not.toBe(a.items[2]);
    const c = run([update({ sessionUpdate: "tool_call_update", toolCallId: "k", status: "completed" })], b);
    expect(c.items[0]).toBe(b.items[0]);
    expect(c.items[2]).toBe(b.items[2]);
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

describe("local errors", () => {
  it("appends an error with a unique id and leaves lastSeq alone", () => {
    const base = run([{ kind: "user", seq: 500, at: 0, text: "a" }]);
    let s = applyLocalError(base, "uno");
    s = applyLocalError(s, "due");
    s = applyLocalError(s, "tre");
    expect(s.lastSeq).toBe(500);
    const errors = s.items.filter((i) => i.type === "error");
    expect(errors.map((e) => (e.type === "error" ? e.message : ""))).toEqual(["uno", "due", "tre"]);
    expect(new Set(errors.map((e) => e.id)).size).toBe(3);
    // The backend's next event still applies: a fractional local seq used to be able to swallow it.
    s = applyEvent(s, { kind: "update", seq: 501, at: 0, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dopo" } } });
    expect(s.items[s.items.length - 1]).toMatchObject({ type: "agent", text: "dopo" });
  });

  it("does not change the turn", () => {
    const busy = run([{ kind: "user", seq: next(), at: 0, text: "a" }]);
    expect(applyLocalError(busy, "x").status).toBe("busy");
    expect(applyLocalError(settleChat(initialChat()), "x").status).toBe("idle");
  });

  it("shows the same failure once, whichever side reports it first", () => {
    const sent = run([{ kind: "user", seq: next(), at: 0, text: "a" }]);
    // The refused call first, then the backend's error event.
    let s = applyLocalError(sent, "boom");
    s = applyEvent(s, { kind: "error", seq: next(), at: 0, message: "boom" });
    expect(s.items.filter((i) => i.type === "error")).toHaveLength(1);
    expect(s.status).toBe("idle");
    // The event first, then the refused call.
    let t = applyEvent(sent, { kind: "error", seq: next(), at: 0, message: "boom" });
    t = applyLocalError(t, "boom");
    expect(t.items.filter((i) => i.type === "error")).toHaveLength(1);
    // A different message is a different error.
    expect(applyLocalError(t, "other").items.filter((i) => i.type === "error")).toHaveLength(2);
  });

  it("recognizes the backend's refusals by their prefix", () => {
    expect(isAgentBusy("agent_busy: the agent is working")).toBe(true);
    expect(isAgentBusy("boom agent_busy")).toBe(false);
    expect(isAgentExited("agent_exited")).toBe(true);
    expect(isAgentExited("agent_busy")).toBe(false);
  });
});

describe("mergeReplay", () => {
  const ev = (s: number, text = `e${s}`): ChatEvent => ({ kind: "update", seq: s, at: 0, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

  it("sorts by seq and keeps each event once", () => {
    const merged = mergeReplay([ev(1), ev(2), ev(3)], [ev(3), ev(5), ev(4)]);
    expect(merged.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(mergeReplay([], [])).toEqual([]);
  });

  it("keeps the resumed history that live events arriving first would have hidden", () => {
    const past = [
      { kind: "update", seq: 1, at: 0, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "domanda" } } },
      ev(2, "risposta"),
    ] as ChatEvent[];
    const live = [ev(3, " e altro")];
    // The old order: live applied first raised lastSeq to 3 and the replay was skipped.
    const lost = [...live, ...past].reduce(applyEvent, initialChat());
    expect(lost.items).toHaveLength(1);
    const kept = settleChat(mergeReplay(past, live).reduce(applyEvent, initialChat()));
    expect(kept.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["domanda", "risposta e altro"]);
    expect(kept.status).toBe("idle");
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

  it("follows the model from the backend's event and from config option updates", () => {
    expect(initialChat().currentModelId).toBeNull();
    let s = run([{ kind: "ext", seq: next(), at: 0, method: MODEL_EXT_METHOD, params: { currentModelId: "opus", availableModels: [] } }]);
    expect(s.currentModelId).toBe("opus");
    // Junk leaves it alone.
    s = run([{ kind: "ext", seq: next(), at: 0, method: MODEL_EXT_METHOD, params: { currentModelId: 3 } }], s);
    expect(s.currentModelId).toBe("opus");
    s = run([update({ sessionUpdate: "config_option_update", configOptions: [{ id: "llm", category: "model", type: "select", currentValue: "haiku", options: [] }] })], s);
    expect(s.currentModelId).toBe("haiku");
    s = run([update({ sessionUpdate: "config_option_update", configOptions: [{ id: "mode", category: "mode", currentValue: "plan" }] })], s);
    expect(s.currentModelId).toBe("haiku");
    // Not an event of a turn: the status doesn't move.
    expect(s.status).toBe("idle");
  });

  it("finds the model among config options", () => {
    expect(configModelValue([{ id: "mode", category: "mode", currentValue: "a" }, { id: "x", category: "model", currentValue: "m1" }])).toBe("m1");
    expect(configModelValue([{ id: "model", currentValue: "m2" }])).toBe("m2");
    expect(configModelValue([{ id: "model", category: "mode", currentValue: "m2" }, { id: "y", category: "model", currentValue: "m3" }])).toBe("m3");
    expect(configModelValue([{ id: "model", currentValue: 4 }])).toBeNull();
    expect(configModelValue([null, "x"])).toBeNull();
    expect(configModelValue({ id: "model" })).toBeNull();
    expect(configModelValue(undefined)).toBeNull();
  });

  it("offers a model choice only between two or more, the live model first", () => {
    const models = { currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }, { modelId: "b", name: "B" }] };
    expect(liveModels(models, null)).toBe(models);
    expect(liveModels(models, "a")).toBe(models);
    expect(liveModels(models, "b")?.currentModelId).toBe("b");
    expect(liveModels({ currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }] }, null)).toBeNull();
    expect(liveModels(null, "b")).toBeNull();
  });
});

describe("merged replay chunks", () => {
  const text = (s: number, t: string): ChatEvent => ({ kind: "update", seq: s, at: 0, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } } });

  it("keeps only live events newer than the replay: a merged entry already holds the older chunks", () => {
    // The log merged chunks 10..12 into one entry with the last chunk's seq; the listener caught 10, 11 and 13 live.
    const past = [{ kind: "user", seq: 9, at: 0, text: "q" } as ChatEvent, text(12, "abc")];
    const live = [text(10, "a"), text(11, "b"), text(13, "d")];
    const merged = mergeReplay(past, live);
    expect(merged.map((e) => e.seq)).toEqual([9, 12, 13]);
    const s = merged.reduce(applyEvent, initialChat());
    expect(s.items.map((i) => ("text" in i ? i.text : ""))).toEqual(["q", "abcd"]);
  });

  it("takes every live event when the replay is empty", () => {
    expect(mergeReplay([], [text(2, "b"), text(1, "a")]).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("the thinking levels from events", () => {
  const ext = (params: unknown): ChatEvent => ({ kind: "ext", seq: next(), at: 0, method: THOUGHT_EXT_METHOD, params });
  const levels = { currentId: "high", available: [{ id: "low", name: "Low" }, { id: "high", name: "High", description: "Thinks a lot" }] };

  it("is unknown until an event says, then follows `_flowcode/thought`", () => {
    expect(initialChat().thought).toBeUndefined();
    let s = run([ext(levels)]);
    expect(s.thought).toEqual(levels);
    // The levels change with the model.
    s = run([ext({ currentId: "max", available: [...levels.available, { id: "max", name: "Max" }] })], s);
    expect(s.thought?.available).toHaveLength(3);
    expect(s.thought?.currentId).toBe("max");
    // Not offered any more.
    s = run([ext({ currentId: null, available: [] })], s);
    expect(s.thought).toBeNull();
  });

  it("ignores junk and keeps the announced one holding until an event says", () => {
    const s = run([ext("x"), ext({ currentId: "low" })]);
    expect(s.thought).toBeUndefined();
    expect(liveThought(s.thought !== undefined ? s.thought : levels)).toBe(levels);
  });

  it("offers a choice only with two levels or more, and normalizes defensively", () => {
    expect(liveThought(levels)).toBe(levels);
    expect(liveThought({ currentId: "a", available: [{ id: "a", name: "A" }] })).toBeNull();
    expect(liveThought(null)).toBeNull();
    expect(normalizeThought({ available: [{ id: "a", name: "A" }, { name: "no id" }, null] })).toEqual({ currentId: "a", available: [{ id: "a", name: "A" }] });
    expect(normalizeThought({ currentId: "a", available: [] })).toBeNull();
    expect(normalizeThought(5)).toBeNull();
  });
});

describe("the model list from events", () => {
  const ext = (params: unknown): ChatEvent => ({ kind: "ext", seq: next(), at: 0, method: MODEL_EXT_METHOD, params });
  const two = { currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }, { modelId: "b", name: "B" }] };

  it("is unknown until an event says, then follows `_flowcode/model`", () => {
    expect(initialChat().models).toBeUndefined();
    let s = run([ext(two)]);
    expect(s.models).toEqual(two);
    expect(s.currentModelId).toBe("a");
    s = run([ext({ currentModelId: "b", availableModels: [...two.availableModels, { modelId: "c", name: "C" }] })], s);
    expect(s.models?.availableModels).toHaveLength(3);
    expect(s.currentModelId).toBe("b");
    // No model to choose any more.
    s = run([ext({ currentModelId: null, availableModels: [] })], s);
    expect(s.models).toBeNull();
    expect(s.currentModelId).toBe("b");
  });

  it("reads the list from a config option update when it carries one", () => {
    const s = run([
      update({
        sessionUpdate: "config_option_update",
        configOptions: [
          { id: "llm", category: "model", type: "select", currentValue: "y", options: [{ value: "x", name: "X" }, { group: "g", name: "Group", options: [{ value: "y", name: "Y", description: "fast" }] }] },
        ],
      }),
    ]);
    expect(s.currentModelId).toBe("y");
    expect(s.models).toEqual({ currentModelId: "y", availableModels: [{ modelId: "x", name: "X" }, { modelId: "y", name: "Y", description: "fast", group: "Group" }] });
    expect(liveModels(s.models, s.currentModelId)?.currentModelId).toBe("y");
  });

  it("normalizes the backend's models and config options defensively", () => {
    expect(normalizeModels({ availableModels: [{ modelId: "a", name: "A" }, { name: "no id" }, null] })).toEqual({ currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }] });
    expect(normalizeModels({ currentModelId: "a", availableModels: [] })).toBeNull();
    expect(normalizeModels("x")).toBeNull();
    expect(configModels([{ id: "model", type: "toggle", currentValue: "a", options: [{ value: "a" }] }])).toBeNull();
    expect(configModels([{ id: "model", currentValue: "a", options: [{ value: "a" }] }])).toEqual({ currentModelId: "a", availableModels: [{ modelId: "a", name: "a" }] });
    expect(configModels([{ id: "model", currentValue: "a" }])).toBeNull();
    expect(configModels(undefined)).toBeNull();
  });
});

describe("forceCancels", () => {
  it("interrupts a running turn or a prompt still on its way, nothing else", () => {
    expect(forceCancels("busy", false)).toBe(true);
    expect(forceCancels("waiting", false)).toBe(true);
    expect(forceCancels("idle", true)).toBe(true);
    expect(forceCancels("idle", false)).toBe(false);
    expect(forceCancels("exited", false)).toBe(false);
  });
});

describe("local error ids", () => {
  it("stay unique even when the oldest items were dropped", () => {
    const a = applyLocalError(settleChat(initialChat()), "one");
    const b = applyLocalError({ ...a, items: [] }, "two");
    expect(a.items[0].id).not.toBe(b.items[0].id);
  });
});

describe("subagent tool calls", () => {
  it("records the parent launch and the tool name from _meta, keeping them through later updates", () => {
    const state = run([
      update({ sessionUpdate: "tool_call", toolCallId: "l", title: "Explore", rawInput: { subagent_type: "Explore" }, _meta: { claudeCode: { toolName: "Agent" } } }),
      update({ sessionUpdate: "tool_call", toolCallId: "c", title: "Read x", _meta: { claudeCode: { parentToolUseId: "l", toolName: "Read" } } }),
      update({ sessionUpdate: "tool_call_update", toolCallId: "c", status: "completed", _meta: { claudeCode: { toolName: "Read" } } }),
    ]);
    expect(tool(state, "c")).toMatchObject({ parentToolUseId: "l", status: "completed" });
    expect(tool(state, "l")).toMatchObject({ toolName: "Agent" });
  });

  it("times a subagent launch and leaves other calls alone", () => {
    const at = (u: Record<string, unknown>, t: number): ChatEvent => ({ kind: "update", seq: next(), at: t, update: { sessionUpdate: "x", ...u } });
    const state = run([
      at({ sessionUpdate: "tool_call", toolCallId: "l", _meta: { claudeCode: { toolName: "Task" } } }, 100),
      at({ sessionUpdate: "tool_call_update", toolCallId: "l", status: "completed" }, 5100),
      at({ sessionUpdate: "tool_call", toolCallId: "r", status: "pending" }, 200),
      at({ sessionUpdate: "tool_call_update", toolCallId: "r", status: "completed" }, 300),
    ]);
    expect(tool(state, "l")).toMatchObject({ startedAt: 100, endedAt: 5100 });
    expect(tool(state, "r")?.startedAt).toBeUndefined();
  });
});

