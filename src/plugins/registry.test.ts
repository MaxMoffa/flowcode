import { describe, expect, it, vi } from "vitest";
import { builtinPlugins } from "./registry";

vi.mock("../i18n", () => ({ t: (key: string) => key }));

describe("agent panel feature", () => {
  it("is a builtin feature available to the menu, settings and shortcut bar", () => {
    expect(builtinPlugins().find((plugin) => plugin.id === "toggleAgentsSidebar")).toEqual({
      id: "toggleAgentsSidebar",
      label: "plugin.agents",
      description: "plugin.agents.description",
      action: "toggleAgentsSidebar",
      builtin: true,
    });
  });
});
