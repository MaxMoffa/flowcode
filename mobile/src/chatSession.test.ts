import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatTypes";
import type { ChatInfo } from "../../shared/remote-types";
import { MAX_ITEMS, MAX_RAW_EVENTS, applyEvents, canDispatch, chatModels, chatModes, chatStatus, chatThought, emptySession, forceNeedsCancel, forceQueued, pendingPermissions, putBack, refusedChat, requeueRefused, takeQueued } from "./chatSession";

const user = (seq: number, text = `m${seq}`): ChatEvent => ({ seq, at: 0, kind: "user", text });
const chunk = (seq: number, text: string): ChatEvent => ({ seq, at: 0, kind: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const turnEnd = (seq: number): ChatEvent => ({ seq, at: 0, kind: "turnEnd", stopReason: "end_turn" });
const info = (status: ChatInfo["status"]): ChatInfo => ({ chatId: "c", tabId: "t", window: "main", label: "x", agent: "claude", cwd: "/x", status });

const live = { replay: false, busy: false };
const replay = { replay: true, busy: false };

describe("applyEvents", () => {
  it("builds the conversation in order and tracks lastSeq", () => {
    let s = applyEvents(emptySession(), [user(1), chunk(2, "Ciao "), chunk(3, "mondo"), turnEnd(4)], replay);
    expect(s.model.lastSeq).toBe(4);
    expect(s.model.items.map((i) => i.type)).toEqual(["user", "agent"]);
    expect(s.loaded).toBe(true);
    s = applyEvents(s, [user(5)], live);
    expect(s.model.lastSeq).toBe(5);
  });

  it("never applies an event twice: a replay that overlaps what the phone has only adds the delta", () => {
    const first = applyEvents(emptySession(), [user(1), chunk(2, "a"), chunk(3, "b"), turnEnd(4), user(5), chunk(6, "c")], live);
    // After a reconnect the desktop is asked afterSeq = 6, but a chunk in flight may repeat older ones.
    const again = applyEvents(first, [chunk(5, "x"), chunk(6, "c"), chunk(7, "d"), turnEnd(8)], replay);
    expect(again.model.lastSeq).toBe(8);
    const agent = again.model.items.filter((i) => i.type === "agent");
    expect(agent.map((i) => (i.type === "agent" ? i.text : ""))).toEqual(["ab", "cd"]);
    expect(again.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("resumes seamlessly across a simulated reconnect", () => {
    // Connection 1: the phone follows from the start and loses the link after seq 3.
    let s = applyEvents(emptySession(), [user(1), chunk(2, "uno"), chunk(3, " due")], replay);
    const afterSeq = Math.max(0, s.model.lastSeq);
    expect(afterSeq).toBe(3);
    // Connection 2: the desktop answers with exactly what follows seq 3, in two chunks, then goes live.
    s = applyEvents(s, [chunk(4, " tre")], replay);
    s = applyEvents(s, [turnEnd(5)], replay);
    s = applyEvents(s, [user(6)], live);
    expect(s.model.items.map((i) => i.type)).toEqual(["user", "agent", "user"]);
    const agent = s.model.items[1];
    expect(agent.type === "agent" && agent.text).toBe("uno due tre");
    expect(s.model.lastSeq).toBe(6);
  });

  it("sorts a batch and ignores malformed entries", () => {
    const s = applyEvents(emptySession(), [user(3), { nope: true }, null, user(1), user(2)], live);
    expect(s.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("settles a replay of an idle session, but not of a busy one", () => {
    // A resumed session's history has no turnEnd: it reads like a turn in progress.
    const history = [user(1), chunk(2, "risposta")];
    expect(applyEvents(emptySession(), history, { replay: true, busy: false }).model.status).toBe("idle");
    expect(applyEvents(emptySession(), history, { replay: true, busy: true }).model.status).toBe("busy");
  });

  it("keeps at most MAX_RAW_EVENTS raw events, newest last", () => {
    const many = Array.from({ length: MAX_RAW_EVENTS + 50 }, (_, i) => chunk(i + 1, "x"));
    const s = applyEvents(emptySession(), many, live);
    expect(s.events).toHaveLength(MAX_RAW_EVENTS);
    expect(s.events[s.events.length - 1].seq).toBe(MAX_RAW_EVENTS + 50);
    expect(s.model.lastSeq).toBe(MAX_RAW_EVENTS + 50);
  });
});

describe("the send queue", () => {
  it("holds a message while the agent is busy and sends it once it is idle", () => {
    let s = { ...applyEvents(emptySession(), [user(1), chunk(2, "...")], live), queued: ["dopo"] };
    expect(canDispatch(s, chatStatus(info("busy"), s.model))).toBe(false);
    s = applyEvents(s, [turnEnd(3)], live);
    expect(canDispatch(s, chatStatus(info("idle"), s.model))).toBe(true);
    const taken = takeQueued(s)!;
    expect(taken.text).toBe("dopo");
    expect(taken.session.queued).toEqual([]);
    expect(taken.session.sentAtSeq).toBe(3);
  });

  it("sends one message per turn: the next waits until the sent one has produced an event", () => {
    const base = { ...applyEvents(emptySession(), [turnEnd(1)], live), queued: ["a", "b"] };
    const { session } = takeQueued(base)!;
    expect(session.queued).toEqual(["b"]);
    // Idle again, but nothing newer than the sent one: the agent has not started its turn.
    expect(canDispatch(session, "idle")).toBe(false);
    const started = applyEvents(session, [user(2), chunk(3, "x"), turnEnd(4)], live);
    expect(canDispatch(started, "idle")).toBe(true);
  });

  it("puts a message that never left the phone back at the front", () => {
    const base = { ...emptySession(), queued: ["a", "b"] };
    const { session, text } = takeQueued(base)!;
    const back = putBack(session, text, session.sentAtSeq!);
    expect(back.queued).toEqual(["a", "b"]);
    expect(back.sentAtSeq).toBeNull();
  });

  it("forces a queued message to the front and drops the sent-at guard", () => {
    const base = { ...emptySession(), queued: ["a", "b", "c"], sentAtSeq: 5 };
    const forced = forceQueued(base, 2);
    expect(forced.queued).toEqual(["c", "a", "b"]);
    expect(forced.sentAtSeq).toBeNull();
    expect(canDispatch(forced, "idle")).toBe(true);
    expect(forceQueued(base, 9)).toBe(base);
  });

  it("trusts its own events over a stale 'idle' from the desktop", () => {
    // The pushed chat list still says idle, but the phone has seen the turn start.
    let s = { ...applyEvents(applyEvents(emptySession(), [turnEnd(1)], replay), [user(2), chunk(3, "...")], live), queued: ["dopo"] };
    expect(chatStatus(info("idle"), s.model)).toBe("busy");
    expect(canDispatch(s, chatStatus(info("idle"), s.model))).toBe(false);
    // A permission the desktop already reports, the events not yet: waiting.
    expect(chatStatus(info("waiting"), s.model)).toBe("waiting");
    s = applyEvents(s, [turnEnd(4)], live);
    expect(canDispatch(s, chatStatus(info("idle"), s.model))).toBe(true);
  });

  it("remembers the sent message until its user event arrives", () => {
    const base = { ...applyEvents(emptySession(), [turnEnd(1)], live), queued: ["a"] };
    const { session } = takeQueued(base)!;
    expect(session.sentText).toBe("a");
    // Unrelated events (the turn that made the agent busy) don't settle it.
    const during = applyEvents(session, [chunk(2, "x")], live);
    expect(during.sentText).toBe("a");
    const landed = applyEvents(during, [user(3, "a")], live);
    expect(landed.sentText).toBeNull();
    expect(requeueRefused(landed)).toBeNull();
    // The agent going away settles it too.
    expect(applyEvents(session, [{ seq: 2, at: 0, kind: "exit", code: 1 }], live).sentText).toBeNull();
  });

  it("puts a refused message back first, and holds it until the agent has moved on", () => {
    const base = { ...applyEvents(emptySession(), [turnEnd(1)], live), queued: ["a", "b"] };
    const { session } = takeQueued(base)!;
    const back = requeueRefused(session)!;
    expect(back.queued).toEqual(["a", "b"]);
    expect(back.sentText).toBeNull();
    // Still "idle" as far as anyone knows, but nothing new happened: not again straight away.
    expect(canDispatch(back, "idle")).toBe(false);
    const after = applyEvents(back, [chunk(2, "fine"), turnEnd(3)], live);
    expect(canDispatch(after, "idle")).toBe(true);
    expect(takeQueued(after)!.text).toBe("a");
  });

  it("ties a refusal to the one chat with a message in flight, or to none", () => {
    const idle = applyEvents(emptySession(), [turnEnd(1)], live);
    const flying = takeQueued({ ...idle, queued: ["x"] })!.session;
    expect(refusedChat({ a: idle, b: flying })).toBe("b");
    expect(refusedChat({ a: idle })).toBeNull();
    expect(refusedChat({ a: flying, b: flying })).toBeNull();
  });

  it("forgets the sent message when it is put back", () => {
    const { session, text } = takeQueued({ ...emptySession(), queued: ["a"] })!;
    expect(putBack(session, text, session.sentAtSeq!).sentText).toBeNull();
  });

  it("does not dispatch an empty queue or to an agent that is waiting, starting or gone", () => {
    const s = { ...emptySession(), queued: ["x"] };
    for (const st of ["busy", "waiting", "starting", "exited"] as const) expect(canDispatch(s, st)).toBe(false);
    expect(canDispatch(emptySession(), "idle")).toBe(false);
  });
});

describe("status, permissions and modes", () => {
  const permission: ChatEvent = { seq: 1, at: 0, kind: "permission", requestId: "r1", toolCall: { toolCallId: "t", title: "npm test" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] };

  it("is waiting from the events, even before the desktop's status catches up", () => {
    const s = applyEvents(emptySession(), [permission], replay);
    expect(chatStatus(info("busy"), s.model)).toBe("waiting");
    expect(pendingPermissions(s.model)).toHaveLength(1);
    const answered = applyEvents(s, [{ seq: 2, at: 0, kind: "permissionResolved", requestId: "r1", optionId: "ok" }], live);
    expect(pendingPermissions(answered.model)).toHaveLength(0);
  });

  it("takes the desktop's word for the rest, and exited wins", () => {
    const s = applyEvents(emptySession(), [turnEnd(1)], replay);
    expect(chatStatus(info("busy"), s.model)).toBe("busy");
    expect(chatStatus(undefined, s.model)).toBe("idle");
    expect(chatStatus(info("exited"), s.model)).toBe("exited");
  });

  it("reads the announced modes, the live mode wins, and junk is no modes", () => {
    const modes = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] };
    const base = applyEvents(emptySession(), [], live).model;
    expect(chatModes({ ...info("idle"), modes }, base)?.currentModeId).toBe("default");
    const changed = applyEvents(emptySession(), [{ seq: 1, at: 0, kind: "update", update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } }], live).model;
    expect(chatModes({ ...info("idle"), modes }, changed)?.currentModeId).toBe("plan");
    expect(chatModes({ ...info("idle"), modes: { availableModes: [] } }, base)).toBeNull();
    expect(chatModes({ ...info("idle"), modes: "x" }, base)).toBeNull();
    expect(chatModes(undefined, base)).toBeNull();
  });

  it("reads the announced models, the live model wins, and junk or a single model is no choice", () => {
    const models = { currentModelId: "sonnet", availableModels: [{ modelId: "sonnet", name: "Sonnet", group: "Claude" }, { modelId: "opus", name: "Opus" }, { name: "no id" }] };
    const base = applyEvents(emptySession(), [], live).model;
    const read = chatModels({ ...info("idle"), models }, base);
    expect(read?.currentModelId).toBe("sonnet");
    expect(read?.availableModels.map((m) => m.modelId)).toEqual(["sonnet", "opus"]);
    const changed = applyEvents(emptySession(), [{ seq: 1, at: 0, kind: "ext", method: "_flowcode/model", params: { currentModelId: "opus" } }], live).model;
    expect(chatModels({ ...info("idle"), models }, changed)?.currentModelId).toBe("opus");
    expect(chatModels({ ...info("idle"), models: { availableModels: [{ modelId: "a", name: "A" }, { modelId: "b", name: "B" }] } }, base)?.currentModelId).toBe("a");
    expect(chatModels({ ...info("idle"), models: { currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }] } }, base)).toBeNull();
    expect(chatModels({ ...info("idle"), models: { availableModels: "x" } }, base)).toBeNull();
    expect(chatModels({ ...info("idle"), models: 5 }, base)).toBeNull();
    expect(chatModels(undefined, base)).toBeNull();
  });
});

describe("the models from events", () => {
  const two = { currentModelId: "a", availableModels: [{ modelId: "a", name: "A" }, { modelId: "b", name: "B" }] };

  it("prefers the list the chat's events last said over the announced one", () => {
    const three = { currentModelId: "c", availableModels: [...two.availableModels, { modelId: "c", name: "C" }] };
    const s = applyEvents(emptySession(), [{ seq: 1, at: 0, kind: "ext", method: "_flowcode/model", params: three }], live);
    expect(chatModels({ ...info("idle"), models: two }, s.model)?.availableModels.map((m) => m.modelId)).toEqual(["a", "b", "c"]);
    // The agent offers no choice any more: none, whatever was announced.
    const gone = applyEvents(s, [{ seq: 2, at: 0, kind: "ext", method: "_flowcode/model", params: { currentModelId: null, availableModels: [] } }], live);
    expect(chatModels({ ...info("idle"), models: two }, gone.model)).toBeNull();
  });
});

describe("the thinking levels", () => {
  const levels = { currentId: "low", available: [{ id: "low", name: "Low" }, { id: "high", name: "High" }] };
  const thoughtEvent = (seq: number, params: unknown): ChatEvent => ({ seq, at: 0, kind: "ext", method: "_flowcode/thought", params });

  it("reads the announced levels, events override them, and one level is no choice", () => {
    const base = emptySession().model;
    expect(chatThought({ ...info("idle"), thought: levels }, base)).toEqual(levels);
    expect(chatThought({ ...info("idle"), thought: { currentId: "a", available: [{ id: "a", name: "A" }] } }, base)).toBeNull();
    expect(chatThought({ ...info("idle"), thought: 5 }, base)).toBeNull();
    expect(chatThought(undefined, base)).toBeNull();
    const s = applyEvents(emptySession(), [thoughtEvent(1, { currentId: "high", available: levels.available })], live);
    expect(chatThought({ ...info("idle"), thought: levels }, s.model)?.currentId).toBe("high");
    const gone = applyEvents(s, [thoughtEvent(2, { currentId: null, available: [] })], live);
    expect(chatThought({ ...info("idle"), thought: levels }, gone.model)).toBeNull();
  });
});

describe("the item cap", () => {
  it("drops the oldest items past MAX_ITEMS and keeps lastSeq", () => {
    const events = Array.from({ length: MAX_ITEMS + 10 }, (_, i) => user(i + 1));
    const s = applyEvents(emptySession(), events, replay);
    expect(s.model.items).toHaveLength(MAX_ITEMS);
    expect(s.model.items[0]).toMatchObject({ type: "user", text: "m11" });
    expect(s.model.lastSeq).toBe(MAX_ITEMS + 10);
    // Older events still read as already applied: nothing comes back.
    const again = applyEvents(s, [user(1), user(MAX_ITEMS + 11)], live);
    expect(again.model.items).toHaveLength(MAX_ITEMS);
    expect(again.model.items[MAX_ITEMS - 1]).toMatchObject({ text: `m${MAX_ITEMS + 11}` });
    expect(again.model.lastSeq).toBe(MAX_ITEMS + 11);
  });
});

describe("forceNeedsCancel", () => {
  it("cancels a running turn, or a message still on its way", () => {
    const idle = applyEvents(emptySession(), [user(1), turnEnd(2)], replay);
    expect(forceNeedsCancel(idle, "idle")).toBe(false);
    expect(forceNeedsCancel(idle, "busy")).toBe(true);
    expect(forceNeedsCancel(idle, "waiting")).toBe(true);
    const sent = takeQueued({ ...idle, queued: ["a", "b"] })!.session;
    expect(forceNeedsCancel(sent, "idle")).toBe(true);
    // Its `user` event arrived: no longer in flight.
    expect(forceNeedsCancel(applyEvents(sent, [user(3), turnEnd(4)], live), "idle")).toBe(false);
  });
});
