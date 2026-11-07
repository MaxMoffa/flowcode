import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg, ServerMsg } from "../../shared/remote-types";

// The remote module is replaced by a scripted link: what the phone sends is recorded, replies are pushed in by hand.
const link = vi.hoisted(() => ({
  supported: true,
  sent: [] as unknown[],
  listeners: new Set<(m: ServerMsg) => void>(),
}));

vi.mock("./remote", () => ({
  hostSupports: () => link.supported,
  onMessage: (l: (m: ServerMsg) => void) => {
    link.listeners.add(l);
    return () => void link.listeners.delete(l);
  },
  send: (m: ClientMsg) => void link.sent.push(m),
}));

const say = (m: ServerMsg) => [...link.listeners].forEach((l) => l(m));

describe("loadChatCacheInfo", () => {
  beforeEach(() => {
    link.supported = true;
    link.sent = [];
    link.listeners.clear();
    vi.useRealTimers();
  });

  it("resolves on the reply for its chat and ignores other chats", async () => {
    const { loadChatCacheInfo } = await import("./chatCacheInfo");
    const p = loadChatCacheInfo("c1");
    say({ t: "chatcacheinfo", chatId: "c2", ttlMs: 1, lastCallAt: "x" });
    say({ t: "chatcacheinfo", chatId: "c1", ttlMs: 3_600_000, lastCallAt: "t1" });
    await expect(p).resolves.toEqual({ ttlMs: 3_600_000, lastCallAt: "t1" });
    expect(link.sent).toEqual([{ t: "chatcacheinfo", chatId: "c1" }]);
    expect(link.listeners.size).toBe(0);
  });

  it("shares one request between concurrent callers", async () => {
    const { loadChatCacheInfo } = await import("./chatCacheInfo");
    const a = loadChatCacheInfo("c1");
    const b = loadChatCacheInfo("c1");
    say({ t: "chatcacheinfo", chatId: "c1", ttlMs: 300_000 });
    await expect(a).resolves.toEqual({ ttlMs: 300_000, lastCallAt: null });
    await expect(b).resolves.toEqual({ ttlMs: 300_000, lastCallAt: null });
    expect(link.sent).toHaveLength(1);
  });

  it("rejects when the desktop is too old, has no value, or stays silent", async () => {
    const { loadChatCacheInfo } = await import("./chatCacheInfo");
    link.supported = false;
    await expect(loadChatCacheInfo("c1")).rejects.toThrow();
    link.supported = true;
    const empty = loadChatCacheInfo("c1");
    say({ t: "chatcacheinfo", chatId: "c1" });
    await expect(empty).rejects.toThrow();
    vi.useFakeTimers();
    const silent = loadChatCacheInfo("c1");
    const assertion = expect(silent).rejects.toThrow("timeout");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});
