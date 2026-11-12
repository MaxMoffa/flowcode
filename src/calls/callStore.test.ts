import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCall, clearTab, DONE_CALL_TTL_MS, getCalls, removeCall, removeCallByKey, resetCalls, setCallFocusTab, setCallsEnabled } from "./callStore";

const base = { tabId: "tab-b", title: "Claude", kind: "custom" as const };

beforeEach(() => {
  vi.useFakeTimers();
  resetCalls();
});
afterEach(() => vi.useRealTimers());

describe("callStore", () => {
  it("lists the newest call first and never the one of the tab on screen", () => {
    setCallFocusTab("tab-a");
    addCall({ ...base, id: "1", createdAt: 1 });
    addCall({ ...base, id: "2", tabId: "tab-c", createdAt: 2 });
    addCall({ ...base, id: "3", tabId: "tab-a", createdAt: 3 });
    expect(getCalls().map((c) => c.id)).toEqual(["2", "1"]);
  });

  it("shows a parked conversation's call even while its tab is on screen", () => {
    setCallFocusTab("tab-a");
    addCall({ ...base, id: "p", tabId: "tab-a", kind: "permission", key: "perm:p:1", parked: true, sessionId: "s1" });
    addCall({ ...base, id: "q", tabId: "tab-a", kind: "permission", key: "perm:q:1" });
    expect(getCalls().map((c) => c.id)).toEqual(["p"]);
    expect(getCalls()[0].sessionId).toBe("s1");
  });

  it("replaces a call with the same key", () => {
    addCall({ ...base, key: "perm:1", title: "old" });
    addCall({ ...base, key: "perm:1", title: "new" });
    expect(getCalls().map((c) => c.title)).toEqual(["new"]);
    removeCallByKey("perm:1");
    expect(getCalls()).toEqual([]);
  });

  it("drops what a tab called about when it comes on screen, but keeps pending requests", () => {
    addCall({ ...base, id: "a", kind: "attention" });
    addCall({ ...base, id: "b", kind: "permission", key: "perm:1" });
    addCall({ ...base, id: "c", tabId: "tab-c" });
    setCallFocusTab("tab-b");
    setCallFocusTab("tab-a");
    expect(getCalls().map((c) => c.id).sort()).toEqual(["b", "c"]);
  });

  it("removes a done call after a while", () => {
    addCall({ ...base, id: "d", kind: "done" });
    vi.advanceTimersByTime(DONE_CALL_TTL_MS - 1);
    expect(getCalls()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(getCalls()).toHaveLength(0);
  });

  it("removes one call or every call of a closed tab", () => {
    addCall({ ...base, id: "1" });
    addCall({ ...base, id: "2" });
    addCall({ ...base, id: "3", tabId: "tab-c" });
    removeCall("1");
    clearTab("tab-b");
    expect(getCalls().map((c) => c.id)).toEqual(["3"]);
  });
});

describe("calls switched off", () => {
  beforeEach(() => resetCalls());
  afterEach(() => setCallsEnabled(true));

  it("drops the open calls and shows no new ones until switched back on", () => {
    addCall({ tabId: "b", kind: "permission", title: "x" });
    setCallsEnabled(false);
    expect(getCalls()).toHaveLength(0);
    addCall({ tabId: "b", kind: "custom", title: "y" });
    expect(getCalls()).toHaveLength(0);
    setCallsEnabled(true);
    addCall({ tabId: "b", kind: "custom", title: "z" });
    expect(getCalls().map((c) => c.title)).toEqual(["z"]);
  });
});
