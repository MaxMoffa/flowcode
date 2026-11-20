import { describe, expect, it } from "vitest";
import type { DelegateInfo, DelegateRequest } from "../chat/chatModel";
import { addTerminalRequest, EMPTY_TERMINAL_DELEGATES, resolveTerminalRequest, seedTerminalDelegates, upsertTerminalDelegate } from "./terminalDelegates";

const d = (taskId: string, status: DelegateInfo["status"] = "running", extra: Partial<DelegateInfo> = {}): DelegateInfo => ({
  taskId,
  childChatId: `c-${taskId}`,
  agent: "codex",
  title: taskId,
  prompt: "",
  status,
  startedAt: 1,
  steps: 0,
  ...extra,
});
const req = (taskId: string, requestId = "1"): DelegateRequest => ({ taskId, childChatId: `c-${taskId}`, agent: "codex", title: "", kind: "ask", requestId, message: "?", questions: [] });

describe("terminalDelegates", () => {
  it("appends new tasks and patches known ones in place", () => {
    let s = upsertTerminalDelegate(EMPTY_TERMINAL_DELEGATES, d("a"));
    s = upsertTerminalDelegate(s, d("b"));
    s = upsertTerminalDelegate(s, d("a", "running", { steps: 3 }));
    expect(s.delegates.map((x) => x.taskId)).toEqual(["a", "b"]);
    expect(s.delegates[0].steps).toBe(3);
  });

  it("never moves a finished task back and drops its requests", () => {
    let s = upsertTerminalDelegate(EMPTY_TERMINAL_DELEGATES, d("a"));
    s = addTerminalRequest(s, req("a"));
    expect(s.requests).toHaveLength(1);
    s = upsertTerminalDelegate(s, d("a", "cancelled"));
    expect(s.requests).toHaveLength(0);
    const after = upsertTerminalDelegate(s, d("a", "running"));
    expect(after).toBe(s);
    expect(after.delegates[0].status).toBe("cancelled");
  });

  it("dedupes requests by child and id, and ignores those of finished tasks", () => {
    let s = upsertTerminalDelegate(EMPTY_TERMINAL_DELEGATES, d("a"));
    s = addTerminalRequest(s, req("a"));
    expect(addTerminalRequest(s, req("a"))).toBe(s);
    s = addTerminalRequest(s, req("a", "2"));
    expect(s.requests).toHaveLength(2);
    const done = upsertTerminalDelegate(EMPTY_TERMINAL_DELEGATES, d("z", "done"));
    expect(addTerminalRequest(done, req("z"))).toBe(done);
  });

  it("resolves a request", () => {
    let s = upsertTerminalDelegate(EMPTY_TERMINAL_DELEGATES, d("a"));
    s = addTerminalRequest(s, req("a"));
    expect(resolveTerminalRequest(s, "c-a", "9")).toBe(s);
    expect(resolveTerminalRequest(s, "c-a", "1").requests).toHaveLength(0);
  });

  it("seeds from raw params, skipping junk", () => {
    const s = seedTerminalDelegates(EMPTY_TERMINAL_DELEGATES, [{ taskId: "a", childChatId: "c-a", status: "done" }, { nope: 1 }, { taskId: "b", childChatId: "c-b" }]);
    expect(s.delegates.map((x) => [x.taskId, x.status])).toEqual([["a", "done"], ["b", "running"]]);
    expect(seedTerminalDelegates(s, "x")).toBe(s);
  });
});
