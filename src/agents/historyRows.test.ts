import { describe, expect, it } from "vitest";
import { buildHistoryRows, filterRows, groupByDay, inProject, type HistoryEntries, type OpenSession } from "./historyRows";

const empty: HistoryEntries = { claude: [], codex: [], vibe: [], opencode: [] };
const claude = (sessionId: string, cwd: string, updatedAt: number, title: string | null = null) => ({ cwd, sessionId, title, startedAt: updatedAt, updatedAt, profile: null });
const codex = (sessionId: string, cwd: string, startedAt: number, wslDistro: string | null = null) => ({
  cwd, sessionId, startedAt, wslDistro, name: null, live: false, status: null, inFlowcode: false, profile: null,
});

describe("buildHistoryRows", () => {
  it("keeps only sessions inside the roots", () => {
    const rows = buildHistoryRows({
      entries: { ...empty, claude: [claude("a", "C:\\p\\app", 1), claude("b", "C:\\p\\app\\sub", 2), claude("c", "C:\\p\\other", 3)] },
      roots: ["C:\\p\\app"],
    });
    expect(rows.map((r) => r.sessionId)).toEqual(["b", "a"]);
  });

  it("accepts any of several roots (worktrees)", () => {
    const rows = buildHistoryRows({
      entries: { ...empty, claude: [claude("a", "/r/main", 1), claude("b", "/r/wt", 2), claude("c", "/r/x", 3)] },
      roots: ["/r/main", "/r/wt"],
    });
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["a", "b"]);
  });

  it("matches WSL sessions by distro", () => {
    const rows = buildHistoryRows({
      entries: { ...empty, codex: [codex("w", "/home/me/app", 5, "Ubuntu"), codex("o", "/home/me/app", 6, "Debian")] },
      roots: ["\\\\wsl.localhost\\Ubuntu\\home\\me\\app"],
    });
    expect(rows.map((r) => r.sessionId)).toEqual(["w"]);
  });

  it("marks a saved row open instead of duplicating it, and lists unsaved open sessions", () => {
    const open: OpenSession[] = [
      { cli: "claude", sessionId: "a", title: "tab", cwd: "/p", wslDistro: null, profile: null, tabId: "t1", status: "busy", at: null },
      { cli: "claude", sessionId: "", title: "new", cwd: "/p", wslDistro: null, profile: null, tabId: "t2", status: "idle", at: null },
    ];
    const rows = buildHistoryRows({ entries: { ...empty, claude: [claude("a", "/p", 10, "saved")] }, roots: ["/p"], open, now: 99 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ key: "tab:t2", at: 99, tabId: "t2" });
    expect(rows[1]).toMatchObject({ sessionId: "a", title: "saved", tabId: "t1", status: "busy", at: 10 });
  });

  it("drops open sessions outside the roots and excluded keys", () => {
    const open: OpenSession[] = [{ cli: "codex", sessionId: "z", title: null, cwd: "/other", wslDistro: null, profile: null, tabId: "t", at: 1 }];
    const rows = buildHistoryRows({ entries: { ...empty, claude: [claude("a", "/p", 1), claude("b", "/p", 2)] }, roots: ["/p"], open, exclude: new Set(["claude:b"]) });
    expect(rows.map((r) => r.sessionId)).toEqual(["a"]);
  });

  it("dedupes live duplicates preferring the open one", () => {
    const mk = (tabId: string, at: number | null): OpenSession => ({ cli: "codex", sessionId: "s", title: null, cwd: "/p", wslDistro: null, profile: null, tabId, at });
    const rows = buildHistoryRows({ entries: empty, roots: ["/p"], open: [mk("t1", 5), mk("t2", 9)] });
    expect(rows).toHaveLength(1);
    expect(rows[0].tabId).toBe("t2");
  });

  it("sorts newest first across agents", () => {
    const rows = buildHistoryRows({
      entries: { ...empty, claude: [claude("c", "/p", 5)], codex: [codex("x", "/p", 9)] },
      roots: ["/p"],
    });
    expect(rows.map((r) => r.sessionId)).toEqual(["x", "c"]);
  });
});

describe("filterRows", () => {
  it("matches titles case-insensitively", () => {
    const rows = buildHistoryRows({ entries: { ...empty, claude: [claude("a", "/p", 1, "Fix Login"), claude("b", "/p", 2, "Other")] }, roots: ["/p"] });
    expect(filterRows(rows, " login ", (r) => r.title ?? "").map((r) => r.sessionId)).toEqual(["a"]);
    expect(filterRows(rows, "", (r) => r.title ?? "")).toHaveLength(2);
  });
});

describe("groupByDay", () => {
  it("groups consecutive rows by day", () => {
    const now = new Date(2026, 10, 11, 15).getTime();
    const day = 86_400_000;
    const rows = buildHistoryRows({
      entries: { ...empty, claude: [claude("a", "/p", now - 1000), claude("b", "/p", now - 3600_000), claude("c", "/p", now - day), claude("d", "/p", now - 3 * day)] },
      roots: ["/p"],
    });
    const groups = groupByDay(rows, (d) => (typeof d === "number" ? "date" : d), now);
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([["today", 2], ["yesterday", 1], ["date", 1]]);
  });
});

describe("inProject", () => {
  it("never treats a root as a project", () => {
    expect(inProject("/a", null, "/", undefined)).toBe(false);
    expect(inProject("C:\\a", null, "C:\\", undefined)).toBe(false);
  });
});
