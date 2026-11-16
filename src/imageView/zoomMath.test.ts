import { describe, expect, it } from "vitest";
import { fitScale, zoomAt } from "./zoomMath";

describe("image fit and zoom", () => {
  it("contains large landscape and portrait images, without upscaling small ones", () => {
    expect(fitScale(1000, 600, 4000, 2000)).toBeCloseTo(968 / 4000);
    expect(fitScale(1000, 600, 1000, 8000)).toBeCloseTo(568 / 8000);
    expect(fitScale(1000, 600, 80, 50)).toBe(1);
    expect(fitScale(0, 0, 4000, 2000)).toBe(0);
  });
  it("keeps the cursor on the same image point, including after panning", () => {
    const before = { fit: false, scale: 0.5, tx: 20, ty: -30 };
    const after = zoomAt(before, 1, 200, 100);
    expect((200 - after.tx) / after.scale).toBe((200 - before.tx) / before.scale);
    expect((100 - after.ty) / after.scale).toBe((100 - before.ty) / before.scale);
    expect(after.fit).toBe(false);
    expect(zoomAt(before, 100).scale).toBe(8);
    expect(zoomAt(before, 0).scale).toBe(0.05);
  });
});
