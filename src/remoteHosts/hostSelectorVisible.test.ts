import { describe, expect, it } from "vitest";
import { hostSelectorVisible } from "./hostSelectorVisible";

const on = { status: "online" as const };
const off = { status: "offline" as const };

describe("hostSelectorVisible", () => {
  it("is hidden with no paired PC", () => {
    expect(hostSelectorVisible([], false, true)).toBe(false);
    expect(hostSelectorVisible([], true, true)).toBe(false);
  });
  it("is always visible with another PC in front", () => {
    expect(hostSelectorVisible([off], true, false)).toBe(true);
  });
  it("on this PC needs a connected PC and the setting on", () => {
    expect(hostSelectorVisible([off], false, true)).toBe(false);
    expect(hostSelectorVisible([off, on], false, false)).toBe(false);
    expect(hostSelectorVisible([off, on], false, true)).toBe(true);
  });
});
