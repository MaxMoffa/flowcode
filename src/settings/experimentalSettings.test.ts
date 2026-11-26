import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "flowcode.experimental.acpV2";

// The test environment is node: no localStorage, so stub a Map-backed one.
function stubLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  });
  return data;
}

async function load() {
  vi.resetModules();
  return import("./experimentalSettings");
}

describe("experimental settings", () => {
  let data: Map<string, string>;

  beforeEach(() => {
    data = stubLocalStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults acpV2 to false", async () => {
    const mod = await load();
    expect(mod.getExperimentalSettings().acpV2).toBe(false);
  });

  it("persists true to the storage key", async () => {
    const mod = await load();
    mod.setAcpV2(true);
    expect(mod.getExperimentalSettings().acpV2).toBe(true);
    expect(data.get(KEY)).toBe("1");
  });

  it("reads the stored value on load", async () => {
    data.set(KEY, "1");
    const mod = await load();
    expect(mod.getExperimentalSettings().acpV2).toBe(true);
  });

  it("setAcpV2 is idempotent", async () => {
    const mod = await load();
    mod.setAcpV2(true);
    const afterFirst = mod.getExperimentalSettings();
    const stored = data.get(KEY);
    mod.setAcpV2(true);
    // Same state object and same stored value: nothing was written again.
    expect(mod.getExperimentalSettings()).toBe(afterFirst);
    expect(data.get(KEY)).toBe(stored);
    mod.setAcpV2(false);
    expect(mod.getExperimentalSettings().acpV2).toBe(false);
    expect(data.get(KEY)).toBe("0");
  });
});
