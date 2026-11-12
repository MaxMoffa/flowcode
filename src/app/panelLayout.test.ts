import { describe, expect, it } from "vitest";
import { solvePanels, type PanelReq } from "./panelLayout";

const browser: PanelReq = { key: "browser", width: 480, min: 320 };
const sidebar: PanelReq = { key: "sidebar", width: 240, min: 180 };
const agents: PanelReq = { key: "agents", width: 240, min: 200 };

describe("solvePanels", () => {
  it("keeps preferred widths when everything fits", () => {
    const r = solvePanels(1600, 420, 8, [browser, sidebar, agents]);
    expect(r.shown).toEqual({ browser: 480, sidebar: 240, agents: 240 });
    expect(r.parked).toEqual([]);
  });

  it("shrinks the lowest-priority panel first", () => {
    // 420 + 488 + 248 + 248 = 1404; 1374 available -> 30 short, taken from agents.
    const r = solvePanels(1374, 420, 8, [browser, sidebar, agents]);
    expect(r.shown).toEqual({ browser: 480, sidebar: 240, agents: 210 });
  });

  it("moves up to the next panel once the lowest is at its min", () => {
    // 150 short: agents gives 40 (to its min), sidebar 60 (to its min), browser the last 50.
    const r = solvePanels(1254, 420, 8, [browser, sidebar, agents]);
    expect(r.shown).toEqual({ browser: 430, sidebar: 180, agents: 200 });
    expect(r.parked).toEqual([]);
  });

  it("parks the lowest-priority panel and everything after it when its min does not fit", () => {
    // 420 + 328 + 188 = 936 fits; adding agents (208) needs 1144.
    const r = solvePanels(1000, 420, 8, [browser, sidebar, agents]);
    expect(Object.keys(r.shown)).toEqual(["browser", "sidebar"]);
    expect(r.parked).toEqual(["agents"]);
  });

  it("parks lower panels even if a later one would fit", () => {
    const small: PanelReq = { key: "agents", width: 100, min: 50 };
    const r = solvePanels(800, 420, 8, [sidebar, browser, small]);
    expect(r.parked).toEqual(["browser", "agents"]);
  });

  it("always shows the top panel, at its min, even below the center minimum", () => {
    const r = solvePanels(500, 420, 8, [browser, sidebar]);
    expect(r.shown).toEqual({ browser: 320 });
    expect(r.parked).toEqual(["sidebar"]);
  });

  it("reports max widths that leave the center its minimum", () => {
    const r = solvePanels(1400, 420, 8, [browser, sidebar]);
    // browser may take everything but the center, the sidebar and two gaps.
    expect(r.maxWidth.browser).toBe(1400 - 420 - 240 - 16);
    expect(r.maxWidth.sidebar).toBe(1400 - 420 - 480 - 16);
  });

  it("never reports a max width below the panel's min", () => {
    const r = solvePanels(500, 420, 8, [browser]);
    expect(r.maxWidth.browser).toBe(320);
  });
});
