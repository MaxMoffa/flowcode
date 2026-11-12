import { describe, expect, it } from "vitest";
import { dropIndex, moveItem, moveWithinWindow, windowRange } from "./tabDrag";

const rects = [0, 100, 200, 300].map((left) => ({ left, width: 100 }));

describe("windowRange", () => {
  it("finds the run of the same window", () => {
    const w = ["a", "a", "b", "b", "b", "c"];
    expect(windowRange(w, 0)).toEqual({ start: 0, end: 2 });
    expect(windowRange(w, 3)).toEqual({ start: 2, end: 5 });
    expect(windowRange(w, 5)).toEqual({ start: 5, end: 6 });
  });
});

describe("dropIndex", () => {
  it("keeps the tab in place while the pointer is near it", () => {
    expect(dropIndex(150, rects, 1)).toBe(1);
  });
  it("moves right past the centre of the next tab", () => {
    expect(dropIndex(251, rects, 1)).toBe(2);
    expect(dropIndex(249, rects, 1)).toBe(1);
  });
  it("moves left past the centre of the previous tab", () => {
    expect(dropIndex(40, rects, 2)).toBe(0);
  });
  it("clamps to the window's ends", () => {
    expect(dropIndex(-500, rects, 2)).toBe(0);
    expect(dropIndex(5000, rects, 0)).toBe(3);
  });
});

describe("moveItem", () => {
  it("moves forward and back", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });
  it("returns the same list when nothing moves", () => {
    const l = ["a", "b"];
    expect(moveItem(l, 1, 1)).toBe(l);
  });
});

describe("moveWithinWindow", () => {
  const keys = ["a1", "a2", "b1", "b2", "b3"];
  it("reorders inside the window only", () => {
    expect(moveWithinWindow(keys, "b1", 2, 5, 2)).toEqual(["a1", "a2", "b2", "b3", "b1"]);
  });
  it("clamps an index past the window", () => {
    expect(moveWithinWindow(keys, "a1", 0, 2, 9)).toEqual(["a2", "a1", "b1", "b2", "b3"]);
  });
  it("ignores a key outside the range", () => {
    expect(moveWithinWindow(keys, "a1", 2, 5, 0)).toBe(keys);
  });
});
