import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowSession } from "./useWindowSession";

const mock = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  save: vi.fn<(snapshot: unknown, flushGen?: number, dirtyEditors?: boolean) => Promise<void>>(),
  listen: vi.fn<(name: string, handler: (event: { payload: number }) => void) => Promise<() => void>>(),
}));

vi.mock("react", () => ({
  useRef: <T,>(value: T) => ({ current: value }),
  useEffect: (effect: () => void | (() => void)) => { mock.effects.push(effect); },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mock.listen }));
vi.mock("./session", () => ({ saveWindowSession: mock.save }));

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
type Options = Parameters<typeof useWindowSession>[0];
type CloseHandler = (event: { preventDefault: () => void }) => Promise<void>;

function mount(patch: Partial<Options> = {}) {
  const handlers: CloseHandler[] = [];
  const offClose = vi.fn();
  const api = {
    onCloseRequested: vi.fn(async (handler: CloseHandler) => { handlers.push(handler); return offClose; }),
    isMinimized: vi.fn(async () => false),
    outerPosition: vi.fn(async () => ({ x: 10, y: 20 })),
    outerSize: vi.fn(async () => ({ width: 800, height: 600 })),
    destroy: vi.fn(async () => {}),
  };
  const options: Options = {
    ready: true,
    window: api as unknown as Options["window"],
    main: true,
    dirty: { current: true },
    restore: () => true,
    state: vi.fn(() => ({
      tabs: [{ kind: "editor" as const, id: "e", path: "/a.txt", label: "a.txt" }],
      activeTabId: "e", restoreContent: true, restoredTabIds: new Set<string>(),
      terminals: new Map(), restoredContent: new Map<string, string>(), shellOf: () => undefined,
    })),
    prepareClose: vi.fn(async () => () => true),
    onError: vi.fn(),
    ...patch,
  };
  useWindowSession(options);
  const setup = mock.effects[mock.effects.length - 1];
  const cleanup = setup() as (() => void) | undefined;
  const event = { preventDefault: vi.fn() };
  return { options, api, setup, cleanup: () => cleanup?.(), offClose, event, close: () => handlers[handlers.length - 1](event) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("document", { hidden: false });
  mock.effects = [];
  mock.save.mockReset().mockResolvedValue(undefined);
  mock.listen.mockReset().mockResolvedValue(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("window session lifecycle", () => {
  it("retries a persistent failure without opening the same error repeatedly", async () => {
    const error = new Error("disk full");
    mock.save.mockRejectedValue(error);
    const view = mount();
    await settle();
    await vi.advanceTimersByTimeAsync(15000);
    expect(mock.save).toHaveBeenCalledTimes(2);
    expect(view.options.onError).toHaveBeenCalledTimes(1);
    await view.close();
    expect(view.options.onError).toHaveBeenCalledTimes(2);
    expect(view.api.destroy).not.toHaveBeenCalled();
    view.cleanup();
  });
  it("retries an initial failure even while the window is hidden", async () => {
    const error = new Error("disk full");
    mock.save.mockRejectedValueOnce(error);
    const view = mount();
    await settle();
    expect(view.options.dirty.current).toBe(true);
    expect(view.options.onError).toHaveBeenCalledWith(error);
    vi.stubGlobal("document", { hidden: true });
    await vi.advanceTimersByTimeAsync(15000);
    expect(mock.save).toHaveBeenCalledTimes(2);
    expect(view.options.dirty.current).toBe(false);
    view.cleanup();
  });

  it("keeps a dirty signal raised while a save is in flight", async () => {
    const pending = deferred<void>();
    mock.save.mockReturnValueOnce(pending.promise);
    const view = mount();
    await settle();
    expect(view.options.dirty.current).toBe(false);
    view.options.dirty.current = true;
    pending.resolve();
    await settle();
    expect(view.options.dirty.current).toBe(true);
    view.cleanup();
  });

  it("restores the dirty flag when preparing a snapshot fails", async () => {
    const error = new Error("terminal serialization failed");
    const view = mount();
    vi.mocked(view.options.state).mockImplementationOnce(() => { throw error; });
    await settle();
    expect(mock.save).not.toHaveBeenCalled();
    expect(view.options.dirty.current).toBe(true);
    expect(view.options.onError).toHaveBeenCalledWith(error);
    vi.stubGlobal("document", { hidden: true });
    await vi.advanceTimersByTimeAsync(15000);
    expect(mock.save).toHaveBeenCalledTimes(1);
    view.cleanup();
  });

  it("does not snapshot or write after cancellation during geometry lookup", async () => {
    const minimized = deferred<boolean>();
    const view = mount({ main: false });
    view.api.isMinimized.mockReturnValueOnce(minimized.promise);
    await settle();
    expect(view.api.isMinimized).toHaveBeenCalledTimes(1);
    view.cleanup();
    minimized.resolve(false);
    await settle();
    expect(view.api.outerPosition).not.toHaveBeenCalled();
    expect(view.options.state).not.toHaveBeenCalled();
    expect(mock.save).not.toHaveBeenCalled();
    expect(view.options.dirty.current).toBe(true);
  });

  it("drops queued flush work when unmounted during a write", async () => {
    const pending = deferred<void>();
    mock.save.mockReturnValueOnce(pending.promise);
    const view = mount();
    await settle();
    const flush = mock.listen.mock.calls[0][1];
    flush({ payload: 7 });
    view.cleanup();
    pending.resolve();
    await settle();
    expect(mock.save).toHaveBeenCalledTimes(1);
    expect(view.options.state).toHaveBeenCalledTimes(1);
    expect(view.options.dirty.current).toBe(true);
  });

  it("serializes writes across StrictMode effect generations", async () => {
    const pending = deferred<void>();
    mock.save.mockReturnValueOnce(pending.promise);
    const view = mount();
    await settle();
    view.cleanup();
    const cleanupAgain = view.setup() as () => void;
    await settle();
    expect(mock.save).toHaveBeenCalledTimes(1);
    pending.resolve();
    await settle();
    expect(mock.save).toHaveBeenCalledTimes(2);
    cleanupAgain();
  });

  it("skips stale initial work after immediate StrictMode cleanup", async () => {
    const view = mount();
    view.cleanup();
    const cleanupAgain = view.setup() as () => void;
    await settle();
    expect(mock.save).toHaveBeenCalledTimes(1);
    expect(view.offClose).toHaveBeenCalledTimes(1);
    cleanupAgain();
    expect(view.offClose).toHaveBeenCalledTimes(2);
  });

  it("preserves dirty editor state in flushes with session restore disabled", async () => {
    const view = mount({ restore: () => false });
    const state = view.options.state();
    view.options.state = () => ({ ...state, dirtyEditors: true });
    await settle();
    expect(mock.save).toHaveBeenLastCalledWith(null, undefined, true);
    mock.listen.mock.calls[0][1]({ payload: 12 });
    await settle();
    expect(mock.save).toHaveBeenLastCalledWith(null, 12, true);
    view.cleanup();
  });

  it("handles subscription registration failures without rejected cleanup promises", async () => {
    const error = new Error("event registration failed");
    mock.listen.mockRejectedValueOnce(error);
    const view = mount();
    await settle();
    expect(view.options.onError).toHaveBeenCalledWith(error);
    view.cleanup();
    await settle();
  });

  it("reports close listener registration errors", async () => {
    const error = new Error("close registration failed");
    const view = mount({ window: { onCloseRequested: vi.fn().mockRejectedValue(error) } as unknown as Options["window"] });
    await settle();
    expect(view.options.onError).toHaveBeenCalledWith(error);
    view.cleanup();
    await settle();
  });

  it("releases listeners whose registration completes after cleanup", async () => {
    const registration = deferred<() => void>();
    const off = vi.fn();
    mock.listen.mockReturnValueOnce(registration.promise);
    const view = mount();
    view.cleanup();
    registration.resolve(off);
    await settle();
    expect(off).toHaveBeenCalledTimes(1);
    expect(view.offClose).toHaveBeenCalledTimes(1);
    expect(mock.save).not.toHaveBeenCalled();
  });
});

describe("window close transaction", () => {
  it("keeps the window open when close preparation is cancelled", async () => {
    const view = mount({ prepareClose: async () => null });
    await settle();
    await view.close();
    expect(view.event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mock.save).toHaveBeenCalledTimes(1);
    expect(view.api.destroy).not.toHaveBeenCalled();
    view.cleanup();
  });

  it("validates again after saving and keeps newly edited buffers open", async () => {
    const validate = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const view = mount({ prepareClose: async () => validate });
    await settle();
    await view.close();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(mock.save).toHaveBeenCalledTimes(2);
    expect(view.api.destroy).not.toHaveBeenCalled();
    view.cleanup();
  });

  it("saves before destroying and ignores duplicate close requests", async () => {
    const prepare = deferred<(() => boolean) | null>();
    const view = mount({ prepareClose: () => prepare.promise });
    await settle();
    const closing = view.close();
    await view.close();
    prepare.resolve(() => true);
    await closing;
    expect(mock.save).toHaveBeenCalledTimes(2);
    expect(view.api.destroy).toHaveBeenCalledTimes(1);
    expect(mock.save.mock.invocationCallOrder[1]).toBeLessThan(view.api.destroy.mock.invocationCallOrder[0]);
    view.cleanup();
  });

  it("reports a failed close save and allows a later close retry", async () => {
    const error = new Error("cannot save session");
    const view = mount();
    await settle();
    mock.save.mockRejectedValueOnce(error);
    await view.close();
    expect(view.api.destroy).not.toHaveBeenCalled();
    expect(view.options.onError).toHaveBeenCalledWith(error);
    expect(view.options.dirty.current).toBe(true);
    await view.close();
    expect(view.api.destroy).toHaveBeenCalledTimes(1);
    view.cleanup();
  });

  it("reports preparation failures and never resumes a close after unmount", async () => {
    const error = new Error("editor save failed");
    const prepare = deferred<(() => boolean) | null>();
    const view = mount({ prepareClose: vi.fn().mockRejectedValueOnce(error).mockReturnValueOnce(prepare.promise) });
    await settle();
    await view.close();
    expect(view.options.onError).toHaveBeenCalledWith(error);
    const closing = view.close();
    view.cleanup();
    prepare.resolve(() => true);
    await closing;
    expect(view.api.destroy).not.toHaveBeenCalled();
    expect(mock.save).toHaveBeenCalledTimes(1);
  });
});
