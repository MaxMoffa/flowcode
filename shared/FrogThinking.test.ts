import { describe, expect, it } from "vitest";
import { formatElapsed, formatTokens } from "./FrogThinking";

describe("formatElapsed", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatElapsed(-5)).toBe("0s");
    expect(formatElapsed(45_000)).toBe("45s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });
});

describe("formatTokens", () => {
  it("estimates one token per 4 characters", () => {
    expect(formatTokens(3800)).toBe("950");
    expect(formatTokens(4800)).toBe("1.2k");
    expect(formatTokens(4000)).toBe("1k");
    expect(formatTokens(48_000)).toBe("12k");
  });
});
