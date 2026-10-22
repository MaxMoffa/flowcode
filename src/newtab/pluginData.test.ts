import { describe, expect, it } from "vitest";
import { buildNewTabData, resolveNewTabLaunch, type NewTabLists } from "./pluginData";

const lists: NewTabLists = {
  recents: [
    { cwd: "/work/api", name: "api", command: "npm test", at: 1 },
    { cwd: "/work/api", name: "api", shell: "wsl", command: "make", at: 2 },
  ],
  favorites: [{ path: "/work/web", name: "web", shell: "pwsh" }],
  shells: [
    { id: "system", label: "PowerShell" },
    { id: "cmd", label: "Prompt dei comandi" },
  ],
  agents: [{ id: "claude", label: "Claude Code" }],
};

describe("buildNewTabData", () => {
  it("lists every entry under an id of its own", () => {
    const data = buildNewTabData(lists);
    expect(new Set(data.recents.map((r) => r.id)).size).toBe(2);
    expect(data.recents[1]).toEqual({ id: "wsl|/work/api", label: "api", path: "/work/api", shell: "wsl" });
    expect(data.favorites).toEqual([{ id: "/work/web", label: "web", path: "/work/web" }]);
    expect(data.profile).toBeUndefined();
  });
  it("carries the profile only when there is one", () => {
    expect(buildNewTabData({ ...lists, profile: { id: "work", label: "Work" } }).profile).toEqual({ id: "work", label: "Work" });
  });
});

describe("resolveNewTabLaunch", () => {
  it("turns an id into the launch the layouts would make", () => {
    expect(resolveNewTabLaunch(lists, "recent", "wsl|/work/api", "system")).toEqual({
      launch: { shell: "wsl", cwd: "/work/api", command: "make", typeOnly: true },
    });
    expect(resolveNewTabLaunch(lists, "favorite", "/work/web", "system")).toEqual({ launch: { shell: "pwsh", cwd: "/work/web" } });
    expect(resolveNewTabLaunch(lists, "shell", "cmd", "system")).toEqual({ launch: { shell: "cmd" } });
    expect(resolveNewTabLaunch(lists, "agent", "claude", "system")).toEqual({ agent: "claude" });
  });
  it("leaves out the shell when it is the configured default", () => {
    expect(resolveNewTabLaunch(lists, "shell", "system", "system")).toEqual({ launch: { shell: undefined } });
  });
  it("refuses an id the host did not list, whatever it looks like", () => {
    expect(resolveNewTabLaunch(lists, "favorite", "/etc", "system")).toBeNull();
    expect(resolveNewTabLaunch(lists, "recent", "pwsh|/work/api", "system")).toBeNull();
    expect(resolveNewTabLaunch(lists, "shell", "powershell -c calc", "system")).toBeNull();
    expect(resolveNewTabLaunch(lists, "agent", "codex", "system")).toBeNull();
    expect(resolveNewTabLaunch(lists, "agent", "claude", "system")).not.toBeNull();
  });
});
