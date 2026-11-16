import { describe, expect, it } from "vitest";
import { shouldArmReset } from "./autoResumeDecision";

describe("shouldArmReset", () => {
  it("arms a fresh reset", () => {
    expect(shouldArmReset(1000, undefined, undefined)).toBe(true);
  });

  it("does not re-arm the same reset after a cancel", () => {
    expect(shouldArmReset(1000, undefined, 1000)).toBe(false);
    expect(shouldArmReset(900, undefined, 1000)).toBe(false);
  });

  it("arms a strictly later reset after a cancel", () => {
    expect(shouldArmReset(1001, undefined, 1000)).toBe(true);
  });

  it("does not re-arm a reset already woken for", () => {
    expect(shouldArmReset(1000, 1000, undefined)).toBe(false);
    expect(shouldArmReset(1001, 1000, undefined)).toBe(true);
  });
});
