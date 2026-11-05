import { describe, expect, it } from "vitest";
import { dragTarget } from "./browserDrag";

const HALF = 500;
const FULL = 800;

describe("dragTarget", () => {
  it("settles on the nearest detent after a slow release", () => {
    expect(dragTarget(60, 0, HALF, FULL)).toBe("closed");
    expect(dragTarget(480, 0, HALF, FULL)).toBe("half");
    expect(dragTarget(760, 0, HALF, FULL)).toBe("full");
  });
  it("closes on a fast fling down from half", () => {
    expect(dragTarget(HALF, 1.5, HALF, FULL)).toBe("closed");
  });
  it("goes full on a fast fling up from half", () => {
    expect(dragTarget(HALF, -1.5, HALF, FULL)).toBe("full");
  });
});
