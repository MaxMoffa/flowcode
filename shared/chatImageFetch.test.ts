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
});
