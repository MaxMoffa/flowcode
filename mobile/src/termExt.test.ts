import { describe, expect, it, vi } from "vitest";
import { applyTermExt, getTermDelegates, onTermOpen, pruneTermExt, termOpenPage } from "./termExt";

const delegate = (status: string, steps = 0) => ({ taskId: "t1", childChatId: "c1", agent: "codex", title: "Fix", prompt: "p", status, startedAt: 1, steps });

describe("terminal ext events", () => {
  it("keeps the latest state of each delegate and drops a finished one's regress", () => {
    applyTermExt("p1", "_flowcode/delegate", delegate("running", 1));
    applyTermExt("p1", "_flowcode/delegate", delegate("running", 3));
    expect(getTermDelegates("p1").map((d) => d.steps)).toEqual([3]);
    applyTermExt("p1", "_flowcode/delegate", delegate("done", 4));
    applyTermExt("p1", "_flowcode/delegate", delegate("running", 5));
    expect(getTermDelegates("p1")[0].status).toBe("done");
    applyTermExt("p1", "_flowcode/delegate", { nonsense: true });
    expect(getTermDelegates("p1")).toHaveLength(1);
    expect(getTermDelegates("other")).toEqual([]);
  });

  it("forgets the tabs that are gone", () => {
    applyTermExt("p2", "_flowcode/delegate", delegate("running"));
    pruneTermExt(new Set(["p2"]));
    expect(getTermDelegates("p1")).toEqual([]);
    expect(getTermDelegates("p2")).toHaveLength(1);
  });

  it("tells open requests to the tab's listener only", () => {
    const here = vi.fn();
    const there = vi.fn();
    const off = onTermOpen("p3", here);
    onTermOpen("p4", there);
    applyTermExt("p3", "_flowcode/open", { target: "http://localhost:5173", cwd: "/repo" });
    applyTermExt("p3", "_flowcode/open", { target: "" });
    expect(here).toHaveBeenCalledOnce();
    expect(here).toHaveBeenCalledWith({ target: "http://localhost:5173", cwd: "/repo" });
    expect(there).not.toHaveBeenCalled();
    off();
    applyTermExt("p3", "_flowcode/open", { target: "http://localhost:1" });
    expect(here).toHaveBeenCalledOnce();
  });

  it("shows a local server, or a previewable file inside the tab's folder", () => {
    expect(termOpenPage({ target: "http://localhost:5173/a", cwd: "" }, "p1", "/repo")).toMatchObject({ kind: "port", port: 5173 });
    expect(termOpenPage({ target: "docs/a.html", cwd: "/repo" }, "p1", "/repo")).toMatchObject({ kind: "file", ptyId: "p1", path: "docs/a.html" });
    expect(termOpenPage({ target: "/elsewhere/a.html", cwd: "/repo" }, "p1", "/repo")).toBeNull();
    expect(termOpenPage({ target: "notes.rs", cwd: "/repo" }, "p1", "/repo")).toBeNull();
  });
});
