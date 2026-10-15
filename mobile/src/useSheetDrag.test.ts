import { describe, expect, it } from "vitest";
import { releaseVelocity, shouldClose } from "./useSheetDrag";

describe("shouldClose", () => {
  it("closes past 30% of the sheet", () => {
    expect(shouldClose(200, 600, 0)).toBe(true);
    expect(shouldClose(100, 600, 0)).toBe(false);
  });
  it("closes on a fast fling even when short", () => {
    expect(shouldClose(20, 600, 0.8)).toBe(true);
    expect(shouldClose(20, 600, 0.3)).toBe(false);
  });
});

describe("releaseVelocity", () => {
  it("measures over the last 80 ms only", () => {
    const samples = [
      { t: 0, d: 0 },
      { t: 100, d: 10 },
      { t: 150, d: 60 },
      { t: 180, d: 90 },
    ];
    expect(releaseVelocity(samples, 190)).toBeCloseTo(1);
  });
  it("is 0 with too little data", () => {
    expect(releaseVelocity([], 100)).toBe(0);
    expect(releaseVelocity([{ t: 90, d: 5 }], 100)).toBe(0);
    expect(
      releaseVelocity(
        [
          { t: 0, d: 0 },
          { t: 100, d: 50 },
        ],
        300,
      ),
    ).toBe(0);
  });
});
