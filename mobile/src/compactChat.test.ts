import { describe, expect, it } from "vitest";
import { compactChatViewport } from "./compactChat";

describe("compact chat viewport", () => {
  it("keeps the regular layout on portrait phones and full tablets", () => {
    expect(compactChatViewport(390, 844, 390, 844)).toBe(false);
    expect(compactChatViewport(768, 1024, 768, 1024)).toBe(false);
    expect(compactChatViewport(1280, 800, 1280, 800)).toBe(false);
  });
  it("uses the reading layout in short windows, including wide horizontal splits", () => {
    expect(compactChatViewport(390, 420, 390, 844)).toBe(true);
    expect(compactChatViewport(1280, 400, 1280, 800)).toBe(true);
    expect(compactChatViewport(844, 390, 844, 390)).toBe(true);
    expect(compactChatViewport(390, 600, 390, 844)).toBe(true);
  });
  it("recognizes narrow tablet splits in either orientation", () => {
    expect(compactChatViewport(510, 1024, 1280, 800)).toBe(true);
    expect(compactChatViewport(510, 1024, 800, 1280)).toBe(true);
    expect(compactChatViewport(759, 1024, 768, 1024)).toBe(true);
  });
});
