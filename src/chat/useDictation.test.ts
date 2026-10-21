import { describe, expect, it } from "vitest";
import { appendDictation } from "./useDictation";

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
