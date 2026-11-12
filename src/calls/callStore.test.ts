import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addCall, clearTab, DONE_CALL_TTL_MS, getCalls, removeCall, removeCallByKey, resetCalls, setCallFocusTab } from "./callStore";

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
