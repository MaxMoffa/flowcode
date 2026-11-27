import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./hostRequest", () => ({ hostRequest: () => Promise.reject(new Error("unused")) }));

import { stashRemoteDraft, closeRemoteEditor, getRemoteEditors, openRemoteFile, renameRemoteEditor, resetRemoteEditors, setRemoteEditorDirty, showRemoteEditor } from "./remoteFiles";
const snapshot = getRemoteEditors;

describe("remote editor tabs", () => {
  beforeEach(() => resetRemoteEditors());

  it("opens, dedupes by path and brings the file to the front", () => {
    openRemoteFile({ hostId: "h", path: "/a" });
    openRemoteFile({ hostId: "h", path: "/b", line: 3 });
    openRemoteFile({ hostId: "h", path: "/a", line: 9 });
    const s = snapshot("h");
    expect(s.tabs.map((t) => t.path)).toEqual(["/a", "/b"]);
    expect(s.front).toBe("/a");
    expect(s.tabs[0].line).toBe(9);
  });

  it("keeps PCs apart and lets the host's own tabs take the front", () => {
    openRemoteFile({ hostId: "h", path: "/a" });
    expect(snapshot("other").tabs).toEqual([]);
    showRemoteEditor("h", null);
    expect(snapshot("h").front).toBeNull();
    showRemoteEditor("h", "/a");
    expect(snapshot("h").front).toBe("/a");
  });

  it("closing the front editor falls back to a neighbour, then to the host's tabs", () => {
    openRemoteFile({ hostId: "h", path: "/a" });
    openRemoteFile({ hostId: "h", path: "/b" });
    closeRemoteEditor("h", "/b");
    expect(snapshot("h").front).toBe("/a");
    closeRemoteEditor("h", "/a");
    expect(snapshot("h")).toMatchObject({ tabs: [], front: null });
  });

  it("keeps a dirty editor's draft until it is clean", () => {
    openRemoteFile({ hostId: "h", path: "/a" });
    stashRemoteDraft("h", "/a", "lost");
    expect(snapshot("h").tabs[0].draft).toBeUndefined();
    setRemoteEditorDirty("h", "/a", true);
    stashRemoteDraft("h", "/a", "edits");
    expect(snapshot("h").tabs[0].draft).toBe("edits");
    setRemoteEditorDirty("h", "/a", false);
    expect(snapshot("h").tabs[0].draft).toBeUndefined();
  });

  it("tracks dirty and rename", () => {
    openRemoteFile({ hostId: "h", path: "/a" });
    setRemoteEditorDirty("h", "/a", true);
    expect(snapshot("h").tabs[0].dirty).toBe(true);
    renameRemoteEditor("h", "/a", "/c");
    expect(snapshot("h")).toMatchObject({ front: "/c", tabs: [{ path: "/c" }] });
  });
});
