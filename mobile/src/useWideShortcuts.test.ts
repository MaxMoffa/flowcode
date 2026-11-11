import { describe, expect, it } from "vitest";
import { shortcutFor, tabIndexFor } from "./useWideShortcuts";

const key = (k: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = { ctrl: true }) => ({ key: k, ctrlKey: !!mods.ctrl, shiftKey: !!mods.shift, altKey: !!mods.alt, metaKey: !!mods.meta });

describe("shortcutFor", () => {
  it("maps the desktop's defaults", () => {
    expect(shortcutFor(key("t"), "free")).toBe("newTab");
    expect(shortcutFor(key("w"), "free")).toBe("closeTab");
    expect(shortcutFor(key("Tab"), "free")).toBe("nextTab");
    expect(shortcutFor(key("Tab", { ctrl: true, shift: true }), "free")).toBe("prevTab");
    expect(shortcutFor(key("1"), "free")).toBe("selectTab1");
    expect(shortcutFor(key("8"), "free")).toBe("selectTab8");
    expect(shortcutFor(key("9"), "free")).toBe("lastTab");
    expect(shortcutFor(key("b"), "free")).toBe("toggleSidebar");
    expect(shortcutFor(key("A", { ctrl: true, shift: true }), "free")).toBe("toggleAgents");
    expect(shortcutFor(key("B", { ctrl: true, shift: true }), "free")).toBe("toggleBrowser");
    expect(shortcutFor(key("`"), "free")).toBe("toggleView");
  });
  it("never takes plain keys, Alt, Cmd or unbound chords", () => {
    expect(shortcutFor(key("t", {}), "xterm")).toBeNull();
    expect(shortcutFor(key("Tab", {}), "xterm")).toBeNull();
    expect(shortcutFor(key("t", { ctrl: true, alt: true }), "free")).toBeNull();
    expect(shortcutFor(key("t", { ctrl: true, meta: true }), "free")).toBeNull();
    expect(shortcutFor(key("c"), "xterm")).toBeNull();
    expect(shortcutFor(key("T", { ctrl: true, shift: true }), "free")).toBeNull();
    expect(shortcutFor(key("0"), "free")).toBeNull();
  });
  it("works from the terminal input, not from other text fields (except the view switch)", () => {
    expect(shortcutFor(key("Tab"), "xterm")).toBe("nextTab");
    expect(shortcutFor(key("w"), "xterm")).toBe("closeTab");
    expect(shortcutFor(key("Tab"), "editable")).toBeNull();
    expect(shortcutFor(key("w"), "editable")).toBeNull();
    expect(shortcutFor(key("`"), "editable")).toBe("toggleView");
  });
});

describe("tabIndexFor", () => {
  it("cycles with wrap", () => {
    expect(tabIndexFor("nextTab", 3, 2)).toBe(0);
    expect(tabIndexFor("prevTab", 3, 0)).toBe(2);
    expect(tabIndexFor("nextTab", 3, -1)).toBe(0);
    expect(tabIndexFor("prevTab", 3, -1)).toBe(2);
  });
  it("picks by number and the last", () => {
    expect(tabIndexFor("selectTab2", 3, 0)).toBe(1);
    expect(tabIndexFor("selectTab5", 3, 0)).toBeNull();
    expect(tabIndexFor("lastTab", 4, 0)).toBe(3);
    expect(tabIndexFor("nextTab", 0, -1)).toBeNull();
  });
});
