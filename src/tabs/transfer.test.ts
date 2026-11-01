import { describe, expect, it, vi } from "vitest";
import { packTabTransfer } from "./transfer";
import { makeTermTab } from "./tabState";

describe("tab transfer ownership", () => {
  it("cannot move a terminal whose session is not ready", async () => {
    expect(await packTabTransfer(makeTermTab("t", "/work"), {})).toBeNull();
    const release = vi.fn(async () => null);
    expect(await packTabTransfer(makeTermTab("t", "/work"), { terminal: { release } })).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });
  it("preserves a dirty editor buffer even before its lazy editor mounts", async () => {
    const tab = { kind: "editor" as const, id: "e", path: "/work/a", label: "a" };
    expect((await packTabTransfer(tab, { pendingEditorContent: "" }))?.editor).toEqual({ content: "", dirty: true });
    const moved = await packTabTransfer(tab, { editor: { getContent: () => "new edits", isDirty: () => true }, pendingEditorContent: "old" });
    expect(moved?.editor).toEqual({ content: "new edits", dirty: true });
  });
});
