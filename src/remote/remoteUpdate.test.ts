import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../update/UpdateContext";
import { MAX_NOTES_CHARS, toRemoteUpdate } from "./remoteUpdate";

const info = { version: "0.21.0", current_version: "0.20.0", notes: "  Fixes  ", page_url: "", size: 1234 };

describe("toRemoteUpdate", () => {
  it("maps the bare states", () => {
    expect(toRemoteUpdate({ kind: "idle" })).toEqual({ state: "idle" });
    expect(toRemoteUpdate({ kind: "checking" })).toEqual({ state: "checking" });
    expect(toRemoteUpdate({ kind: "upToDate" })).toEqual({ state: "upToDate" });
  });

  it("maps an available update, trimming the notes and renaming the version", () => {
    expect(toRemoteUpdate({ kind: "available", info })).toEqual({
      state: "available",
      version: "0.21.0",
      currentVersion: "0.20.0",
      notes: "Fixes",
      size: 1234,
    });
  });

  it("omits empty notes", () => {
    const update = toRemoteUpdate({ kind: "available", info: { ...info, notes: "   " } });
    expect(update).not.toHaveProperty("notes");
  });

  it("caps notes at the limit", () => {
    const update = toRemoteUpdate({ kind: "available", info: { ...info, notes: "x".repeat(MAX_NOTES_CHARS + 50) } });
    expect(update.notes?.length).toBe(MAX_NOTES_CHARS);
  });

  it("maps download progress", () => {
    const status: UpdateStatus = { kind: "installing", info, progress: { stage: "download", downloaded: 10, total: 100 } };
    expect(toRemoteUpdate(status)).toMatchObject({ state: "installing", stage: "download", downloaded: 10, total: 100 });
  });

  it("maps verify and install stages without byte counts", () => {
    expect(toRemoteUpdate({ kind: "installing", info, progress: { stage: "verify" } })).toEqual({
      state: "installing",
      version: "0.21.0",
      currentVersion: "0.20.0",
      notes: "Fixes",
      size: 1234,
      stage: "verify",
    });
    const install = toRemoteUpdate({ kind: "installing", info, progress: { stage: "install" } });
    expect(install.stage).toBe("install");
    expect(install).not.toHaveProperty("downloaded");
  });

  it("maps installing before any progress arrives", () => {
    const update = toRemoteUpdate({ kind: "installing", info, progress: null });
    expect(update).not.toHaveProperty("stage");
  });

  it("maps an error, with the update info when there is one", () => {
    expect(toRemoteUpdate({ kind: "error", message: "boom" })).toEqual({ state: "error", error: "boom" });
    expect(toRemoteUpdate({ kind: "error", message: "boom", info })).toMatchObject({
      state: "error",
      error: "boom",
      version: "0.21.0",
    });
  });
});
