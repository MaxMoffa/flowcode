import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ invoke: vi.fn(), retain: vi.fn(() => () => {}), fetched: null as null | ((plugin: string, usage: unknown, profile?: string) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: fixture.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../remote/leader", () => ({ isRemoteLeader: () => true, watchRemoteLeader: () => () => {} }));
vi.mock("../profiles/profiles", () => ({
  ensureProfilesLoaded: () => {}, onProfilesChanged: () => () => {}, profileById: () => undefined,
  getProfilesState: () => ({ profiles: [{ id: "work", name: "Work", logged_in: { claude: false, codex: false, gemini: false, vibe: false } }] }),
}));
vi.mock("../agents/cliInfo", () => ({
  defaultCliStatus: async () => ({ installed: true, logged_in: false }),
  CLI_INFO: { claude: { pluginId: "claude-code", loginCommand: "claude auth login" }, codex: { pluginId: "codex-cli", loginCommand: "codex login" }, gemini: { pluginId: "gemini-cli", loginCommand: "gemini" }, vibe: { pluginId: "mistral-vibe", loginCommand: "vibe --setup" } },
}));
vi.mock("./usage", () => ({ metricText: () => ({ label: "Sign-in expired" }), usageFetcherFor: () => () => {} }));
vi.mock("./useUsageState", () => ({ onUsageFetched: (listener: typeof fixture.fetched) => { fixture.fetched = listener; return () => {}; }, retainUsage: fixture.retain }));
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal("window", new EventTarget()); fixture.invoke.mockReset(); fixture.retain.mockClear();
  fixture.invoke.mockImplementation(async (command) => command === "remote_status" ? { devices: [{ connected: true }] } : undefined);
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); });

describe("authentication state mirrored to phones", () => {
  it("publishes expired authentication even when the usage request failed", async () => {
    const { watchUsageForRemote } = await import("./remotePublish");
    dispose = watchUsageForRemote((id) => id).dispose;
    await vi.advanceTimersByTimeAsync(0);
    fixture.fetched?.("claude-code", { ok: true, metrics: [{ kind: "session", percent: .25 }] }, "work");
    fixture.fetched?.("claude-code", { ok: false, metrics: [{ kind: "reauth", command: "claude auth login" }] }, "work");
    await vi.advanceTimersByTimeAsync(2000);
    const published = fixture.invoke.mock.calls.find(([command]) => command === "remote_publish_usage")?.[1];
    expect(published.items).toContainEqual(expect.objectContaining({ pluginId: "claude-code", profile: "work", metrics: [expect.objectContaining({ kind: "reauth" })] }));
  });

  it("retains installed providers even before a profile has logged in", async () => {
    const { watchUsageForRemote } = await import("./remotePublish");
    dispose = watchUsageForRemote((id) => id).dispose;
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.retain).toHaveBeenCalledWith("gemini-cli", "work");
    expect(fixture.retain).toHaveBeenCalledWith("claude-code", undefined);
  });
});
