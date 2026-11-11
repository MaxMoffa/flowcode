import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg, ServerMsg } from "../../shared/remote-types";

const mock = vi.hoisted(() => ({
  listeners: new Set<(m: ServerMsg) => void>(),
  send: vi.fn<(m: ClientMsg) => void>(),
  sendChecked: vi.fn<(m: ClientMsg) => Promise<boolean>>(),
}));
vi.mock("./remote", () => ({
  send: mock.send,
  sendChecked: mock.sendChecked,
  onMessage: (listener: (m: ServerMsg) => void) => { mock.listeners.add(listener); return () => mock.listeners.delete(listener); },
}));
import { gitRequest, historyRequest, resumeSession } from "./gitRemote";

const reply = (message: ServerMsg) => mock.listeners.forEach((listener) => listener(message));
const id = (at: number) => (mock.sendChecked.mock.calls[at][0] as Extract<ClientMsg, { t: "git" | "history" }>).requestId;
beforeEach(() => { vi.useFakeTimers(); mock.send.mockReset(); mock.sendChecked.mockReset().mockResolvedValue(true); });
afterEach(() => { expect(mock.listeners.size).toBe(0); vi.useRealTimers(); });

describe("git, history and resume requests", () => {
  it("matches git replies by request id, even out of order", async () => {
    const a = gitRequest<string>({ op: "toplevel", path: "/a" });
    const b = gitRequest<null>({ op: "stage", root: "/a", paths: ["x"] });
    reply({ t: "git", requestId: id(1), result: undefined });
    reply({ t: "git", requestId: id(0), result: "/a" });
    expect(await a).toBe("/a");
    expect(await b).toBeNull();
  });
  it("rejects with the desktop's error and on timeout", async () => {
    const failed = gitRequest({ op: "commit", root: "/a", message: "m" });
    const rejected = expect(failed).rejects.toThrow("nothing to commit");
    reply({ t: "git", requestId: id(0), error: "nothing to commit" }); await rejected;
    const timedOut = historyRequest("/a");
    const timeout = expect(timedOut).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(30_000); await timeout;
  });
  it("resolves history and ignores replies of the other kind", async () => {
    const pending = historyRequest("/a");
    reply({ t: "git", requestId: id(0), result: 1 });
    const result = { roots: ["/a"], claude: [], codex: [], vibe: [], opencode: [] };
    reply({ t: "history", requestId: id(0), result });
    expect(await pending).toEqual(result);
  });
  it("rejects when the link refuses the send", async () => {
    mock.sendChecked.mockResolvedValueOnce(false);
    await expect(gitRequest({ op: "status", root: "/a" })).rejects.toBeInstanceOf(Error);
  });
  it("sends resume fire-and-forget", () => {
    resumeSession({ cwd: "/a", sessionId: "s", cli: "claude" });
    expect(mock.send).toHaveBeenCalledWith({ t: "resume", cwd: "/a", sessionId: "s", cli: "claude" });
  });
});
