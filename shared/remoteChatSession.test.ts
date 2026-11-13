import { describe, expect, it } from "vitest";
import { acknowledgePrompt, applyEvents, canDispatch, emptySession, forceQueued, pauseUnconfirmedPrompt, putBack, takeQueued } from "./remoteChatSession";

describe("prompt delivery receipts", () => {
  it("retries a busy refusal that arrives after the other turn already ended", () => {
    const sent = takeQueued({ ...emptySession(), queued: [{ text: "A", files: [] }, { text: "B", files: [] }] }, "id")!.session;
    const finished = applyEvents(sent, [{ kind: "user", seq: 1, at: 0, text: "someone else" }, { kind: "turnEnd", seq: 2, at: 0, stopReason: "end_turn" }], { replay: false, busy: false });
    const refused = acknowledgePrompt(finished, "id", "agent_busy");
    expect(refused.queued.map((q) => q.text)).toEqual(["A", "B"]);
    expect(canDispatch(refused, "idle")).toBe(true);
  });
  it("ignores a failed local send from an earlier attempt of the same text", () => {
    const first = takeQueued({ ...emptySession(), queued: [{ text: "A", files: [] }] }, "old")!.session;
    const second = takeQueued(forceQueued(pauseUnconfirmedPrompt(first), 0), "new")!.session;
    expect(putBack(second, "A", [], first.sentAtSeq!, first.deliveryVersion)).toBe(second);
    expect(second.sentRequestId).toBe("new");
  });
  it("keeps the same request across an empty reconnect replay", () => {
    const sent = takeQueued({ ...emptySession(), queued: [{ text: "A", files: [] }, { text: "B", files: [] }] }, "123-id")!.session;
    const replayed = applyEvents(sent, [], { replay: true, busy: false });
    expect(replayed.sentText).toBe("A");
    expect(replayed.sentRequestId).toBe("123-id");
    expect(canDispatch(replayed, "idle")).toBe(false);
    expect(acknowledgePrompt(replayed, "someone-else")).toBe(replayed);
    const acked = acknowledgePrompt(replayed, "123-id");
    expect(acked.sentText).toBeNull();
    const finished = applyEvents(acked, [{ kind: "user", seq: 1, at: 0, text: "A" }, { kind: "turnEnd", seq: 2, at: 0, stopReason: "end_turn" }], { replay: false, busy: false });
    expect(canDispatch(finished, "idle")).toBe(true);
    expect(takeQueued(finished, "new")?.text).toBe("B");
  });

  it("correlates refusals when two chats have prompts in flight", () => {
    const a = takeQueued({ ...emptySession(), queued: [{ text: "A", files: [] }] }, "a")!.session;
    const b = takeQueued({ ...emptySession(), queued: [{ text: "B", files: [] }] }, "b")!.session;
    expect(acknowledgePrompt(a, "b", "agent_busy")).toBe(a);
    expect(acknowledgePrompt(b, "b", "agent_busy").queued.map((q) => q.text)).toEqual(["B"]);
  });

  it("does not mistake another sender's user event for delivery", () => {
    const sent = takeQueued({ ...emptySession(), queued: [{ text: "mine", files: [] }] })!.session;
    const other = applyEvents(sent, [{ kind: "user", seq: 1, at: 0, text: "theirs" }], { replay: false, busy: true });
    expect(other.sentText).toBe("mine");
  });

  it("preserves uncertain legacy messages for explicit retry", () => {
    const sent = takeQueued({ ...emptySession(), queued: [{ text: "A", files: [] }, { text: "B", files: [] }] })!.session;
    const replayed = applyEvents(sent, [], { replay: true, busy: false });
    expect(replayed.queued.map((q) => q.text)).toEqual(["A", "B"]);
    expect(replayed.deliveryUncertain).toBe(true);
    expect(canDispatch(replayed, "idle")).toBe(false);
    expect(canDispatch(forceQueued(replayed, 0), "idle")).toBe(true);
  });
});
