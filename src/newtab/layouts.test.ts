import { describe, expect, it } from "vitest";
import { DEFAULT_NEW_TAB_LAYOUT, createLayoutRegistry, layoutLabel } from "./layouts";
import type { NewTabLayoutDef } from "./types";

const component = () => null;

function def(id: string, source: NewTabLayoutDef["source"] = "builtin"): NewTabLayoutDef {
  return { id, labelKey: "newTab.layout.terminal", source, component };
}

describe("new tab layout registry", () => {
  it("keeps registration order and throws on a duplicate id", () => {
    const r = createLayoutRegistry();
    r.register(def("terminal"));
    r.register(def("glass"));
    expect(r.list().map((l) => l.id)).toEqual(["terminal", "glass"]);
    expect(() => r.register(def("glass"))).toThrow();
  });
  it("unregisters plugin layouts only", () => {
    const r = createLayoutRegistry();
    r.register(def("terminal"));
    r.register(def("board", "plugin"));
    r.unregister("terminal");
    r.unregister("board");
    expect(r.list().map((l) => l.id)).toEqual(["terminal"]);
  });
  it("falls back to the default layout for an unknown id", () => {
    const r = createLayoutRegistry();
    r.register(def(DEFAULT_NEW_TAB_LAYOUT));
    r.register(def("board", "plugin"));
    expect(r.resolve("board").id).toBe("board");
    expect(r.resolve("gone").id).toBe(DEFAULT_NEW_TAB_LAYOUT);
    expect(r.resolve(undefined).id).toBe(DEFAULT_NEW_TAB_LAYOUT);
  });
  it("notifies subscribers", () => {
    const r = createLayoutRegistry();
    let calls = 0;
    const stop = r.subscribe(() => calls++);
    r.register(def("terminal"));
    stop();
    r.register(def("glass"));
    expect(calls).toBe(1);
  });
  it("names a layout from its translations, label or key", () => {
    const t = (key: string) => `<${key}>`;
    expect(layoutLabel({ ...def("a", "plugin"), labelKey: undefined, label: "Board", labels: { it: "Lavagna" } }, t, "it")).toBe("Lavagna");
    expect(layoutLabel({ ...def("a", "plugin"), labelKey: undefined, label: "Board", labels: { it: "Lavagna" } }, t, "en")).toBe("Board");
    expect(layoutLabel(def("terminal"), t, "it")).toBe("<newTab.layout.terminal>");
  });
});
