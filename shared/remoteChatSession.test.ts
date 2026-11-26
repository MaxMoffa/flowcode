import { describe, expect, it } from "vitest";
import { acknowledgePrompt, applyEvents, canDispatch, emptySession, foldReplayBatch, forceQueued, pauseUnconfirmedPrompt, putBack, sendBackoffMs, takeQueued } from "./remoteChatSession";

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

describe("replay a view did not ask for", () => {
  const ev = (seq: number) => ({ kind: "user", seq, at: 0, text: `m${seq}` });
  it("applies only newer events and leaves paging and loaded alone", () => {
    const base = applyEvents(emptySession(), [ev(5), ev(6)], { replay: true, busy: false, page: { hasMore: true, firstSeq: 5 } });
    expect(base.loaded).toBe(true);
    expect(base.older).toEqual({ has: true, firstSeq: 5, loading: false });
    // Another window re-opened the chat from 0 (paged): its replay brings an older page plus one new event.
    const next = foldReplayBatch(base, [ev(1), ev(2), ev(5), ev(6), ev(7)], { requested: false, busy: false, page: { hasMore: false, firstSeq: 1 } });
    expect(next.older).toEqual({ has: true, firstSeq: 5, loading: false });
    expect(next.model.lastSeq).toBe(7);
    expect(next.events.map((e) => e.seq)).toEqual([5, 6, 7]);
  });
  it("does not mark a chat loaded", () => {
    const next = foldReplayBatch(emptySession(), [ev(1)], { requested: false, busy: false });
    expect(next.loaded).toBe(false);
  });
  it("a requested replay sets the paging", () => {
    const next = foldReplayBatch(emptySession(), [ev(3)], { requested: true, busy: false, page: { hasMore: true, firstSeq: 3 } });
    expect(next.loaded).toBe(true);
    expect(next.older.has).toBe(true);
  });
});

describe("sendBackoffMs", () => {
  it("doubles from one second up to fifteen", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(sendBackoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });
});
