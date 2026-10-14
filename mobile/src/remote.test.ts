import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { DEFAULT_SETTINGS, normalizeProfiles, normalizeSettings } = await import("./remote");

describe("normalizeSettings", () => {
  it("is null for non-objects", () => {
    for (const v of [null, undefined, 5, "x", [], true]) expect(normalizeSettings(v)).toBeNull();
  });

  it("fills an empty object with the defaults", () => {
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults for wrong types", () => {
    const s = normalizeSettings({ theme: "pink", resolvedTheme: 3, palette: 9, contrast: "high", bannerEnabled: "yes", terminalPalette: 4, notify: "x", autoResume: [] });
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid values", () => {
    const s = normalizeSettings({ theme: "light", palette: "ocean", terminalPalette: "mono", language: "it", bannerEnabled: false, notify: { done: false, exited: true }, autoResume: { enabled: true, message: "go" } });
    expect(s).toMatchObject({ theme: "light", palette: "ocean", terminalPalette: "mono", language: "it", bannerEnabled: false });
    expect(s?.notify).toEqual({ done: false, input: true, exited: true, limitReset: true });
    expect(s?.autoResume).toEqual({ enabled: true, message: "go" });
  });

  it("clamps numbers and rejects non-finite ones", () => {
    expect(normalizeSettings({ contrast: 7, glassOpacity: -2, terminalFontSize: 100 })).toMatchObject({ contrast: 1, glassOpacity: 0, terminalFontSize: 28 });
    expect(normalizeSettings({ terminalFontSize: 1 })?.terminalFontSize).toBe(9);
    expect(normalizeSettings({ contrast: NaN, terminalFontSize: Infinity })).toMatchObject({ contrast: 0.5, terminalFontSize: 14 });
  });

  it("drops malformed list entries and non-string map values", () => {
    const s = normalizeSettings({
      languages: [{ id: "en", name: "English" }, { id: "it" }, { name: "no id" }, "x"],
      palettes: [{ id: "a" }, { id: 3 }],
      colors: { bg: "#000", bad: 5 },
    });
    expect(s?.languages).toEqual([{ id: "en", name: "English" }, { id: "it", name: "it" }]);
    expect(s?.palettes).toEqual([{ id: "a", name: "a", bg: "#000000", accent: "#888888", accent2: "#888888" }]);
    expect(s?.colors).toEqual({ bg: "#000" });
  });
});

describe("normalizeProfiles", () => {
  it("is empty for non-arrays", () => {
    expect(normalizeProfiles(null)).toEqual([]);
    expect(normalizeProfiles({})).toEqual([]);
  });

  it("drops entries without a string id and fills the rest", () => {
    const out = normalizeProfiles([{ id: "w", name: "Work", color: "#112233", loggedIn: { claude: true, codex: "yes" } }, { name: "x" }, 7, { id: "p" }]);
    expect(out).toEqual([
      { id: "w", name: "Work", color: "#112233", loggedIn: { claude: true, codex: false, vibe: false } },
      { id: "p", name: "p", color: "#64748b", loggedIn: { claude: false, codex: false, vibe: false } },
    ]);
  });

  it("replaces an invalid color with the fallback", () => {
    expect(normalizeProfiles([{ id: "a", color: "red" }, { id: "b", color: "#abc" }]).map((p) => p.color)).toEqual(["#64748b", "#64748b"]);
  });
});
