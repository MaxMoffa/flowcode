import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { discardAttachment, releasePreview } from "./attachmentRelease";

describe("attachment release", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    invoke.mockReset();
  });

  it("releasePreview only revokes the object URL", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    releasePreview({ name: "a.png", mime: "image/png", upload: "u1", preview: "blob:x" });
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("discardAttachment revokes and unstages", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    invoke.mockResolvedValue(undefined);
    discardAttachment({ name: "a.png", mime: "image/png", upload: "u1", preview: "blob:x" });
    expect(revoke).toHaveBeenCalledWith("blob:x");
    expect(invoke).toHaveBeenCalledWith("chat_unstage_attachment", { upload: "u1" });
  });

  it("ignores missing preview/upload and swallows unstage errors", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    discardAttachment({ name: "a.txt", mime: "text/plain" });
    expect(revoke).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockRejectedValue(new Error("boom"));
    expect(() => discardAttachment({ name: "b", mime: "x", upload: "u2" })).not.toThrow();
  });
});
