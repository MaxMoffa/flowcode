import { beforeEach, describe, expect, it } from "vitest";
import { defaultModeToApply, getDefaultMode, modeKind, setDefaultMode } from "./chatModeDefaults";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe("modeKind", () => {
  it("uses the id first, then the name", () => {
    expect(modeKind({ id: "acceptEdits", name: "x" })).toBe("edit");
    expect(modeKind({ id: "bypassPermissions", name: "x" })).toBe("bolt");
    expect(modeKind({ id: "m1", name: "Read Only" })).toBe("eye");
    expect(modeKind({ id: "m2", name: "Something" })).toBe("generic");
  });
});

describe("default mode", () => {
  const base = { agent: "claude", offered: ["default", "plan"], currentModeId: "default", liveModeId: null, itemCount: 0, loaded: true, ready: true };
  it("applies for a new chat that offers it", () => {
    setDefaultMode("claude", "plan");
    expect(getDefaultMode("claude")).toBe("plan");
    expect(defaultModeToApply(base)).toBe("plan");
  });
  it("skips resumed, picked, unoffered or already-current", () => {
    setDefaultMode("claude", "plan");
    expect(defaultModeToApply({ ...base, itemCount: 3 })).toBeNull();
    expect(defaultModeToApply({ ...base, liveModeId: "default" })).toBeNull();
    expect(defaultModeToApply({ ...base, currentModeId: "plan" })).toBeNull();
    setDefaultMode("claude", "nope");
    expect(defaultModeToApply(base)).toBeNull();
    setDefaultMode("claude", null);
    expect(getDefaultMode("claude")).toBeNull();
  });
});
