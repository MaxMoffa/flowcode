import { describe, expect, it } from "vitest";
import { decideHoles, holesKey, MAX_HOLES } from "./holesDecision";

const vp = { x: 0, y: 0, w: 1000, h: 800 };
const menu = { x: 100, y: 100, w: 200, h: 150, r: 8 };

describe("decideHoles", () => {
  it("gives an empty list when nothing covers", () => {
    expect(decideHoles(vp, [])).toEqual([]);
  });
  it("cuts a hole for a small overlay", () => {
    expect(decideHoles(vp, [menu])).toEqual([menu]);
  });
  it("freezes for a scrim or a drawer", () => {
    expect(decideHoles(vp, [{ x: 0, y: 0, w: 1000, h: 800, r: 0 }])).toBeNull();
    expect(decideHoles(vp, [{ x: 500, y: 0, w: 500, h: 800, r: 0 }])).toBeNull();
  });
  it("counts only the part inside the viewport", () => {
    expect(decideHoles(vp, [{ x: -5000, y: 0, w: 5100, h: 100, r: 0 }])).not.toBeNull();
  });
  it("freezes past the maximum of overlays", () => {
    expect(decideHoles(vp, Array(MAX_HOLES + 1).fill(menu))).toBeNull();
  });
});

describe("holesKey", () => {
  it("ignores sub-pixel changes", () => {
    expect(holesKey([{ x: 10.2, y: 5, w: 100, h: 50, r: 8 }])).toBe(holesKey([{ x: 10.4, y: 5, w: 100, h: 50, r: 8 }]));
  });
  it("tells null from empty", () => {
    expect(holesKey(null)).not.toBe(holesKey([]));
  });
});
