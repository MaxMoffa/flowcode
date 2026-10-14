import { describe, expect, it } from "vitest";
import { isValidSetting, type SettingContext } from "./settingDefs";

const ctx: SettingContext = { languages: ["en", "it"], hasPalette: (id) => id === "ocean" };
const ok = (k: string, v: unknown) => isValidSetting(k, v, ctx);

describe("isValidSetting", () => {
  const cases: [string, unknown, unknown][] = [
    ["theme", "dark", "purple"],
    ["palette", "ocean", "nope"],
    ["terminalPalette", null, "nope"],
    ["contrast", 0.4, "0.4"],
    ["glassOpacity", 1, NaN],
    ["language", "system", "xx"],
    ["terminalFontSize", 14, Infinity],
    ["bannerEnabled", true, 1],
    ["confirmLinkOpen", false, "false"],
    ["restoreSession", true, null],
    ["newTabPage", false, 0],
    ["notify.done", true, "true"],
    ["notify.input", false, 1],
    ["notify.exited", true, null],
    ["notify.limitReset", false, {}],
    ["autoResume.enabled", true, "on"],
    ["autoResume.message", "continue", 5],
  ];
  it.each(cases)("%s accepts a valid value and rejects an invalid one", (key, good, bad) => {
    expect(ok(key, good)).toBe(true);
    expect(ok(key, bad)).toBe(false);
  });

  it("accepts a known language and a known palette for terminalPalette", () => {
    expect(ok("language", "it")).toBe(true);
    expect(ok("terminalPalette", "ocean")).toBe(true);
  });

  it("caps the auto-resume message length", () => {
    expect(ok("autoResume.message", "x".repeat(500))).toBe(true);
    expect(ok("autoResume.message", "x".repeat(501))).toBe(false);
  });

  it("rejects unknown keys, including inherited ones", () => {
    expect(ok("nope", true)).toBe(false);
    expect(ok("notify.bogus", true)).toBe(false);
    expect(ok("toString", true)).toBe(false);
    expect(ok("__proto__", true)).toBe(false);
  });
});
