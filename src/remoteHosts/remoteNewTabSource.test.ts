import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
const expected: unknown[] = [];
const memory = new Map<string, unknown[]>();
vi.mock("../lib/createListStore", () => ({
  createListStore: (key: string, _validate: unknown, max?: number) => ({
    get: () => memory.get(key) ?? [],
    set: (next: unknown[]) => memory.set(key, max ? next.slice(0, max) : next),
    subscribe: () => () => {},
  }),
}));
vi.mock("./hostRequest", () => ({ hostRequest: () => Promise.reject(new Error("unused")) }));
vi.mock("./remoteHosts", () => ({
  sendToHost: (_host: string, msg: unknown) => {
    sent.push(msg);
    return Promise.resolve(true);
  },
  expectNewTab: (_host: string, match: unknown) => expected.push(match),
  chatLike: (agent: string, cwd?: string) => ({ chat: agent, cwd }),
  terminalLike: (cwd?: string, cli?: string) => ({ terminal: cwd, cli }),
  useHost: () => undefined,
  useHostState: () => ({}),
}));

import { agentsForCaps, mergeRemoteRecents, recordRemoteRecent, startOnHost } from "./remoteNewTabSource";

const recent = (cwd: string, at: number) => ({ cwd, name: cwd, command: "", at });

describe("remote new tab recents", () => {
  it("puts open folders first, then launched ones newest first, one per folder", () => {
    const merged = mergeRemoteRecents([recent("C:/a", 1), recent("C:/b", 5), recent("c:/proj/", 3)], ["C:\\proj", "C:\\a"], 100);
    expect(merged.map((r) => r.cwd)).toEqual(["C:\\proj", "C:\\a", "C:/b"]);
    expect(merged[0].at).toBe(100);
  });

  it("remembers a launched folder once, newest first", () => {
    recordRemoteRecent("h1", "/srv/app");
    recordRemoteRecent("h1", "/srv/other");
    recordRemoteRecent("h1", "/srv/app/");
    expect(mergeRemoteRecents((memory.get("flowcode.remoteRecents.h1") ?? []) as ReturnType<typeof recent>[], [], 0).map((r) => r.cwd)).toEqual(["/srv/app/", "/srv/other"]);
  });
});

describe("remote agents", () => {
  it("lists the optional agents only when the host advertises them", () => {
    expect(agentsForCaps([])).not.toContain("gemini");
    expect(agentsForCaps([])).toContain("claude");
    expect(agentsForCaps(["gemini", "cline"])).toEqual(expect.arrayContaining(["gemini", "cline"]));
    expect(agentsForCaps(["gemini"])).not.toContain("opencode");
  });
});

describe("remote launch mapping", () => {
  beforeEach(() => {
    sent.length = 0;
    expected.length = 0;
  });

  it("a plain launch is a terminal in the folder", () => {
    startOnHost("h", [], { cwd: "/w" });
    expect(sent).toEqual([{ t: "newtab", cwd: "/w" }]);
  });

  it("an agent is a chat when the host has chats", () => {
    startOnHost("h", ["chat", "newTabProfile"], { cwd: "/w", agent: "codex", profile: "p1" });
    expect(sent).toEqual([{ t: "newchat", cli: "codex", cwd: "/w", profile: "p1" }]);
    expect(expected).toEqual([{ chat: "codex", cwd: "/w" }]);
  });

  it("an agent without chat support runs in a terminal", () => {
    startOnHost("h", [], { agent: "claude" });
    expect(sent).toEqual([{ t: "newtab", cli: "claude" }]);
    expect(expected).toEqual([{ terminal: undefined, cli: "claude" }]);
  });

  it("the default profile is sent as empty, and only to hosts that take one", () => {
    startOnHost("h", ["newTabProfile"], { profile: null });
    startOnHost("h", [], { profile: "p1" });
    expect(sent).toEqual([{ t: "newtab", profile: "" }, { t: "newtab" }]);
  });
});
