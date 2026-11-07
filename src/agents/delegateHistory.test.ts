import { describe, expect, it } from "vitest";
import { childKeys, getDelegateHistory, interruptDelegates, markInterrupted, mergeChildren, recordDelegates, type DelegateChild, type DelegateHistory } from "./delegateHistory";

const child = (taskId: string, extra: Partial<DelegateChild> = {}): DelegateChild => ({ childSessionId: `s-${taskId}`, agent: "codex", title: `Task ${taskId}`, status: "running", taskId, ...extra });

describe("mergeChildren", () => {
  it("adds children and updates the known ones by task", () => {
    let h: DelegateHistory = mergeChildren({}, "o1", [child("a")], 1);
    h = mergeChildren(h, "o1", [child("a", { status: "done" }), child("b")], 2);
    expect(h.o1.children.map((c) => [c.taskId, c.status])).toEqual([["a", "done"], ["b", "running"]]);
    expect(h.o1.at).toBe(2);
  });

  it("returns the same object when nothing changed", () => {
    const h = mergeChildren({}, "o1", [child("a")], 1);
    expect(mergeChildren(h, "o1", [child("a")], 5)).toBe(h);
  });

  it("keeps the most recently changed orchestrators past the cap", () => {
    let h: DelegateHistory = {};
    h = mergeChildren(h, "o1", [child("a")], 1, 2);
    h = mergeChildren(h, "o2", [child("b")], 2, 2);
    h = mergeChildren(h, "o1", [child("a", { status: "done" })], 3, 2);
    h = mergeChildren(h, "o3", [child("c")], 4, 2);
    expect(Object.keys(h).sort()).toEqual(["o1", "o3"]);
  });
});

describe("markInterrupted", () => {
  it("settles only the closed session's live children, preserving finished results and other sessions", () => {
    recordDelegates("closed", [child("a"), child("b", { status: "waiting_for_user" }), child("c", { status: "done" })]);
    recordDelegates("live", [child("d")]);
    interruptDelegates("closed");
    expect(getDelegateHistory().closed.children.map((c) => c.status)).toEqual(["cancelled", "cancelled", "done"]);
    expect(getDelegateHistory().live.children[0].status).toBe("running");
  });
  it("turns what was still going into cancelled and leaves the rest", () => {
    const h = markInterrupted({ o: { at: 1, children: [child("a"), child("b", { status: "waiting_for_user" }), child("c", { status: "done" })] } });
    expect(h.o.children.map((c) => c.status)).toEqual(["cancelled", "cancelled", "done"]);
  });
});

describe("childKeys", () => {
  it("lists agent:session of every child", () => {
    expect([...childKeys({ o: { at: 1, children: [child("a"), child("b", { agent: "gemini" })] } })].sort()).toEqual(["codex:s-a", "gemini:s-b"]);
  });
});
