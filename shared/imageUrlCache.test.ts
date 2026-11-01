import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createImageUrlCache } from "./imageUrlCache";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("image URL cache", () => {
  let nextUrl = 0;
  const create = vi.fn((_blob: Blob | MediaSource) => `blob:image-${++nextUrl}`);
  const revoke = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    nextUrl = 0;
    create.mockClear();
    revoke.mockClear();
    vi.spyOn(URL, "createObjectURL").mockImplementation(create);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revoke);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shares pending and completed loads and records their byte size", async () => {
    const cache = createImageUrlCache();
    const blob = deferred<Blob | null>();
    const make = vi.fn(() => blob.promise);
    const a = cache.load("a", make);
    expect(cache.load("a", make)).toBe(a);
    expect(make).toHaveBeenCalledTimes(1);
    blob.resolve(new Blob(["ABC"]));
    const src = await a;
    expect(src).toBe("blob:image-1");
    expect(cache.bytes(src!)).toBe(3);
    expect(cache.load("a", make)).toBe(a);
    expect(create).toHaveBeenCalledTimes(1);
    cache.dispose();
    expect(cache.bytes(src!)).toBeUndefined();
    expect(revoke).toHaveBeenCalledWith(src);
  });

  it("retries failed loads while preserving a preexisting lease", async () => {
    const cache = createImageUrlCache();
    const release = cache.retain("a");
    expect(await cache.load("a", async () => null)).toBeNull();
    expect(await cache.load("a", async () => { throw new Error("offline"); })).toBeNull();
    const src = await cache.load("a", async () => new Blob(["A"]));
    expect(src).toBe("blob:image-1");
    cache.clear();
    expect(revoke).not.toHaveBeenCalled();
    release();
    expect(revoke).toHaveBeenCalledWith(src);
    cache.dispose();
  });

  it("evicts unleased images by byte budget and least recent use", async () => {
    const cache = createImageUrlCache(4);
    const a = await cache.load("a", async () => new Blob(["AA"]));
    const b = await cache.load("b", async () => new Blob(["BB"]));
    await cache.load("a", async () => { throw new Error("cached"); });
    const c = await cache.load("c", async () => new Blob(["CC"]));
    vi.runAllTimers();
    expect(revoke.mock.calls).toEqual([[b]]);
    expect(cache.bytes(a!)).toBe(2);
    expect(cache.bytes(c!)).toBe(2);
    cache.dispose();
  });

  it("protects visible images even when active bytes exceed the budget", async () => {
    const cache = createImageUrlCache(1);
    const releaseA = cache.retain("a");
    const releaseB = cache.retain("b");
    const a = await cache.load("a", async () => new Blob(["AA"]));
    const b = await cache.load("b", async () => new Blob(["BB"]));
    vi.runAllTimers();
    expect(revoke).not.toHaveBeenCalled();
    releaseA();
    expect(revoke.mock.calls).toEqual([[a]]);
    expect(cache.bytes(b!)).toBe(2);
    releaseB();
    expect(revoke.mock.calls).toEqual([[a], [b]]);
    releaseB();
    expect(revoke).toHaveBeenCalledTimes(2);
    cache.dispose();
  });

  it("gives an unleased load time to acquire a lease before eviction", async () => {
    const cache = createImageUrlCache(0);
    const src = await cache.load("a", async () => new Blob(["A"]));
    expect(revoke).not.toHaveBeenCalled();
    const release = cache.retain("a");
    vi.runAllTimers();
    expect(revoke).not.toHaveBeenCalled();
    release();
    expect(revoke).toHaveBeenCalledWith(src);
    cache.dispose();
  });

  it("releases a pending lease and trims the URL when the load settles", async () => {
    const cache = createImageUrlCache(0);
    const blob = deferred<Blob | null>();
    const release = cache.retain("a");
    const pending = cache.load("a", () => blob.promise);
    release();
    blob.resolve(new Blob(["A"]));
    const src = await pending;
    expect(revoke).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revoke).toHaveBeenCalledWith(src);
    cache.dispose();
  });

  it("clear cancels inactive pending loads and ignores their late result", async () => {
    const cache = createImageUrlCache();
    const old = deferred<Blob | null>();
    const pending = cache.load("a", () => old.promise);
    cache.clear();
    expect(await pending).toBeNull();
    const src = await cache.load("a", async () => new Blob(["new"]));
    old.resolve(new Blob(["old"]));
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await cache.load("a", async () => null)).toBe(src);
    cache.dispose();
  });

  it("clear preserves active pending images until their last release", async () => {
    const cache = createImageUrlCache();
    const blob = deferred<Blob | null>();
    const releaseA = cache.retain("a");
    const releaseB = cache.retain("a");
    const pending = cache.load("a", () => blob.promise);
    cache.clear();
    blob.resolve(new Blob(["A"]));
    const src = await pending;
    vi.runAllTimers();
    expect(revoke).not.toHaveBeenCalled();
    releaseA();
    expect(revoke).not.toHaveBeenCalled();
    releaseB();
    expect(revoke).toHaveBeenCalledWith(src);
    cache.dispose();
  });

  it("dispose invalidates visible and pending images and stops future loads", async () => {
    const cache = createImageUrlCache();
    const release = cache.retain("a");
    const src = await cache.load("a", async () => new Blob(["A"]));
    const late = deferred<Blob | null>();
    const pending = cache.load("b", () => late.promise);
    cache.dispose();
    expect(await pending).toBeNull();
    expect(revoke.mock.calls).toEqual([[src]]);
    const make = vi.fn(async () => new Blob(["C"]));
    expect(await cache.load("c", make)).toBeNull();
    expect(make).not.toHaveBeenCalled();
    late.resolve(new Blob(["B"]));
    await Promise.resolve();
    expect(create).toHaveBeenCalledTimes(1);
    release();
    cache.dispose();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps empty images by entry count", async () => {
    const cache = createImageUrlCache(10, 1);
    const a = await cache.load("a", async () => new Blob([]));
    const b = await cache.load("b", async () => new Blob([]));
    vi.runAllTimers();
    expect(revoke.mock.calls).toEqual([[a]]);
    expect(cache.bytes(b!)).toBe(0);
    cache.dispose();
  });
});
