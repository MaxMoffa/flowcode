import { describe, expect, it } from "vitest";
import type { ChatGoal, ChatItem } from "./chatModel";
import { formatElapsed, formatElapsedLong, goalElapsedMs, goalKey, shouldShowGoal } from "./goalView";

const goal = (over: Partial<ChatGoal> = {}): ChatGoal => ({ objective: "ship it", status: "active", setAt: 1000, iterations: null, durationMs: null, tokens: null, reason: null, ...over });
const marker: ChatItem = { type: "goal", id: "g", status: "complete", objective: "ship it", at: 5 };
const user = { type: "user", id: "u", text: "hi" } as unknown as ChatItem;

describe("goalView", () => {
  it("formats elapsed time", () => {
    expect(formatElapsed(10_000)).toBe("<1m");
    expect(formatElapsed(23 * 60_000)).toBe("23m");
    expect(formatElapsed(65 * 60_000)).toBe("1h 05m");
    expect(formatElapsedLong(23 * 60_000)).toBe("23 min");
    expect(formatElapsedLong(65 * 60_000)).toBe("1h 05m");
  });

  it("measures elapsed from setAt, or the final duration once ended", () => {
    expect(goalElapsedMs(goal(), 61_000)).toBe(60_000);
    expect(goalElapsedMs(goal({ setAt: null }), 61_000)).toBeNull();
    expect(goalElapsedMs(goal({ status: "complete", durationMs: 5000 }), 99_000)).toBe(5000);
  });

  it("shows live goals always", () => {
    expect(shouldShowGoal(goal(), [marker, user], null)).toBe(true);
    expect(shouldShowGoal(null, [], null)).toBe(false);
  });

  it("hides an ended goal once dismissed or after a later user message", () => {
    const done = goal({ status: "complete" });
    expect(shouldShowGoal(done, [marker], null)).toBe(true);
    expect(shouldShowGoal(done, [marker], goalKey(done))).toBe(false);
    expect(shouldShowGoal(done, [marker], goalKey(goal({ status: "failed" })))).toBe(true);
    expect(shouldShowGoal(done, [user, marker], null)).toBe(true);
    expect(shouldShowGoal(done, [marker, user], null)).toBe(false);
  });
});
