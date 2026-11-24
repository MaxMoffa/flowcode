import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg } from "../../shared/remote-types";

const sent: ClientMsg[] = [];
let reply: { result?: unknown; error?: string } = {};

vi.mock("./hostRequest", () => ({
  hostRequest: (_host: string, _kind: string, build: (id: string) => ClientMsg) => {
    sent.push(build("r1"));
    return reply.error ? Promise.reject(new Error(reply.error)) : Promise.resolve({ t: "git", requestId: "r1", result: reply.result });
  },
}));
vi.mock("./remoteFiles", () => ({ readRemoteFile: () => Promise.reject(new Error("gone")) }));

import { remoteGitBackend } from "./remoteGit";

describe("git of another PC", () => {
  beforeEach(() => {
    sent.length = 0;
    reply = {};
  });

  it("asks the host the phone's questions and unwraps the answer", async () => {
    const git = remoteGitBackend("h");
    reply = { result: "/repo" };
    expect(await git.toplevel("/repo/src")).toBe("/repo");
    reply = { result: "abc123" };
    expect(await git.commit("/repo", "msg")).toBe("abc123");
    await git.switchBranch("/repo", "origin/x", true);
    await git.discard("/repo", ["a"], true);
    expect(sent.map((m) => (m.t === "git" ? m.request : null))).toEqual([
      { op: "toplevel", path: "/repo/src" },
      { op: "commit", root: "/repo", message: "msg" },
      { op: "switch", root: "/repo", name: "origin/x", createFromRemote: true },
      { op: "discard", root: "/repo", paths: ["a"], untracked: true },
    ]);
  });

  it("reads a file that is not there as empty, and lets errors through", async () => {
    const git = remoteGitBackend("h");
    reply = { result: null };
    expect(await git.showFile("/repo", "a.ts", "HEAD")).toBe("");
    expect(await git.readText("/repo/a.ts")).toBe("");
    reply = { error: "nothing to commit" };
    await expect(git.commit("/repo", "x")).rejects.toThrow("nothing to commit");
  });
});
