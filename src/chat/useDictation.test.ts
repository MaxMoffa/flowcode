import { describe, expect, it } from "vitest";
import { appendDictation, isOwnEvent, nextLevel } from "./useDictation";

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
