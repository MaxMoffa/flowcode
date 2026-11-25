import { describe, expect, it } from "vitest";
import { formatBytes, formatTokens } from "./format";

describe("format", () => {
  it("formats bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
  it("formats tokens", () => {
    expect(formatTokens(920)).toBe("920");
    expect(formatTokens(850_400)).toBe("850K");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    expect(formatTokens(12_400_000)).toBe("12M");
  });
});
