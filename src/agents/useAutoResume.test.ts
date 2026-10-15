import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const { detectLimit, wakeText } = await import("./useAutoResume");

// Wed 2026-10-14 10:00 local.
const now = new Date(2026, 9, 14, 10, 0);
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

describe("detectLimit", () => {
  it("reads Claude Code's notice", () => {
    expect(detectLimit("You've hit your limit · resets 3pm (Europe/Rome)", now)).toEqual({ at: at(2026, 9, 14, 15, 0) });
  });
  it("reads Codex's notice with an ordinal date", () => {
    const text =
      "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit\n" +
      "https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 20th, 2026 3:45 PM.";
    expect(detectLimit(text, now)).toEqual({ at: at(2026, 9, 20, 15, 45) });
  });
  it("reads a Codex reset wrapped over lines", () => {
    const text = "You've hit your usage limit. Try again at\nOct 20th, 2026\n3:45 PM.";
    expect(detectLimit(text, now)).toEqual({ at: at(2026, 9, 20, 15, 45) });
  });
  it("reads a same-day Codex time", () => {
    expect(detectLimit("You've hit your usage limit. Try again at 1:20 PM.", now)).toEqual({ at: at(2026, 9, 14, 13, 20) });
  });
  it("detects a notice without a reset time", () => {
    expect(detectLimit("You've hit your usage limit. Contact your admin.", now)).toEqual({ at: null });
  });
  it("is null with no notice", () => {
    expect(detectLimit("all good", now)).toBeNull();
  });
});

describe("wakeText", () => {
  it("resumes a paused Codex goal with its command", () => {
    expect(wakeText("codex", "Goal paused (/goal resume)", "continue")).toBe("/goal resume");
  });
  it("types the message otherwise", () => {
    expect(wakeText("codex", "limit hit", "continue")).toBe("continue");
    expect(wakeText("claude", "Goal paused", "continue")).toBe("continue");
  });
});
