import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderAuthRequests } from "./providerAuthRequests";
import type { ProviderAuthState } from "../../shared/providerAuth";
import type { ClientMsg } from "../../shared/remote-types";

const request = { op: "status", cli: "claude", profile: "work" } as const;
const state: ProviderAuthState = { cli: "claude", profile: "work", method: null, phase: "idle", sessionId: null, installed: true, authenticated: false, canBrowser: true, canApiKey: true, output: "" };
afterEach(() => vi.useRealTimers());

describe("phone provider authentication transport", () => {
  it("correlates replies across providers and enforces remote flows", async () => {
    const sent: ClientMsg[] = [];
    const broker = createProviderAuthRequests(async message => { sent.push(message); return true; });
    const first = broker.request({ ...request, remote: false });
    const second = broker.request({ ...request, cli: "codex" });
    const [a, b] = sent;
    if (a.t !== "providerauth" || b.t !== "providerauth") throw new Error("wrong message");
    expect(a.request.remote).toBe(true);
    expect(a.requestId).not.toBe(b.requestId);
    broker.receive({ t: "providerauth", requestId: b.requestId, state: { ...state, cli: "codex" }, error: null });
    broker.receive({ t: "providerauth", requestId: a.requestId, state, error: null });
    expect(await first).toEqual(state);
    expect((await second).cli).toBe("codex");
  });

  it("rejects server errors without marking authentication successful", async () => {
    let sent: ClientMsg | undefined;
    const broker = createProviderAuthRequests(async message => { sent = message; return true; });
    const result = broker.request(request);
    if (sent?.t !== "providerauth") throw new Error("wrong message");
    broker.receive({ t: "providerauth", requestId: sent.requestId, state: null, error: "Invalid profile" });
    await expect(result).rejects.toThrow("Invalid profile");
  });

  it("rejects failed sends and broken links immediately", async () => {
    const refused = createProviderAuthRequests(async () => false);
    await expect(refused.request(request)).rejects.toThrow("disconnected");
    const broker = createProviderAuthRequests(async () => true);
    const result = broker.request(request);
    broker.disconnect();
    await expect(result).rejects.toThrow("disconnected");
  });

  it("times out unanswered requests and ignores late replies", async () => {
    vi.useFakeTimers();
    let sent: ClientMsg | undefined;
    const broker = createProviderAuthRequests(async message => { sent = message; return true; }, 100);
    const result = broker.request(request);
    const rejection = expect(result).rejects.toThrow("did not answer");
    await vi.advanceTimersByTimeAsync(101);
    await rejection;
    if (sent?.t !== "providerauth") throw new Error("wrong message");
    const requestId = sent.requestId;
    expect(() => broker.receive({ t: "providerauth", requestId, state, error: null })).not.toThrow();
  });
});
