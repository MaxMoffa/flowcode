import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { RemoteImageLoaderLease } from "./remoteImageLoader";
import type { ImageUrlCache } from "../../shared/imageUrlCache";

const network = vi.hoisted(() => ({ send: vi.fn(), messages: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: network.listen }));
vi.mock("../remoteHosts/remoteHosts", () => ({ sendToHost: network.send, onHostMessages: network.messages }));

interface Request {
  id?: string;
  path?: string;
  chatId?: string;
  requestId?: string;
}
type Messages = (messages: unknown[]) => void;
type StateListener = (event: { payload: { id: string; status: "connecting" | "online" | "offline"; caps: string[] } }) => void;

let retain: typeof import("./remoteImageLoader").retainRemoteImageLoader;
let messages: Map<string, Set<Messages>>;
let stateListeners: Set<StateListener>;
let offMessages: Mock<(id: string) => void>;
let offState: Mock<() => void>;
let leases: RemoteImageLoaderLease[];
let caches: ImageUrlCache[];

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  messages = new Map();
  stateListeners = new Set();
  leases = [];
  caches = [];
  offMessages = vi.fn();
  offState = vi.fn();
  network.send.mockReset().mockResolvedValue(true);
  network.messages.mockReset().mockImplementation((id: string, listener: Messages) => {
    let listeners = messages.get(id);
    if (!listeners) messages.set(id, (listeners = new Set()));
    listeners.add(listener);
    return () => { listeners.delete(listener); offMessages(id); };
  });
  network.listen.mockReset().mockImplementation(async (_event: string, listener: StateListener) => {
    stateListeners.add(listener);
    return () => { stateListeners.delete(listener); offState(); };
  });
  const module = await import("./remoteImageLoader");
  retain = (id, requestIds) => {
    const lease = module.retainRemoteImageLoader(id, requestIds);
    leases.push(lease);
    return lease;
  };
});

afterEach(async () => {
  leases.forEach((lease) => lease.release());
  caches.forEach((cache) => cache.dispose());
  await vi.runOnlyPendingTimersAsync();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function requests(hostId: string): Request[] {
  return network.send.mock.calls.filter(([id]) => id === hostId).map(([, request]) => request as Request);
}

function reply(hostId: string, key: string, text: string) {
  const message = { t: "chatimage", key, offset: 0, total: text.length, data: btoa(text), mime: "image/png" };
  messages.get(hostId)?.forEach((listener) => listener([message]));
}

function state(id: string, status: "connecting" | "online" | "offline", requestIds = true) {
  stateListeners.forEach((listener) => listener({ payload: { id, status, caps: requestIds ? ["chatImageRequestId"] : [] } }));
}

describe("shared remote image transport", () => {
  it("preserves a pending URL load through StrictMode release and synchronous reacquire", async () => {
    const { createImageUrlCache } = await import("../../shared/imageUrlCache");
    const cache = createImageUrlCache();
    caches.push(cache);
    const first = retain("host", true);
    const releaseFirstImage = cache.retain("host:image");
    const pending = cache.load("host:image", () => first.fetcher.fetch({ chatId: "chat", path: "pic.png" }));
    first.release();
    releaseFirstImage();
    const second = retain("host", true);
    const releaseSecondImage = cache.retain("host:image");
    const repeated = cache.load("host:image", () => second.fetcher.fetch({ chatId: "chat", path: "pic.png" }));

    expect(second.fetcher).toBe(first.fetcher);
    expect(repeated).toBe(pending);
    expect(requests("host")).toHaveLength(1);
    expect(network.messages).toHaveBeenCalledTimes(1);
    expect(network.listen).toHaveBeenCalledTimes(1);
    expect(offMessages).not.toHaveBeenCalled();
    reply("host", requests("host")[0].requestId!, "image");
    await expect(repeated).resolves.toMatch(/^blob:/);
    releaseSecondImage();
    second.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(offMessages).toHaveBeenCalledOnce();
    expect(offState).toHaveBeenCalledOnce();
  });

  it("shares the legacy response namespace across chats instead of mixing same-path images", async () => {
    const a = retain("old-host", false);
    const b = retain("old-host", false);
    const first = a.fetcher.fetch({ chatId: "chat-a", path: "pic.png" });
    const collision = b.fetcher.fetch({ chatId: "chat-b", path: "pic.png" });
    await expect(collision).resolves.toBeNull();
    expect(requests("old-host")).toHaveLength(1);
    reply("old-host", "pic.png", "A");
    expect(await (await first)?.text()).toBe("A");

    const retried = b.fetcher.fetch({ chatId: "chat-b", path: "pic.png" });
    expect(requests("old-host")).toHaveLength(2);
    reply("old-host", "pic.png", "B");
    expect(await (await retried)?.text()).toBe("B");
  });

  it("keeps a shared pending image alive while another provider still owns the host", async () => {
    const a = retain("host", true);
    const b = retain("host", true);
    const first = a.fetcher.fetch({ chatId: "chat-a", id: "same-image" });
    const second = b.fetcher.fetch({ chatId: "chat-b", id: "same-image" });
    expect(requests("host")).toHaveLength(1);
    a.release();
    a.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(offMessages).not.toHaveBeenCalled();
    reply("host", requests("host")[0].requestId!, "image");
    const [firstBlob, secondBlob] = await Promise.all([first, second]);
    expect(firstBlob).toBe(secondBlob);
    expect(await secondBlob?.text()).toBe("image");
    b.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(offMessages).toHaveBeenCalledOnce();
    expect(offState).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a pending image after reconnect and ignores chunks from the old request", async () => {
    const lease = retain("host", true);
    const pending = lease.fetcher.fetch({ chatId: "chat", path: "pic.png" });
    const firstKey = requests("host")[0].requestId!;
    await vi.advanceTimersByTimeAsync(0);
    state("host", "connecting");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests("host")).toHaveLength(1);
    let settled = false;
    void pending.then(() => { settled = true; });
    state("host", "online");
    await vi.advanceTimersByTimeAsync(0);
    expect(requests("host")).toHaveLength(2);
    const replacementKey = requests("host")[1].requestId!;
    expect(replacementKey).not.toBe(firstKey);
    reply("host", firstKey, "old");
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    reply("host", replacementKey, "new");
    expect(await (await pending)?.text()).toBe("new");
  });

  it("cancels pending work and unregisters even when Tauri's registration finishes after final release", async () => {
    let finishRegistration!: (off: () => void) => void;
    network.listen.mockImplementationOnce(() => new Promise<() => void>((resolve) => { finishRegistration = resolve; }));
    const lease = retain("host", true);
    const pending = lease.fetcher.fetch({ chatId: "chat", path: "pic.png" });
    lease.release();
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBeNull();
    expect(offMessages).toHaveBeenCalledOnce();
    expect(offState).not.toHaveBeenCalled();
    finishRegistration(offState);
    await vi.advanceTimersByTimeAsync(0);
    expect(offState).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates hosts with identical legacy image paths", async () => {
    const a = retain("host-a", false);
    const b = retain("host-b", false);
    const first = a.fetcher.fetch({ chatId: "chat", path: "pic.png" });
    const second = b.fetcher.fetch({ chatId: "chat", path: "pic.png" });
    expect(a.fetcher).not.toBe(b.fetcher);
    reply("host-a", "pic.png", "A");
    reply("host-b", "pic.png", "B");
    expect(await (await first)?.text()).toBe("A");
    expect(await (await second)?.text()).toBe("B");
    expect(network.messages).toHaveBeenCalledTimes(2);
  });
});
