import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./hostRequest", () => ({ hostRequest: () => Promise.reject(new Error("unused")) }));

import { dirtyRemoteEditors, hasDirtyRemoteEditors, openRemoteFile, resetRemoteEditors, setRemoteEditorDirty, setRemoteEditorHandle, stashRemoteDraft } from "./remoteFiles";

const handle = (dirty: boolean) => ({ isDirty: () => dirty, getContent: () => "live", save: async () => true, scrollToLine: () => {} });

describe("close guard sees remote editors", () => {
  beforeEach(() => resetRemoteEditors());

  it("lists mounted dirty editors of every PC, with their handle", () => {
    openRemoteFile({ hostId: "h1", path: "/srv/a.txt" });
    openRemoteFile({ hostId: "h2", path: "C:\b.txt" });
    setRemoteEditorDirty("h1", "/srv/a.txt", true);
    setRemoteEditorHandle("h1", "/srv/a.txt", handle(true));
    setRemoteEditorHandle("h2", "C:\b.txt", handle(false));
    const dirty = dirtyRemoteEditors((id) => `PC ${id}`).filter((e) => e.handle.isDirty());
    expect(dirty.map((e) => e.label)).toEqual(["a.txt (PC h1)"]);
    expect(hasDirtyRemoteEditors()).toBe(true);
    setRemoteEditorHandle("h1", "/srv/a.txt", null);
  });

  it("includes stashed drafts of editors that are not mounted", async () => {
    openRemoteFile({ hostId: "h1", path: "/srv/c.txt" });
    setRemoteEditorDirty("h1", "/srv/c.txt", true);
    stashRemoteDraft("h1", "/srv/c.txt", "draft text");
    const [e] = dirtyRemoteEditors();
    expect(e.handle.isDirty()).toBe(true);
    expect(e.handle.getContent()).toBe("draft text");
    expect(await e.handle.save()).toBe(false);
  });

  it("ignores clean editors", () => {
    openRemoteFile({ hostId: "h1", path: "/srv/d.txt" });
    expect(hasDirtyRemoteEditors()).toBe(false);
  });
});
