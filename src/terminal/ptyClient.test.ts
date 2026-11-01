import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

let client: typeof import("./ptyClient");

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  client = await import("./ptyClient");
});

afterEach(() => {
  for (const id of ["a", "b"]) client.forgetPty(id);
  vi.clearAllTimers();
  vi.useRealTimers();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const inputCalls = () => invoke.mock.calls.filter(([command]) => command === "pty_write").map(([, input]) => input as { id: string; data: string });

describe("PTY input queue", () => {
  it("preserves paste and call order with UTF-8 chunks no larger than 16 KiB", async () => {
    const first = deferred();
    invoke.mockImplementationOnce(() => first.promise);
    const text = `${"a".repeat(16 * 1024 - 1)}😀${"é中".repeat(5000)}`;
    const paste = client.writePty("a", text);
    const enter = client.writePty("a", "tail\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(inputCalls()).toHaveLength(1);
    expect(client.lastSubmitAt("a")).toBe(0);

    first.resolve();
    await Promise.all([paste, enter]);
    const chunks = inputCalls().map((input) => input.data);
    expect(chunks.join("")).toBe(`${text}tail\r`);
    expect(chunks[chunks.length - 1]).toBe("tail\r");
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(16 * 1024);
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
    expect(client.lastSubmitAt("a")).toBe(1000);
  });

  it("counts UTF-8 bytes and keeps surrogate pairs intact at a small boundary", () => {
    const data = "a😀é中z\ud800";
    expect(client.ptyInputBytes(data)).toBe(new TextEncoder().encode(data).length);
    const chunks = [...client.ptyInputChunks(data, 4)];
    expect(chunks.join("")).toBe(data);
    expect(chunks).toContain("😀");
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 4)).toBe(true);
  });

  it("retries only a busy refusal and records Enter after acceptance", async () => {
    invoke.mockRejectedValueOnce("pty busy");
    const errors = vi.fn();
    client.onPtyWriteError("a", errors);
    const write = client.writePty("a", "hello\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(inputCalls()).toHaveLength(1);
    expect(client.lastSubmitAt("a")).toBe(0);
    await vi.advanceTimersByTimeAsync(50);
    await write;
    expect(inputCalls().map((input) => input.data)).toEqual(["hello\r", "hello\r"]);
    expect(client.lastSubmitAt("a")).toBe(1050);
    expect(errors).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops retrying a persistently busy PTY within the retry deadline", async () => {
    invoke.mockRejectedValue("pty busy");
    const errors = vi.fn();
    client.onPtyWriteError("a", errors);
    const write = client.writePty("a", "hello\r");
    await vi.advanceTimersByTimeAsync(11_000);
    await write;
    expect(inputCalls().length).toBeGreaterThan(1);
    expect(errors).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith({ kind: "busy", message: "pty busy", unsentBytes: 6 });
    expect(client.lastSubmitAt("a")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replay an ambiguous permanent failure and reports all unsent bytes", async () => {
    invoke.mockResolvedValueOnce(undefined).mockRejectedValueOnce("pipe broke");
    const errors = vi.fn();
    client.onPtyWriteError("a", errors);
    const first = client.writePty("a", `${"a".repeat(16 * 1024)}😀tail\r`);
    const queued = client.writePty("a", "later");
    await Promise.all([first, queued]);
    expect(inputCalls()).toHaveLength(2);
    expect(errors).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledWith({ kind: "failed", message: "pipe broke", unsentBytes: 14 });
    expect(client.lastSubmitAt("a")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forget cancels a busy wait and queued input without affecting a replacement queue", async () => {
    invoke.mockRejectedValueOnce("pty busy");
    const errors = vi.fn();
    client.onPtyWriteError("a", errors);
    const first = client.writePty("a", "first\r");
    const queued = client.writePty("a", "never sent\r");
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
    client.forgetPty("a");
    const fresh = client.writePty("a", "new\r");
    await Promise.all([first, queued, fresh]);
    expect(inputCalls().map((input) => input.data)).toEqual(["first\r", "new\r"]);
    expect(errors).not.toHaveBeenCalled();
    expect(client.lastSubmitAt("a")).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forget also releases an unresolved IPC write without reviving its submit time", async () => {
    const stuck = deferred();
    invoke.mockImplementationOnce(() => stuck.promise);
    const first = client.writePty("a", "first\r");
    const queued = client.writePty("a", "never sent\r");
    await vi.advanceTimersByTimeAsync(0);
    client.forgetPty("a");
    await Promise.all([first, queued]);
    stuck.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(inputCalls()).toHaveLength(1);
    expect(client.lastSubmitAt("a")).toBe(0);
  });

  it("a blocked PTY does not delay another session", async () => {
    const stuck = deferred();
    invoke.mockImplementationOnce(() => stuck.promise);
    const first = client.writePty("a", "one");
    const queued = client.writePty("a", "two");
    const other = client.writePty("b", "independent\r");
    await other;
    expect(inputCalls()).toEqual([{ id: "a", data: "one" }, { id: "b", data: "independent\r" }]);
    expect(client.lastSubmitAt("a")).toBe(0);
    expect(client.lastSubmitAt("b")).toBe(1000);
    stuck.resolve();
    await Promise.all([first, queued]);
    const calls = inputCalls();
    expect(calls[calls.length - 1]).toEqual({ id: "a", data: "two" });
  });

  it("refuses an oversized paste and aggregate UTF-8 queue overflow before sending them", async () => {
    const errors = vi.fn();
    client.onPtyWriteError("a", errors);
    const tooLarge = "x".repeat(client.MAX_PTY_QUEUED_BYTES + 1);
    await client.writePty("a", tooLarge);
    expect(inputCalls()).toHaveLength(0);
    expect(errors).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "overflow", unsentBytes: client.MAX_PTY_QUEUED_BYTES + 1 }));

    const stuck = deferred();
    invoke.mockImplementationOnce(() => stuck.promise);
    const pending = client.writePty("a", "x".repeat(client.MAX_PTY_QUEUED_BYTES - 1));
    await vi.advanceTimersByTimeAsync(0);
    await client.writePty("a", "é");
    expect(inputCalls()).toHaveLength(1);
    expect(errors).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "overflow", unsentBytes: 2 }));
    client.forgetPty("a");
    await pending;
    stuck.resolve();
  });
});
