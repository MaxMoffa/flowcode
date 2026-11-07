import { describe, expect, it } from "vitest";
import type { DelegateInfo } from "./chatModel";
import { sameDelegation, staleDelegateTabs, type TabDelegation } from "./delegateStore";

const d = (extra: Partial<DelegateInfo> = {}): DelegateInfo => ({ taskId: "a", childChatId: "c", agent: "codex", title: "T", prompt: "p", status: "running", startedAt: 1, steps: 0, ...extra });
const snap = (delegates: DelegateInfo[]): TabDelegation => ({ delegates, requests: [], task: null, wslDistro: null, ended: false });

describe("sameDelegation", () => {
  it("ignores rebuilt but equal delegates", () => {
    expect(sameDelegation(snap([d()]), snap([d()]))).toBe(true);
  });
  it("sees a status, activity or count change", () => {
    expect(sameDelegation(snap([d()]), snap([d({ status: "done" })]))).toBe(false);
    expect(sameDelegation(snap([d()]), snap([d({ lastActivity: "x" })]))).toBe(false);
    expect(sameDelegation(snap([d()]), snap([d(), d({ taskId: "b" })]))).toBe(false);
  });
  it("tells requests of two children with the same request id apart", () => {
    const req = (childChatId: string) => ({ taskId: childChatId, childChatId, agent: "codex", title: "T", kind: "ask" as const, requestId: "1" });
    expect(sameDelegation({ ...snap([]), requests: [req("c1")] }, { ...snap([]), requests: [req("c2")] })).toBe(false);
  });
});

describe("staleDelegateTabs", () => {
  const tab = (id: string, chatId: string) => ({ id, delegate: { chatId, parentTabId: "p" } });
  it("keeps the tabs of a live orchestrator's delegates", () => {
    expect(staleDelegateTabs([tab("x", "c")], { p: snap([d()]) })).toEqual([]);
  });
  it("closes tabs whose orchestrator is gone, ended or no longer has the delegate", () => {
    expect(staleDelegateTabs([tab("x", "c")], {})).toEqual(["x"]);
    expect(staleDelegateTabs([tab("x", "c")], { p: { ...snap([d()]), ended: true } })).toEqual(["x"]);
    expect(staleDelegateTabs([tab("x", "c"), tab("y", "other")], { p: snap([d()]) })).toEqual(["y"]);
  });
  it("ignores tabs that are not delegates", () => {
    expect(staleDelegateTabs([{ id: "z" }], {})).toEqual([]);
  });
});
