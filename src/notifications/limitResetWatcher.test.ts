import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

const { parseResetTimeGuarded } = await import("./limitResetWatcher");

// Wed 2026-10-14 10:00 local.
const now = new Date(2026, 9, 14, 10, 0);
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

describe("parseResetTimeGuarded", () => {
  it("reads a bare 12-hour time as its next occurrence", () => {
    expect(parseResetTimeGuarded("3pm (Europe/Rome)", now)).toBe(at(2026, 9, 14, 15, 0));
    expect(parseResetTimeGuarded("1:20pm", now)).toBe(at(2026, 9, 14, 13, 20));
  });
  it("reads Codex 24-hour times and dates", () => {
    expect(parseResetTimeGuarded("11:32", now)).toBe(at(2026, 9, 14, 11, 32));
    expect(parseResetTimeGuarded("07:32 on 20 Oct", now)).toBe(at(2026, 9, 20, 7, 32));
  });
  it("reads Claude Code month-day times", () => {
    expect(parseResetTimeGuarded("Oct 19, 12am (Europe/Rome)", now)).toBe(at(2026, 9, 19, 0, 0));
  });
  it("reads January in late December as next year", () => {
    expect(parseResetTimeGuarded("Jan 2, 9am", new Date(2026, 11, 30, 10, 0))).toBe(at(2027, 0, 2, 9, 0));
  });
  it("is null when unreadable or out of range", () => {
    expect(parseResetTimeGuarded("soon", now)).toBeNull();
    expect(parseResetTimeGuarded("25:00", now)).toBeNull();
  });
  it("treats a dateless reset beyond the 5-hour window as stale", () => {
    // 9am already passed today, so it means tomorrow: 23 h away.
    expect(parseResetTimeGuarded("9am", now)).toBeNull();
    expect(parseResetTimeGuarded("11pm", now)).toBeNull();
    // With a date it is trusted.
    expect(parseResetTimeGuarded("Oct 14, 11pm", now)).toBe(at(2026, 9, 14, 23, 0));
  });
});
