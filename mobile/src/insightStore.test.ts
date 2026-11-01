import { describe, expect, it } from "vitest";
import { getInsight, insightKey, storeInsight } from "./insightStore";

describe("agent insight store", () => {
  it("keeps a reply under its key, latest wins", () => {
    storeInsight("p1", { cli: "claude", context: { used: 1, window: 10 } });
    storeInsight("p1", { cli: "claude", context: { used: 5, window: 10 }, usage: null });
    expect(getInsight("p1")?.context?.used).toBe(5);
    expect(getInsight("nope")).toBeUndefined();
  });

  it("keys a chat target by its chatId, a terminal by its ptyId", () => {
    expect(insightKey({ chatId: "c1" })).toBe("c1");
    expect(insightKey({ ptyId: "p2" })).toBe("p2");
  });
});
