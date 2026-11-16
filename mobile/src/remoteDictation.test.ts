import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ invoke: vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
vi.mock("./remote", () => ({ onMessage: () => () => {} }));
vi.mock("./dictationEngine", () => ({ remoteErrorToSpeechCode: (c?: string) => c ?? "unknown" }));
import { startRemoteDictation } from "./remoteDictation";

const handlers = { onPartial: () => {}, onFinal: () => {}, onEnd: () => {} };
const calls = (cmd: string) => mock.invoke.mock.calls.filter((c) => c[0] === cmd);
const flush = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => (resolve = res));
  return { promise, resolve };
};

beforeEach(() => mock.invoke.mockReset().mockResolvedValue(undefined));

describe("remote dictation cancel during startup", () => {
  it("never starts the microphone when cancelled before dictstart resolves", async () => {
    const sendGate = deferred();
    mock.invoke.mockImplementation((cmd) => (cmd === "send" ? sendGate.promise : Promise.resolve(undefined)));
    const s = startRemoteDictation("it", handlers);
    s.cancel();
    sendGate.resolve();
    await flush();
    expect(calls("dict_audio_start")).toHaveLength(0);
    expect(calls("dict_audio_cancel").length).toBeGreaterThan(0);
  });

  it("cancels the capture that began after a cancel during dict_audio_start", async () => {
    const startGate = deferred();
    mock.invoke.mockImplementation((cmd) => (cmd === "dict_audio_start" ? startGate.promise : Promise.resolve(undefined)));
    const s = startRemoteDictation(undefined, handlers);
    await flush();
    expect(calls("dict_audio_start")).toHaveLength(1);
    const session = (calls("dict_audio_start")[0][1] as { session: string }).session;
    s.cancel();
    const before = calls("dict_audio_cancel").length;
    startGate.resolve();
    await flush();
    const after = calls("dict_audio_cancel");
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1][1]).toEqual({ session });
  });
});
