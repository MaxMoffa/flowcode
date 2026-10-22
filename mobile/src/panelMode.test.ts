import { describe, expect, it } from "vitest";
import { dockedAtWidth, panelsFit, resolveDocked } from "./panelMode";

describe("dockedAtWidth", () => {
  it("auto docks from 1100 px only", () => {
    expect(dockedAtWidth("auto", 900)).toBe(false);
    expect(dockedAtWidth("auto", 1099)).toBe(false);
    expect(dockedAtWidth("auto", 1100)).toBe(true);
  });
  it("fixed docks at any wide width", () => {
    expect(dockedAtWidth("fixed", 760)).toBe(true);
    expect(dockedAtWidth("fixed", 900)).toBe(true);
    expect(dockedAtWidth("fixed", 1400)).toBe(true);
  });
  it("floating never docks", () => {
    expect(dockedAtWidth("floating", 900)).toBe(false);
    expect(dockedAtWidth("floating", 1600)).toBe(false);
  });
  it("resolveDocked follows the queries", () => {
    expect(resolveDocked("auto", true, false)).toBe(false);
    expect(resolveDocked("fixed", true, false)).toBe(true);
  });
});

describe("panelsFit", () => {
  it("keeps the terminal at 360 px at least", () => {
    expect(panelsFit(1100, 1, 260, 290)).toBe(true);
    expect(panelsFit(900, 1, 260, 290)).toBe(false);
    expect(panelsFit(942, 1, 260, 290)).toBe(true);
  });
  it("counts the UI zoom", () => {
    expect(panelsFit(1100, 1.3, 260, 290)).toBe(false);
  });
});
