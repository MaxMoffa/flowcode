import { describe, expect, it, vi } from "vitest";
import { prepareEditorClose, type ClosingEditor } from "./closeEditors";

function editor(id = "a") {
  let dirty = true;
  let text = id;
  const handle = { isDirty: () => dirty, getContent: () => text, save: vi.fn(async () => { dirty = false; return true; }) };
  return { value: { id, label: id, handle } satisfies ClosingEditor, type: (value: string) => { text = value; dirty = true; } };
}

describe("window editor close guard", () => {
  it("cancels without saving or discarding later editors", async () => {
    const a = editor();
    const choose = vi.fn(async () => "cancel" as const);
    expect(await prepareEditorClose(() => [a.value, editor("b").value], choose)).toBeNull();
    expect(a.value.handle.save).not.toHaveBeenCalled();
    expect(choose).toHaveBeenCalledTimes(1);
  });
  it("keeps the window open after a failed or cancelled save", async () => {
    const a = editor();
    a.value.handle.save.mockResolvedValue(false);
    expect(await prepareEditorClose(() => [a.value], async () => "save")).toBeNull();
  });
  it("allows saved and explicitly discarded buffers", async () => {
    const a = editor();
    const b = editor("b");
    const valid = await prepareEditorClose(() => [a.value, b.value], async (e) => e.id === "a" ? "save" : "discard");
    expect(valid?.()).toBe(true);
    b.type("new edits while persisting");
    expect(valid?.()).toBe(false);
  });
  it("rejects new dirty editors opened while persistence was in flight", async () => {
    const list: ClosingEditor[] = [];
    const valid = await prepareEditorClose(() => list, async () => "discard");
    list.push(editor().value);
    expect(valid?.()).toBe(false);
  });
});
