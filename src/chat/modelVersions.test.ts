import { describe, expect, it } from "vitest";
import type { ChatModelOption } from "./chatTypes";
import { splitModelVersions } from "./modelVersions";

const m = (modelId: string, name: string, group?: string): ChatModelOption => ({ modelId, name, group });
const ids = (l: ChatModelOption[]) => l.map((x) => x.modelId);

describe("splitModelVersions", () => {
  it("keeps the newest Claude of each family", () => {
    const list = [
      m("default", "Default (recommended)"),
      m("claude-opus-4-1-20250805", "Opus 4.1"),
      m("claude-opus-4-20250514", "Opus 4"),
      m("claude-sonnet-4-5-20250929", "Sonnet 4.5"),
      m("claude-sonnet-4-20250514", "Sonnet 4"),
      m("claude-haiku-4-5-20251001", "Haiku 4.5"),
    ];
    const r = splitModelVersions(list);
    expect(ids(r.latest)).toEqual(["default", "claude-opus-4-1-20250805", "claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"]);
    expect(ids(r.older)).toEqual(["claude-opus-4-20250514", "claude-sonnet-4-20250514"]);
  });

  it("reads ids when names carry no version", () => {
    const list = [m("claude-sonnet-4-5-20250929", "Sonnet"), m("claude-sonnet-4-20250514", "Sonnet")];
    const r = splitModelVersions(list);
    expect(ids(r.latest)).toEqual(["claude-sonnet-4-5-20250929"]);
    expect(ids(r.older)).toEqual(["claude-sonnet-4-20250514"]);
  });

  it("keeps Codex variants apart", () => {
    const list = [
      m("gpt-5.1-codex-max/high", "gpt-5.1-codex-max (high)"),
      m("gpt-5.1-codex-max/low", "gpt-5.1-codex-max (low)"),
      m("gpt-5-codex/medium", "gpt-5-codex (medium)"),
      m("gpt-5.1/low", "gpt-5.1 (low)"),
      m("gpt-5/low", "gpt-5 (low)"),
    ];
    const r = splitModelVersions(list);
    expect(ids(r.latest)).toEqual(["gpt-5.1-codex-max/high", "gpt-5.1-codex-max/low", "gpt-5-codex/medium", "gpt-5.1/low"]);
    expect(ids(r.older)).toEqual(["gpt-5/low"]);
  });

  it("treats flash and pro as different families", () => {
    const list = [m("gemini-2.5-pro", "gemini-2.5-pro"), m("gemini-2.5-flash", "gemini-2.5-flash"), m("gemini-3-pro-preview", "gemini-3-pro-preview")];
    const r = splitModelVersions(list);
    expect(ids(r.latest)).toEqual(["gemini-2.5-flash", "gemini-3-pro-preview"]);
    expect(ids(r.older)).toEqual(["gemini-2.5-pro"]);
  });

  it("compares versions numerically", () => {
    const r = splitModelVersions([m("a-4.10", "Foo 4.10"), m("a-4.9", "Foo 4.9")]);
    expect(ids(r.older)).toEqual(["a-4.9"]);
  });

  it("leaves versionless and single lists alone", () => {
    const none = [m("fast", "Fast"), m("smart", "Smart")];
    expect(splitModelVersions(none)).toEqual({ latest: none, older: [] });
    const one = [m("claude-sonnet-4-5", "Sonnet 4.5")];
    expect(splitModelVersions(one)).toEqual({ latest: one, older: [] });
    expect(splitModelVersions([])).toEqual({ latest: [], older: [] });
  });
});
