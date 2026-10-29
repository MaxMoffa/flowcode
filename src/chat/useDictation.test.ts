import { describe, expect, it } from "vitest";
import { appendDictation, HOLD_MS, isOwnEvent, nextLevel, spaceRelease } from "./useDictation";

describe("isOwnEvent", () => {
  it("accepts only the session the chat started", () => {
    expect(isOwnEvent("a", { session: "a" })).toBe(true);
    expect(isOwnEvent("a", { session: "b" })).toBe(false);
    expect(isOwnEvent("a", {})).toBe(false);
    expect(isOwnEvent(null, { session: "a" })).toBe(false);
  });
});

describe("nextLevel", () => {
  it("rises at once and decays", () => {
    const up = nextLevel(0, 0.25);
    expect(up).toBeGreaterThan(0.5);
    expect(nextLevel(up, 0)).toBeLessThan(up);
    expect(nextLevel(up, 0)).toBeGreaterThan(0);
  });
  it("stays within 0..1", () => {
    expect(nextLevel(0, 5)).toBe(1);
    expect(nextLevel(0, -1)).toBe(0);
  });
});

describe("appendDictation", () => {
  it("starts an empty draft with the phrase", () => {
    expect(appendDictation("", "  hello there ")).toBe("hello there");
  });

  it("adds a space between the draft and the phrase", () => {
    expect(appendDictation("fix the bug", "in the parser")).toBe("fix the bug in the parser");
  });

  it("does not double a space or newline already there", () => {
    expect(appendDictation("fix ", "it")).toBe("fix it");
    expect(appendDictation("line\n", "next")).toBe("line\nnext");
  });

  it("leaves the draft alone for an empty phrase", () => {
    expect(appendDictation("draft", "  ")).toBe("draft");
  });
});

describe("spaceRelease", () => {
  it("stops a hold when hold is enabled", () => {
    expect(spaceRelease(HOLD_MS, true, true)).toBe("stop");
    expect(spaceRelease(2000, false, true)).toBe("stop");
  });
  it("keeps a quick tap listening when tap is enabled", () => {
    expect(spaceRelease(HOLD_MS - 1, true, true)).toBe("keep");
    expect(spaceRelease(50, true, false)).toBe("keep");
  });
  it("stops a quick tap in hold-only mode", () => {
    expect(spaceRelease(50, false, true)).toBe("stop");
  });
  it("treats a long press as a tap in tap-only mode", () => {
    expect(spaceRelease(2000, true, false)).toBe("keep");
  });
});
