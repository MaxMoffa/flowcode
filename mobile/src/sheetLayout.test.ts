import { describe, expect, it } from "vitest";
import { dragEdge, wrapFocusIndex } from "./sheetLayout";

describe("dragEdge", () => {
  it("keeps the bottom sheet on the phone", () => {
    expect(dragEdge(false, "dialog", "right", false)).toBe("down");
    expect(dragEdge(false, "drawer", "right", false)).toBe("down");
  });
  it("keeps a phone side drawer on its side", () => {
    expect(dragEdge(false, "drawer", "left", true)).toBe("left");
    expect(dragEdge(false, "drawer", "right", true)).toBe("right");
  });
  it("drags a tablet drawer toward its side and leaves dialogs to the keyboard", () => {
    expect(dragEdge(true, "drawer", "right", false)).toBe("right");
    expect(dragEdge(true, "drawer", "left", false)).toBe("left");
    expect(dragEdge(true, "dialog", "right", false)).toBeNull();
  });
});

describe("wrapFocusIndex", () => {
  it("wraps forward and backward", () => {
    expect(wrapFocusIndex(2, 3, false)).toBe(0);
    expect(wrapFocusIndex(0, 3, true)).toBe(2);
    expect(wrapFocusIndex(0, 3, false)).toBe(1);
  });
  it("enters from outside at the first or last element", () => {
    expect(wrapFocusIndex(-1, 4, false)).toBe(0);
    expect(wrapFocusIndex(-1, 4, true)).toBe(3);
  });
  it("has nowhere to go without focusable elements", () => {
    expect(wrapFocusIndex(-1, 0, false)).toBe(-1);
  });
});
