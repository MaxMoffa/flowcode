import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { metricText, usageBarMetric, usageFetcherFor } from "./usage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
beforeEach(() => {
  mockInvoke.mockReset();
});

describe("subscription usage", () => {
  it("shows OpenCode Go windows ahead of a Console budget for the same profile", async () => {
    const spend = { cost: 0, tokens: 10, sessions: 1 };
    mockInvoke.mockImplementation(async (command) => {
      if (command === "provider_auth") return { installed: true, authenticated: true };
      if (command === "cli_spend") return { today: spend, week: spend, month: spend, unpricedModels: [] };
      if (command === "opencode_console") return {
        workspace: "Personal",
        usageUrl: "https://opencode.ai/",
        budgets: [{ limit: 10, spent: 10, resetsAt: null }],
        windows: [
          { period: "fiveHours", percentUsed: 0, resetsAt: null },
          { period: "week", percentUsed: 78, resetsAt: 1796083200000 },
          { period: "month", percentUsed: 40, resetsAt: null },
        ],
      };
      throw new Error(`Unexpected command: ${command}`);
    });
    const result = await usageFetcherFor("opencode")!("work");

    expect(mockInvoke).toHaveBeenCalledWith("opencode_console", { profile: "work" });
    expect(result.metrics.slice(0, 4).map(({ kind, percent }) => [kind, percent])).toEqual([
      ["session", 0], ["week", 0.78], ["month", 0.4], ["budget", 1],
    ]);
    expect(usageBarMetric(result.metrics)).toBe(result.metrics[0]);
    expect(metricText(result.metrics[1]).label).toContain("OpenCode Go");
    expect(metricText(result.metrics[1]).detail).toBeDefined();
    expect(result.metrics[1].resets).toBeDefined();
    expect(result.metrics[4]).toMatchObject({ kind: "spend", tokens: 10 });
  });

  it("shows the windows ClinePass reports, then the local spend", async () => {
    const spend = { cost: 0, tokens: 7, sessions: 1 };
    mockInvoke.mockImplementation(async (command: string) =>
      command === "cli_spend"
        ? { today: spend, week: spend, month: spend, unpricedModels: [] }
        : { status: "available", windows: [{ period: "month", percentUsed: 100, resetsAt: "2026-12-01T00:00:00Z" }] },
    );
    const result = await usageFetcherFor("cline")!();

    expect(mockInvoke).toHaveBeenCalledWith("cline_usage", { profile: null });
    expect(result.ok).toBe(true);
    // Free models: tokens, not "$0".
    expect(result.metrics.slice(1)).toMatchObject([{ kind: "spend", tokens: 7 }, { kind: "spend" }, { kind: "spend" }]);
    expect(result.metrics.slice(1).every((m) => m.kind === "spend" && m.cost === undefined)).toBe(true);
    expect(result.metrics[0]).toMatchObject({ kind: "month", percent: 1 });
    expect(metricText(result.metrics[0]).detail).toBeDefined();
  });

  it("leaves the ClinePass bar blank when the credentials are rejected", async () => {
    mockInvoke.mockResolvedValue({ status: "rejectedCredentials" });
    const result = await usageFetcherFor("cline")!();

    expect(result.ok).toBe(false);
    expect(usageBarMetric(result.metrics)).toBeUndefined();
    expect(metricText(result.metrics[0]).label).toContain("cline auth");
  });
});

describe("mayProbeCodexStatus", () => {
  it("probes only with a plan login", async () => {
    const { mayProbeCodexStatus } = await import("./codexStatus");
    expect(mayProbeCodexStatus("subscription")).toBe(true);
    expect(mayProbeCodexStatus("unknown")).toBe(false);
    expect(mayProbeCodexStatus("api")).toBe(false);
  });
});

describe("codex usage poll when signed out", () => {
  it("reports loggedOut without spawning a terminal", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => (cmd === "cli_billing_mode" ? "unknown" : undefined) as never);
    const usage = await usageFetcherFor("codex-cli")!();
    expect(usage.metrics[0].kind).toBe("loggedOut");
    expect(mockInvoke.mock.calls.every(([cmd]) => cmd === "cli_billing_mode")).toBe(true);
  });
});
