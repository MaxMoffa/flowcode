import { describe, expect, it, vi } from "vitest";

const leaves = new Set<() => void>();
vi.mock("./remoteHosts", () => ({
  onHostMessages: () => () => {},
  sendToHost: () => Promise.resolve(true),
  onHostLeavesOnline: (_id: string, fn: () => void) => {
    leaves.add(fn);
    return () => void leaves.delete(fn);
  },
}));

import { hostRequest } from "./hostRequest";

describe("hostRequest", () => {
  it("rejects at once when the host leaves online, without waiting for the timeout", async () => {
    const pending = hostRequest("h", "fs", (requestId) => ({ t: "fs", requestId, request: { op: "roots" } }), 60_000);
    await Promise.resolve();
    leaves.forEach((fn) => fn());
    await expect(pending).rejects.toThrow("offline");
    expect(leaves.size).toBe(0);
  });
});
