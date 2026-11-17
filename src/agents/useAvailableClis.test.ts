import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
let cli: typeof import("./cliInfo");
let hook: typeof import("./useAvailableClis");
beforeEach(async () => {
  vi.resetModules();
  invoke.mockReset();
  cli = await import("./cliInfo");
  hook = await import("./useAvailableClis");
});

/** The list the hook returns on its first render (effects don't run in a string render). */
const firstRender = (): string[] => {
  let seen: string[] = [];
  renderToString(
    createElement(() => {
      seen = hook.useAvailableClis(undefined);
      return null;
    }),
  );
  return seen;
};

describe("useAvailableClis first render", () => {
  it("shows no agent until one is confirmed installed", () => {
    expect(firstRender()).toEqual([]);
  });
  it("is seeded from the status cache, uninstalled agents left out", async () => {
    invoke.mockImplementation((_cmd: string, args: { cli: string }) => Promise.resolve({ installed: args.cli === "claude" || args.cli === "codex", logged_in: false }));
    for (const c of cli.AGENT_CLIS) await cli.defaultCliStatus(c);
    expect(firstRender()).toEqual(["claude", "codex"]);
  });
});
