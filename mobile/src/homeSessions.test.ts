import { describe, expect, it } from "vitest";
import { groupSessions, lastInWindow, sessionsOf, trackSince, type SessionStatus } from "./homeSessions";
import type { ChatInfo, Tab } from "./remote";

const tab = (ptyId: string, extra: Partial<Tab> = {}): Tab => ({ ptyId, tabId: "t" + ptyId, window: "main", label: ptyId, cwd: "/a/b", cols: 80, rows: 24, ...extra });
const chat = (chatId: string, extra: Partial<ChatInfo> = {}): ChatInfo => ({ chatId, tabId: "t" + chatId, window: "main", label: chatId, agent: "claude", cwd: "/a/b", ...extra });

describe("lastInWindow", () => {
  it("counts tabs and chats of that window", () => {
    expect(lastInWindow("main", [tab("1")], [])).toBe(true);
    expect(lastInWindow("main", [tab("1")], [chat("c")])).toBe(false);
    expect(lastInWindow("main", [], [chat("c"), chat("d")])).toBe(false);
    expect(lastInWindow("main", [tab("1"), tab("2", { window: "w2" })], [])).toBe(true);
  });
});

describe("sessionsOf", () => {
  it("keeps agent terminals and chats only", () => {
    const list = sessionsOf([tab("1"), tab("2", { cli: "codex", status: "busy", context: { used: 50, window: 100 } })], [chat("c", { status: "starting" }), chat("d")]);
    expect(list.map((s) => s.key)).toEqual(["t:2", "c:c", "c:d"]);
    expect(list[0]).toMatchObject({ kind: "term", cli: "codex", status: "busy", contextPct: 50 });
    expect(list[1]).toMatchObject({ kind: "chat", cli: "claude", status: "starting", contextPct: null });
  });
  it("reads a missing status as idle", () => {
    const list = sessionsOf([tab("1", { cli: "claude" })], [chat("c")]);
    expect(list.map((s) => s.status)).toEqual(["idle", "idle"]);
  });
});

describe("groupSessions", () => {
  it("puts starting with busy", () => {
    const list = sessionsOf([tab("1", { cli: "claude", status: "waiting" }), tab("2", { cli: "claude", status: "busy" })], [chat("a", { status: "starting" }), chat("b"), chat("c", { status: "exited" })]);
    const g = groupSessions(list);
    expect(g.waiting.map((s) => s.key)).toEqual(["t:1"]);
    expect(g.working.map((s) => s.key)).toEqual(["t:2", "c:a"]);
    expect(g.idle.map((s) => s.key)).toEqual(["c:b"]);
    expect(g.exited.map((s) => s.key)).toEqual(["c:c"]);
  });
});

describe("trackSince", () => {
  it("keeps the first moment while the status stays", () => {
    const seen = new Map<string, { status: SessionStatus; since: number }>();
    expect(trackSince(seen, "k", "busy", 100)).toBe(100);
    expect(trackSince(seen, "k", "busy", 500)).toBe(100);
  });
  it("starts over when the status changes", () => {
    const seen = new Map<string, { status: SessionStatus; since: number }>();
    trackSince(seen, "k", "busy", 100);
    expect(trackSince(seen, "k", "idle", 500)).toBe(500);
    expect(trackSince(seen, "k", "idle", 900)).toBe(500);
  });
});
