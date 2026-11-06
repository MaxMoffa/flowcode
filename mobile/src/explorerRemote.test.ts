import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg, ServerMsg } from "../../shared/remote-types";

const mock = vi.hoisted(() => ({ listeners: new Set<(m: ServerMsg) => void>(), send: vi.fn<(m: ClientMsg) => Promise<boolean>>() }));
vi.mock("./remote", () => ({
  sendChecked: mock.send,
  onMessage: (listener: (m: ServerMsg) => void) => { mock.listeners.add(listener); return () => mock.listeners.delete(listener); },
  useRemoteSelector: vi.fn(),
}));
import { requestFs } from "./explorerRemote";

const reply = (message: ServerMsg) => mock.listeners.forEach((listener) => listener(message));
const id = (at: number) => (mock.send.mock.calls[at][0] as Extract<ClientMsg, { t: "fs" }>).requestId;
beforeEach(() => { vi.useFakeTimers(); mock.send.mockReset().mockResolvedValue(true); });
afterEach(() => { expect(mock.listeners.size).toBe(0); vi.useRealTimers(); });

describe("filesystem requests", () => {
  it("correlates concurrent replies even when they arrive in reverse order", async () => {
    const first = requestFs({ op: "list", path: "/a" });
    const second = requestFs({ op: "list", path: "/b" });
    reply({ t: "fs", requestId: id(1), response: { kind: "list", path: "/b", parent: "/", entries: [], truncated: false } });
    reply({ t: "fs", requestId: id(0), response: { kind: "list", path: "/a", parent: "/", entries: [], truncated: false } });
    expect(await first).toMatchObject({ path: "/a" }); expect(await second).toMatchObject({ path: "/b" });
  });
  it("drops cancelled listeners so late replies cannot reopen a closed picker", async () => {
    const controller = new AbortController();
    const pending = requestFs({ op: "roots" }, controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(); await rejected;
    reply({ t: "fs", requestId: id(0), response: { kind: "roots", roots: [] } });
  });
  it("reports correlated desktop errors and cleans up timeouts", async () => {
    const failed = requestFs({ op: "read", path: "/binary" });
    const rejected = expect(failed).rejects.toThrow("Binary file");
    reply({ t: "fs", requestId: id(0), error: "Binary file" }); await rejected;
    const timedOut = requestFs({ op: "roots" });
    const timeout = expect(timedOut).rejects.toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(20_000); await timeout;
  });
  it("rejects failed sends and escaped edits exceeding a protocol frame", async () => {
    mock.send.mockResolvedValueOnce(false);
    await expect(requestFs({ op: "roots" })).rejects.toBeInstanceOf(Error);
    await expect(requestFs({ op: "write", path: "/text", text: "\u0001".repeat(200_000), version: "old" })).rejects.toBeInstanceOf(Error);
    expect(mock.send).toHaveBeenCalledTimes(1);
  });
});
