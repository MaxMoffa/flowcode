import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let cli: typeof import("./cliInfo");
beforeEach(async () => { vi.resetModules(); invoke.mockReset(); cli = await import("./cliInfo"); });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("CLI status after authentication", () => {
  it("discards an older signed-out probe without deleting its replacement", async () => {
    const old = deferred<{ installed: boolean; logged_in: boolean }>();
    const fresh = deferred<{ installed: boolean; logged_in: boolean }>();
    invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const first = cli.defaultCliStatus("claude");
    cli.invalidateCliStatus("claude");
    const second = cli.defaultCliStatus("claude");
    old.resolve({ installed: true, logged_in: false });
    expect(await first).toBeNull();
    const concurrent = cli.defaultCliStatus("claude");
    expect(invoke).toHaveBeenCalledTimes(2);
    fresh.resolve({ installed: true, logged_in: true });
    expect(await second).toEqual({ installed: true, logged_in: true });
    expect(await concurrent).toEqual({ installed: true, logged_in: true });
    expect(await cli.defaultCliStatus("claude")).toEqual({ installed: true, logged_in: true });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("invalidates one provider without dropping another provider's cached status", async () => {
    invoke.mockResolvedValue({ installed: true, logged_in: true });
    await cli.defaultCliStatus("codex");
    await cli.defaultCliStatus("gemini");
    cli.invalidateCliStatus("codex");
    await cli.defaultCliStatus("gemini");
    expect(invoke).toHaveBeenCalledTimes(2);
    await cli.defaultCliStatus("codex");
    expect(invoke).toHaveBeenCalledTimes(3);
  });
});
