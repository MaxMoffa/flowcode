import { describe, expect, it } from "vitest";
import type { ChatInfo, Tab } from "../../shared/remote-types";
import { actionAgent, actionExpired, buildSnapshot, localMidnight, pickAgents, resumeTarget } from "./widgetsModel";

const tab = (ptyId: string) => ({ ptyId }) as Tab;
const chat = (chatId: string) => ({ chatId }) as ChatInfo;

describe("widget snapshot", () => {
  it("builds the contract shape with clamped numbers", () => {
    const now = new Date(2026, 10, 15, 14, 30).getTime();
    const s = buildSnapshot({ days: [1, 2, -3, 0, 5, 6], streak: 3.7, todayMinutes: Number.NaN }, ["claude"], now);
    expect(s).toEqual({ v: 1, dayStart: new Date(2026, 10, 15).getTime(), days: [1, 2, 0, 0, 5, 6, 0], streak: 3, todayMinutes: 0, agents: ["claude"], updatedAt: now });
  });
  it("finds local midnight", () => {
    const t = new Date(2026, 5, 1, 23, 59).getTime();
    expect(localMidnight(t)).toBe(new Date(2026, 5, 1).getTime());
  });
});

describe("widget agents", () => {
  const usable = ["claude", "codex", "vibe", "gemini", "opencode"];
  it("puts the remembered agent first and keeps at most four", () => {
    expect(pickAgents(usable, "vibe")).toEqual(["vibe", "claude", "codex", "gemini"]);
  });
  it("ignores a remembered agent that is not usable", () => {
    expect(pickAgents(["claude", "codex"], "gemini")).toEqual(["claude", "codex"]);
    expect(pickAgents(usable, null)).toEqual(["claude", "codex", "vibe", "gemini"]);
  });
  it("picks the agent of a tap among the usable ones", () => {
    expect(actionAgent("codex", "claude", usable)).toBe("codex");
    expect(actionAgent("nope", "vibe", usable)).toBe("vibe");
    expect(actionAgent(undefined, null, usable)).toBe("claude");
    expect(actionAgent("codex", null, [])).toBeUndefined();
  });
});

describe("widget taps", () => {
  it("resumes the last opened terminal if it is still there, else the latest chat", () => {
    expect(resumeTarget("b", [tab("a"), tab("b")], [chat("c1")])).toEqual({ kind: "tab", id: "b" });
    expect(resumeTarget("gone", [tab("a")], [chat("c1"), chat("c2")])).toEqual({ kind: "chat", id: "c2" });
    expect(resumeTarget(null, [], [])).toBeNull();
  });
  it("drops a tap after a minute", () => {
    expect(actionExpired(0, 59_000)).toBe(false);
    expect(actionExpired(0, 61_000)).toBe(true);
  });
});
