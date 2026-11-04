import { describe, expect, it } from "vitest";
import { tailLines } from "./terminalOutput";

describe("tailLines", () => {
  it("keeps the last lines, skipping blank ones", () => {
    expect(tailLines("a\n\nb\n  \nc\nd\n", 3)).toBe("b\nc\nd");
  });

  it("returns everything when there are fewer lines", () => {
    expect(tailLines("a\nb", 3)).toBe("a\nb");
  });

  it("is empty for no output", () => {
    expect(tailLines("", 3)).toBe("");
  });
});
