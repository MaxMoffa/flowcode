import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatTypes";
import type { ChatInfo } from "../../shared/remote-types";
import { MAX_RAW_EVENTS, applyEvents, canDispatch, chatModes, chatStatus, emptySession, pendingPermissions, putBack, takeQueued } from "./chatSession";

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
});
