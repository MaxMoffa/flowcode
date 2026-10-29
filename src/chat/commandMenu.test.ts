import { describe, expect, it } from "vitest";
import { buildMenu, classify, commandText, dedupe, displayName } from "./commandMenu";

const c = (name: string, extra: object = {}) => ({ name, description: "", ...extra });

describe("commandMenu", () => {
  it("finds a Codex $skill by a plain query", () => {
    const { entries } = buildMenu([c("$caveman"), c("compact")], [], "cave");
    expect(entries.map((e) => e.entry.command.name)).toEqual(["$caveman"]);
    expect(entries[0].hits).toEqual([0, 1, 2, 3]);
  });

  it("collapses a plugin duplicate into the skill", () => {
    const out = dedupe([classify(c("caveman"), new Set()), classify(c("caveman:caveman"), new Set())]);
    expect(out).toHaveLength(1);
    expect(out[0].also).toEqual(["caveman"]);
  });

  it("classifies mcp, plugin, command, skill and flowcode", () => {
    const names = new Set(["clear"]);
    expect(classify(c("clear"), names).kind).toBe("flowcode");
    const mcp = classify(c("mcp:flowlab:guide"), names);
    expect([mcp.kind, mcp.namespace, mcp.base]).toEqual(["mcp", "flowlab", "guide"]);
    const plug = classify(c("$pages:write"), names);
    expect([plug.kind, plug.namespace, plug.base, plug.sigil]).toEqual(["plugin", "pages", "write", "$"]);
    expect(classify(c("compact", { input: { hint: "[x]" } }), names)).toMatchObject({ kind: "command", hint: "[x]" });
    expect(classify(c("$review"), names).kind).toBe("skill");
    expect(classify(c("simplify"), names).kind).toBe("skill");
  });

  it("groups by kind then name when the query is empty", () => {
    const { entries, grouped } = buildMenu([c("zeta"), c("model"), c("a:b"), c("alpha")], [c("clear")], "");
    expect(grouped).toBe(true);
    expect(entries.map((e) => displayName(e.entry))).toEqual(["clear", "model", "alpha", "zeta", "a:b"]);
  });

  it("builds the text to send", () => {
    expect(commandText(classify(c("$caveman"), new Set()))).toBe("$caveman");
    expect(commandText(classify(c("compact"), new Set()))).toBe("/compact");
  });

  it("ranks prefix over substring and gives indices into the display name", () => {
    const { entries } = buildMenu([c("x-review"), c("review"), c("ns:review")], [], "rev");
    expect(entries.map((e) => displayName(e.entry))).toEqual(["review", "ns:review", "x-review"]);
    expect(entries[1].hits).toEqual([3, 4, 5]);
  });
});
