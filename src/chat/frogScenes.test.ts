import { describe, expect, it } from "vitest";
import { clearFrame, loadFrame, RISE_TAIL_MS } from "./frogScenes";

describe("frogScenes", () => {
  it("clear: hidden at first, rings burst, rests by 3000 ms", () => {
    expect(clearFrame(0).show).toBe(false);
    expect(clearFrame(600).rings.length).toBeGreaterThan(1);
    const end = clearFrame(3000);
    expect(end).toMatchObject({ done: true, lift: 0, lid: 0, vivid: 0, waterline: null });
    expect(end.rings).toEqual([]);
    expect(clearFrame(2999).done).toBe(false);
  });

  it("clear: the frog is clipped by the water while it rises", () => {
    const f = clearFrame(400);
    expect(f.lift).toBeGreaterThan(0);
    expect(f.waterline).toBeGreaterThan(0);
    expect(f.waterline).toBeLessThan(1);
  });

  it("load: stays submerged, eyes out, while looping", () => {
    for (let t = 0; t < 20000; t += 137) {
      const f = loadFrame(t, null);
      expect(f.lift).toBeGreaterThan(150);
      // The eyes' top (y 308 in the frog's units) is above the water.
      expect((308 + f.lift - 205) / 650).toBeLessThan(f.waterline!);
      expect(f.done).toBe(false);
      expect(f.waterline).toBeLessThan(1);
    }
    expect(loadFrame(4000, null).rings.length).toBeGreaterThan(0);
  });

  it("load: rises to the surface once ready, then settles", () => {
    const ready = 5000;
    expect(loadFrame(ready + 700, ready).lift).toBe(0);
    expect(loadFrame(ready + 700, ready).waterline).toBeNull();
    expect(loadFrame(ready + 350, ready).waterline).toBeGreaterThan(0.55);
    expect(loadFrame(ready + 350, ready).lift).toBeGreaterThan(-60);
    const end = loadFrame(ready + RISE_TAIL_MS, ready);
    expect(end).toMatchObject({ done: true, lift: 0, lid: 0, vivid: 0 });
    expect(end.rings).toEqual([]);
  });
});
