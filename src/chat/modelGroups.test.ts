import { describe, expect, it } from "vitest";
import type { ChatModelOption } from "./chatTypes";
import { groupModels, matchesModel } from "./modelGroups";

const m = (modelId: string, name: string, group?: string, description?: string): ChatModelOption => ({ modelId, name, group, description });
const ids = (l: ChatModelOption[]) => l.map((x) => x.modelId);

const prefixed = (): ChatModelOption[] => [
  m("a1", "Anthropic/Claude Sonnet 4.5"),
  m("a2", "Anthropic/Claude Sonnet 4"),
  m("a3", "Anthropic/Claude Haiku 4.5"),
  m("o1", "OpenAI/GPT 5"),
  m("o2", "OpenAI/GPT 4"),
  m("g1", "Google/Gemini 2.5 Pro"),
  m("g2", "Google/Gemini Flash"),
  m("x1", "xAI/Grok"),
];

describe("groupModels", () => {
  it("returns null under the minimum", () => {
    expect(groupModels(prefixed().slice(0, 7))).toBeNull();
  });

  it("groups by the group field", () => {
    const list = Array.from({ length: 8 }, (_, i) => m(`id${i}`, `Model ${i}`, i < 4 ? "Alpha" : "Beta"));
    const r = groupModels(list)!;
    expect(r.groups.map((g) => g.label)).toEqual(["Alpha", "Beta"]);
    expect(r.names.get("id0")).toBe("Model 0");
    expect(r.groupOf.get("id5")).toBe("Beta");
  });

  it("groups by name prefix and strips it", () => {
    const r = groupModels(prefixed())!;
    expect(r.groups.map((g) => g.key)).toEqual(["anthropic", "openai", "google", "xai"]);
    expect(r.names.get("a1")).toBe("Claude Sonnet 4.5");
    expect(r.groupOf.get("o1")).toBe("OpenAI");
  });

  it("returns null when a name has no prefix", () => {
    const list = prefixed();
    list[3] = m("o1", "GPT 5");
    expect(groupModels(list)).toBeNull();
  });

  it("returns null for a single group", () => {
    const list = Array.from({ length: 8 }, (_, i) => m(`id${i}`, `Model ${i}`, "Only"));
    expect(groupModels(list)).toBeNull();
  });

  it("splits older versions inside a group", () => {
    const r = groupModels(prefixed())!;
    const a = r.groups[0];
    expect(ids(a.latest)).toEqual(["a1", "a3"]);
    expect(ids(a.older)).toEqual(["a2"]);
  });
});

describe("matchesModel", () => {
  it("needs every term", () => {
    const x = m("gpt-5", "GPT 5", undefined, "fast model");
    expect(matchesModel(x, "gpt fast")).toBe(true);
    expect(matchesModel(x, "gpt slow")).toBe(false);
    expect(matchesModel(x, "  ")).toBe(true);
  });

  it("matches the group label", () => {
    const x = m("a1", "Claude");
    expect(matchesModel(x, "claude anthropic", "Anthropic")).toBe(true);
    expect(matchesModel(x, "claude anthropic")).toBe(false);
  });
});
