import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatImageFetcher } from "./chatImageFetch";

const b64 = (s: string) => btoa(s);
const text = (b: Blob | null) => b?.text();

describe("chat image fetcher", () => {
  afterEach(() => vi.useRealTimers());

  it("assembles chunks into a blob", async () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send);
    const p = f.fetch({ chatId: "c", id: "abc" });
    expect(send).toHaveBeenCalledWith({ t: "chatimage", chatId: "c", id: "abc" });
    f.handle({ t: "chatimage", key: "abc", offset: 3, total: 6, data: b64("def"), mime: "image/png" });
    f.handle({ t: "chatimage", key: "abc", offset: 0, total: 6, data: b64("abc"), mime: "image/png" });
    const blob = await p;
    expect(blob?.type).toBe("image/png");
    expect(await text(blob)).toBe("abcdef");
    // cached: no second request
    expect(await f.fetch({ id: "abc" })).toBe(blob);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("resolves null for a missing image and retries later", async () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send);
    const p = f.fetch({ path: "/x/a.png" });
    expect(send).toHaveBeenCalledWith({ t: "chatimage", path: "/x/a.png" });
    f.handle({ t: "chatimage", key: "/x/a.png", offset: 0, total: 0, data: "", missing: true });
    expect(await p).toBeNull();
    void f.fetch({ path: "/x/a.png" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent fetches of one key", () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send);
    expect(f.fetch({ id: "a" })).toBe(f.fetch({ id: "a" }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.fetch({})).resolves.toBeNull();
  });

  it("times out", async () => {
    vi.useFakeTimers();
    const f = createChatImageFetcher(vi.fn(), 1000);
    const p = f.fetch({ id: "a" });
    vi.advanceTimersByTime(1001);
    expect(await p).toBeNull();
  });

  it("ignores unrelated messages and bad chunks", async () => {
    const f = createChatImageFetcher(vi.fn());
    const p = f.fetch({ id: "a" });
    f.handle({ t: "pong" });
    f.handle({ t: "chatimage", key: "other", offset: 0, total: 1, data: b64("x") });
    f.handle(null);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    f.handle({ t: "chatimage", key: "a", offset: 5, total: 3, data: b64("xy") });
    expect(await p).toBeNull();
  });

  it("fetches a web url, keyed by the url", async () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send);
    const p = f.fetch({ chatId: "c", url: "https://x.io/a.png" });
    expect(send).toHaveBeenCalledWith({ t: "chatimage", chatId: "c", url: "https://x.io/a.png" });
    f.handle({ t: "chatimage", key: "https://x.io/a.png", offset: 0, total: 2, data: b64("hi"), mime: "image/png" });
    expect(await text(await p)).toBe("hi");
  });

  it("returns an empty blob for an empty file", async () => {
    const f = createChatImageFetcher(vi.fn());
    const p = f.fetch({ id: "e" });
    f.handle({ t: "chatimage", key: "e", offset: 0, total: 0, data: "", mime: "image/gif" });
    expect((await p)?.size).toBe(0);
  });

  it("keeps relative paths separate across chats on legacy peers", async () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send);
    const first = f.fetch({ chatId: "a", path: "preview.png" });
    // An old response names only its path: do not start a conflicting load.
    expect(await f.fetch({ chatId: "b", path: "preview.png" })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    f.handle({ t: "chatimage", key: "preview.png", offset: 0, total: 1, data: b64("A") });
    expect(await text(await first)).toBe("A");
    const second = f.fetch({ chatId: "b", path: "preview.png" });
    expect(send).toHaveBeenCalledTimes(2);
    f.handle({ t: "chatimage", key: "preview.png", offset: 0, total: 1, data: b64("B") });
    expect(await text(await second)).toBe("B");
    expect(await text(await f.fetch({ chatId: "a", path: "preview.png" }))).toBe("A");
    f.dispose();
  });

  it("correlates concurrent paths by request id when supported", async () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send, 1000, { supportsRequestIds: () => true });
    const first = f.fetch({ chatId: "a", path: "preview.png" });
    const second = f.fetch({ chatId: "b", path: "preview.png" });
    const a = send.mock.calls[0][0].requestId;
    const b = send.mock.calls[1][0].requestId;
    expect(a).toEqual(expect.any(String));
    expect(b).not.toBe(a);
    f.handle({ t: "chatimage", key: b, offset: 0, total: 1, data: b64("B") });
    f.handle({ t: "chatimage", key: a, offset: 0, total: 1, data: b64("A") });
    expect(await text(await first)).toBe("A");
    expect(await text(await second)).toBe("B");
    f.dispose();
  });

  it("clears pending requests and caches at a transport reset", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const f = createChatImageFetcher(send, 1000, { supportsRequestIds: () => true });
    const old = f.fetch({ id: "a" });
    const oldKey = send.mock.calls[0][0].requestId;
    f.reset();
    expect(await old).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const fresh = f.fetch({ id: "a" });
    const freshKey = send.mock.calls[1][0].requestId;
    expect(freshKey).not.toBe(oldKey);
    f.handle({ t: "chatimage", key: oldKey, offset: 0, total: 1, data: b64("A") });
    f.handle({ t: "chatimage", key: freshKey, offset: 0, total: 1, data: b64("B") });
    expect(await text(await fresh)).toBe("B");
    f.reset();
    const again = f.fetch({ id: "a" });
    expect(send).toHaveBeenCalledTimes(3);
    f.dispose();
    expect(await again).toBeNull();
    expect(await f.fetch({ id: "b" })).toBeNull();
    expect(send).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("evicts completed blobs by byte budget and recency", async () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send, 1000, { maxCacheBytes: 4 });
    const load = async (id: string) => {
      const pending = f.fetch({ id });
      f.handle({ t: "chatimage", key: id, offset: 0, total: 2, data: b64(id.repeat(2)) });
      return pending;
    };
    const a = await load("a");
    await load("b");
    expect(await f.fetch({ id: "a" })).toBe(a);
    await load("c");
    // Reading A made B the oldest entry; C takes B's two-byte budget.
    expect(await f.fetch({ id: "a" })).toBe(a);
    expect(send).toHaveBeenCalledTimes(3);
    const b = f.fetch({ id: "b" });
    expect(send).toHaveBeenCalledTimes(4);
    f.dispose();
    expect(await b).toBeNull();
  });

  it("returns oversized blobs without retaining them in the cache", async () => {
    const send = vi.fn();
    const f = createChatImageFetcher(send, 1000, { maxCacheBytes: 1 });
    const p = f.fetch({ id: "a" });
    f.handle({ t: "chatimage", key: "a", offset: 0, total: 2, data: b64("AA") });
    expect(await text(await p)).toBe("AA");
    void f.fetch({ id: "a" });
    expect(send).toHaveBeenCalledTimes(2);
    f.dispose();
  });

  it("rejects overlapping chunks instead of counting duplicated bytes", async () => {
    const f = createChatImageFetcher(vi.fn());
    const p = f.fetch({ id: "a" });
    f.handle({ t: "chatimage", key: "a", offset: 0, total: 4, data: b64("AB") });
    f.handle({ t: "chatimage", key: "a", offset: 1, total: 4, data: b64("BC") });
    expect(await p).toBeNull();
    f.dispose();
  });

  it("rejects inconsistent chunk totals", async () => {
    const f = createChatImageFetcher(vi.fn());
    const p = f.fetch({ id: "a" });
    f.handle({ t: "chatimage", key: "a", offset: 0, total: 4, data: b64("AB") });
    f.handle({ t: "chatimage", key: "a", offset: 2, total: 3, data: b64("C") });
    expect(await p).toBeNull();
    f.dispose();
  });

  it("quarantines timed-out legacy keys until the old transport is gone", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const f = createChatImageFetcher(send, 1000);
    const p = f.fetch({ chatId: "a", path: "preview.png" });
    vi.advanceTimersByTime(1001);
    expect(await p).toBeNull();
    expect(await f.fetch({ chatId: "b", path: "preview.png" })).toBeNull();
    expect(send).toHaveBeenCalledTimes(1);
    f.handle({ t: "chatimage", key: "preview.png", offset: 0, total: 1, data: b64("A") });
    f.reset();
    const next = f.fetch({ chatId: "b", path: "preview.png" });
    f.handle({ t: "chatimage", key: "preview.png", offset: 0, total: 1, data: b64("B") });
    expect(await text(await next)).toBe("B");
    expect(send).toHaveBeenCalledTimes(2);
    f.dispose();
  });

  it("allows retries when sending never reached the transport", async () => {
    const send = vi.fn().mockResolvedValueOnce(false).mockRejectedValueOnce(new Error("offline")).mockReturnValue(true);
    const f = createChatImageFetcher(send);
    expect(await f.fetch({ id: "a" })).toBeNull();
    expect(await f.fetch({ id: "a" })).toBeNull();
    const p = f.fetch({ id: "a" });
    expect(send).toHaveBeenCalledTimes(3);
    f.handle({ t: "chatimage", key: "a", offset: 0, total: 1, data: b64("A") });
    expect(await text(await p)).toBe("A");
    f.dispose();
  });

  it("caps the number of pending image requests", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const f = createChatImageFetcher(send);
    const pending = Array.from({ length: 32 }, (_, i) => f.fetch({ id: String(i) }));
    expect(await f.fetch({ id: "overflow" })).toBeNull();
    expect(send).toHaveBeenCalledTimes(32);
    f.dispose();
    expect((await Promise.all(pending)).every((b) => b === null)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
