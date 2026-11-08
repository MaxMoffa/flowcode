import { describe, expect, it, vi } from "vitest";
import * as cliInfo from "./cliInfo";
import { readAgentToolsConfig, toolsConfig, type AgentToolsSettings } from "./agentToolsSettings";

const defaults: AgentToolsSettings = { enabled: true, open: true, openAutoAllow: true, delegate: true, delegateAgents: null, maxParallel: 3 };

describe("agent tools config", () => {
  it("checks installed CLIs before passing the default list to a new chat", async () => {
    const probe = vi.spyOn(cliInfo, "defaultCliStatus").mockImplementation(async (cli) => ({ installed: cli !== "codex", logged_in: cli === "claude" }));
    try {
      expect((await readAgentToolsConfig()).delegateAgents).toEqual(["claude"]);
      expect(probe).toHaveBeenCalledTimes(cliInfo.AGENT_CLIS.length);
    } finally {
      probe.mockRestore();
    }
  });
  it("allows every agent by default", () => {
    expect(toolsConfig(defaults)).toEqual({ enabled: true, open: true, openAutoAllow: true, delegate: true, delegateAgents: ["claude", "codex", "vibe", "gemini", "opencode"], maxParallel: 3 });
  });
  it("offers only the available agents by default, but the chosen ones as they are", () => {
    expect(toolsConfig(defaults, ["claude", "codex"]).delegateAgents).toEqual(["claude", "codex"]);
    expect(toolsConfig({ ...defaults, delegateAgents: ["gemini"] }, ["claude"]).delegateAgents).toEqual(["gemini"]);
  });
  it("sends everything off when the master switch is off", () => {
    expect(toolsConfig({ ...defaults, enabled: false })).toMatchObject({ enabled: false, open: false, openAutoAllow: false, delegate: false, delegateAgents: [] });
  });
  it("sends the chosen agents only, and none when delegation is off", () => {
    expect(toolsConfig({ ...defaults, delegateAgents: ["codex"] }).delegateAgents).toEqual(["codex"]);
    expect(toolsConfig({ ...defaults, delegate: false }).delegateAgents).toEqual([]);
  });
  it("auto-allows opening only when opening is on", () => {
    expect(toolsConfig({ ...defaults, open: false }).openAutoAllow).toBe(false);
  });
});
