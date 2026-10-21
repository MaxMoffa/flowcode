import { describe, expect, it } from "vitest";
import { twoFingerSwipe, type Point } from "./chatSwipe";

const p = (x: number, y: number): Point => ({ x, y });
type Pair = [Point, Point];
const from: Pair = [p(100, 400), p(180, 410)];
const moved = (dx1: number, dy1: number, dx2 = dx1, dy2 = dy1): Pair => [p(100 + dx1, 400 + dy1), p(180 + dx2, 410 + dy2)];

describe("twoFingerSwipe", () => {
  it("is +1 for both fingers moving left (the next view) and -1 for right", () => {
    expect(twoFingerSwipe(from, moved(-120, 6))).toBe(1);
    expect(twoFingerSwipe(from, moved(120, -8))).toBe(-1);
  });

  it("ignores short moves", () => {
    expect(twoFingerSwipe(from, moved(-40, 0))).toBe(0);
  });

  it("ignores a two-finger scroll: mostly vertical", () => {
    expect(twoFingerSwipe(from, moved(-90, 120))).toBe(0);
    expect(twoFingerSwipe(from, moved(-90, -60))).toBe(0);
  });

  it("needs both fingers to travel the same way", () => {
    expect(twoFingerSwipe(from, moved(-150, 0, 20, 0))).toBe(0);
    expect(twoFingerSwipe(from, moved(-150, 0, 150, 0))).toBe(0);
    // One finger barely moved: the average is far enough, the gesture is not a swipe.
    expect(twoFingerSwipe(from, moved(-150, 0, -5, 0))).toBe(0);
  });

  it("ignores a pinch or spread", () => {
    expect(twoFingerSwipe(from, [p(10, 400), p(40, 410)])).toBe(0);
    expect(twoFingerSwipe(from, [p(0, 400), p(300, 410)])).toBe(0);
  });

  it("tolerates fingers that start on top of each other", () => {
    expect(twoFingerSwipe([p(100, 400), p(100, 400)], [p(10, 400), p(10, 402)])).toBe(1);
  });
});
