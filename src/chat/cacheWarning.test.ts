import { describe, expect, it } from "vitest";
import { CACHE_IDLE_MS, cacheWarningDelay, resumedActivity, eventsActivity, trackActivity, NO_ACTIVITY } from "./cacheWarning";
import type { ChatEvent } from "./chatTypes";

const items = [{ type: "user" }, { type: "agent" }, { type: "user" }, { type: "agent" }];
const base = { agent: "claude", idle: true, items, lastActivityAt: 1_000_000, now: 1_000_000 + CACHE_IDLE_MS + 1 };

describe("cacheWarningDelay", () => {
  it("is 0 once the idle time has passed", () => {
    expect(cacheWarningDelay(base)).toBe(0);
  });
  it("is the remaining time before that", () => {
    expect(cacheWarningDelay({ ...base, now: base.lastActivityAt + 60_000 })).toBe(CACHE_IDLE_MS - 60_000);
  });
  it("is null for other agents, a busy chat or unknown activity", () => {
    expect(cacheWarningDelay({ ...base, agent: "codex" })).toBeNull();
    expect(cacheWarningDelay({ ...base, idle: false })).toBeNull();
    expect(cacheWarningDelay({ ...base, lastActivityAt: null })).toBeNull();
  });
  it("needs a user message", () => {
    expect(cacheWarningDelay({ ...base, items: [{ type: "agent" }, { type: "agent" }, { type: "tool" }, { type: "agent" }] })).toBeNull();
  });
  it("uses the context size when known", () => {
    expect(cacheWarningDelay({ ...base, usageTokens: 5_000 })).toBeNull();
    expect(cacheWarningDelay({ ...base, usageTokens: 50_000, items: [{ type: "user" }] })).toBe(0);
  });
  it("honours a custom cache lifetime", () => {
    const hour = 60 * 60_000;
    expect(cacheWarningDelay({ ...base, ttlMs: hour })).toBe(hour - CACHE_IDLE_MS - 1);
    expect(cacheWarningDelay({ ...base, ttlMs: hour, now: base.lastActivityAt + hour + 1 })).toBe(0);
  });
  it("falls back to the item count without usage", () => {
    expect(cacheWarningDelay({ ...base, items: [{ type: "user" }, { type: "agent" }] })).toBeNull();
  });
});

describe("activity", () => {
  const upd = (seq: number, at: number, extra: Record<string, unknown> = {}): ChatEvent => ({ seq, at, kind: "update", update: { sessionUpdate: "usage_update", ...extra } });
  it("tracks the latest time and the last reported size", () => {
    const a = eventsActivity([upd(1, 10, { used: 100 }), upd(2, 30, { used: 2000 }), upd(3, 20)]);
    expect(a).toEqual({ at: 30, tokens: 2000 });
  });
  it("is unknown without events", () => {
    expect(eventsActivity([])).toBe(NO_ACTIVITY);
    expect(trackActivity(NO_ACTIVITY, { seq: 1, at: 5, kind: "exit", code: 0 })).toEqual({ at: 5, tokens: null });
  });
});

describe("resumedActivity", () => {
  const replayed = { at: 9_000_000, tokens: 40_000 };
  it("uses the known time instead of the replay's load time", () => {
    expect(resumedActivity(replayed, 1_000)).toEqual({ at: 1_000, tokens: 40_000 });
  });
  it("keeps an unknown time unknown, so no notice", () => {
    const a = resumedActivity(replayed, undefined);
    expect(a.at).toBeNull();
    expect(cacheWarningDelay({ ...base, lastActivityAt: a.at, usageTokens: a.tokens, now: 9_000_000 })).toBeNull();
  });
  it("lets a later live event take over", () => {
    const a = trackActivity(resumedActivity(replayed, 1_000), { seq: 9, at: 5_000, kind: "exit", code: 0 });
    expect(a.at).toBe(5_000);
  });
});
