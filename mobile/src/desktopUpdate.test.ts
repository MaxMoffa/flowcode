import { describe, expect, it } from "vitest";
import { normalizeDesktopUpdate } from "./desktopUpdate";

describe("normalizeDesktopUpdate", () => {
  it("is null for non-objects", () => {
    for (const v of [null, undefined, 3, "x", []]) expect(normalizeDesktopUpdate(v)).toBeNull();
  });
  it("unknown state becomes idle, allowed needs true", () => {
    expect(normalizeDesktopUpdate({ state: "weird", allowed: "yes" })).toMatchObject({ state: "idle", allowed: false });
  });
  it("keeps a valid progress", () => {
    expect(normalizeDesktopUpdate({ allowed: true, state: "installing", stage: "download", downloaded: 5, total: 10, version: "1.2.3" })).toMatchObject({ allowed: true, state: "installing", stage: "download", downloaded: 5, total: 10, version: "1.2.3" });
  });
  it("drops bad numbers and stages, caps strings", () => {
    const u = normalizeDesktopUpdate({ state: "error", stage: "x", downloaded: NaN, total: Infinity, size: -1, error: "e".repeat(2000) });
    expect(u).toMatchObject({ stage: undefined, downloaded: undefined, total: undefined, size: undefined });
    expect(u?.error).toHaveLength(500);
  });
});
