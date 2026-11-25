import { describe, expect, it } from "vitest";
import type { ChatAttachment } from "../chat/chatTypes";
import { queuedAttachments, takeStaged, type StagedFiles } from "./queuedFiles";

const staged = (): StagedFiles => new Map<string, ChatAttachment>([["r1", { name: "a.png", mime: "image/png", upload: "u1", size: 3 }]]);

describe("files of a queued message for another PC", () => {
  it("gives back the staged copy, and just the name for a file with none", () => {
    expect(queuedAttachments([{ id: "r1", name: "a.png", mime: "image/png" }, { id: "r2", name: "b.txt", mime: "text/plain" }], staged())).toEqual([
      { name: "a.png", mime: "image/png", upload: "u1", size: 3 },
      { name: "b.txt", mime: "text/plain" },
    ]);
  });

  it("takes a message's copies out of the staging, once", () => {
    const map = staged();
    expect(takeStaged(map, [{ id: "r1", name: "a.png", mime: "image/png" }, { id: "zz", name: "x", mime: "x" }])).toHaveLength(1);
    expect(map.size).toBe(0);
    expect(takeStaged(map, [{ id: "r1", name: "a.png", mime: "image/png" }])).toEqual([]);
  });
});
