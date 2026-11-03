import { describe, expect, it } from "vitest";
import { createCleanupQueue } from "./cleanupQueue";
import { CLEANUP_MODEL_MAX, CLEANUP_MODEL_PRESETS, isValidCleanupModel, sanitizeCleanupModel } from "./dictationModels";

const defer = () => {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("cleanup model validation", () => {
  it("accepts the backend character set", () => {
    for (const m of ["haiku", "claude-3.5:x/y", "gpt_5[1m]", "a"]) expect(isValidCleanupModel(m)).toBe(true);
  });
  it("rejects empty, odd characters and over-long names", () => {
    for (const m of ["", "a b", "x;y", "né", "a".repeat(CLEANUP_MODEL_MAX + 1)]) expect(isValidCleanupModel(m)).toBe(false);
    expect(isValidCleanupModel("a".repeat(CLEANUP_MODEL_MAX))).toBe(true);
  });
  it("sanitizes to the default (empty) when invalid", () => {
    expect(sanitizeCleanupModel("  opus ")).toBe("opus");
    expect(sanitizeCleanupModel("bad name")).toBe("");
    expect(sanitizeCleanupModel(null)).toBe("");
  });
  it("has aliases for claude and none for codex", () => {
    expect(CLEANUP_MODEL_PRESETS.claude).toEqual(["haiku", "sonnet", "opus"]);
    expect(CLEANUP_MODEL_PRESETS.codex).toEqual([]);
  });
});

describe("createCleanupQueue", () => {
  it("delivers in order even when a later phrase finishes first", async () => {
    const jobs = new Map<string, ReturnType<typeof defer>>([["a", defer()], ["b", defer()]]);
    const out: string[] = [];
    const q = createCleanupQueue((t) => jobs.get(t)!.promise, (t) => out.push(t));
    q.push("a");
    q.push("b");
    jobs.get("b")!.resolve("B!");
    await tick();
    expect(out).toEqual([]);
    jobs.get("a")!.resolve("A!");
    await tick();
    expect(out).toEqual(["A!", "B!"]);
    expect(q.size()).toBe(0);
  });

  it("falls back to the raw text on error or empty answer", async () => {
    const out: string[] = [];
    const q = createCleanupQueue((t) => (t === "x" ? Promise.reject(new Error("no")) : Promise.resolve("  ")), (t) => out.push(t));
    q.push("x");
    q.push("y");
    await tick();
    expect(out).toEqual(["x", "y"]);
  });

  it("whenIdle waits for the queue, then fires once", async () => {
    const d = defer();
    const out: string[] = [];
    const q = createCleanupQueue(() => d.promise, (t) => out.push(t));
    let idle = 0;
    q.whenIdle(() => idle++);
    expect(idle).toBe(1);
    q.push("a");
    q.whenIdle(() => idle++);
    expect(idle).toBe(1);
    d.resolve("A");
    await tick();
    expect(out).toEqual(["A"]);
    expect(idle).toBe(2);
  });

  it("discard drops older in-flight results and waiters", async () => {
    const d = defer();
    const out: string[] = [];
    const q = createCleanupQueue(() => d.promise, (t) => out.push(t));
    let idle = 0;
    q.push("a");
    q.push("b");
    q.whenIdle(() => idle++);
    q.discard();
    d.resolve("A");
    await tick();
    expect(out).toEqual([]);
    expect(idle).toBe(0);
    expect(q.size()).toBe(0);
    q.push("c");
    await tick();
    expect(out).toEqual(["A"]); // a phrase pushed after the discard is delivered
  });

  it("cancelWaiters keeps deliveries", async () => {
    const out: string[] = [];
    const q = createCleanupQueue((t) => Promise.resolve(t.toUpperCase()), (t) => out.push(t));
    let idle = 0;
    q.push("a");
    q.whenIdle(() => idle++);
    q.cancelWaiters();
    await tick();
    expect(out).toEqual(["A"]);
    expect(idle).toBe(0);
  });
});
