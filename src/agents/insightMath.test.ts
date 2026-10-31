import { describe, expect, it } from "vitest";
import { cacheHitRatio, contextSegments, estTokensOfChars, planKind, sparkBars } from "./insightMath";

describe("insightMath", () => {
  it("estimates tokens from chars", () => {
    expect(estTokensOfChars(9)).toBe(3);
    expect(estTokensOfChars(-5)).toBe(0);
  });
  it("splits context and clamps estimates to used", () => {
    expect(contextSegments(1000, 5000, 400, 200)).toEqual({ memory: 100, skills: 200, conversation: 700, free: 4000 });
    expect(contextSegments(50, 100, 4000, 200)).toEqual({ memory: 50, skills: 0, conversation: 0, free: 50 });
    expect(contextSegments(200, 100, 0, 0).free).toBe(0);
  });
  it("computes cache hit", () => {
    expect(cacheHitRatio({ input: 10, cacheRead: 80, cacheWrite: 10 })).toBe(0.8);
    expect(cacheHitRatio({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });
  it("scales sparkline", () => {
    expect(sparkBars([5, 10, 0])).toEqual({ heights: [50, 100, 4], max: 1 });
    expect(sparkBars([0, 0])).toEqual({ heights: [4, 4], max: -1 });
    expect(sparkBars([])).toEqual({ heights: [], max: -1 });
  });
  it("classifies plan metrics", () => {
    expect(planKind([{ kind: "session" }, { kind: "week" }])).toBe("plan");
    expect(planKind([{ kind: "billing" }, { kind: "spend" }])).toBe("payg");
    expect(planKind([{ kind: "loggedOut" }])).toBe("other");
  });
});
