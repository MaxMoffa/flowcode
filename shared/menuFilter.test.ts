import { describe, expect, it } from "vitest";
import { matchesQuery, needsSearch, searchKeyAction, sectionMenu } from "./menuFilter";

const items = [
  { label: "New terminal", agent: false },
  { label: "Claude Code", agent: true },
  { label: "Clear terminal", agent: false },
  { label: "Codex CLI", agent: true },
];
const sections = (q: string) => sectionMenu(items, q, (i) => i.label, (i) => i.agent);

describe("sectionMenu", () => {
  it("puts agents first and keeps each section's order", () => {
    expect(sections("").map((s) => [s.id, s.items.map((i) => i.label)])).toEqual([
      ["agents", ["Claude Code", "Codex CLI"]],
      ["tools", ["New terminal", "Clear terminal"]],
    ]);
  });

  it("filters across sections and drops the empty ones", () => {
    expect(sections("CLEAR").map((s) => s.id)).toEqual(["tools"]);
    expect(sections("co").map((s) => s.id)).toEqual(["agents"]);
    expect(sections("cl").map((s) => s.items.length)).toEqual([2, 1]);
    expect(sections("zzz")).toEqual([]);
  });
});

describe("matchesQuery", () => {
  it("ignores case and surrounding spaces; blank matches everything", () => {
    expect(matchesQuery("Codex CLI", "  cli ")).toBe(true);
    expect(matchesQuery("Codex CLI", "   ")).toBe(true);
    expect(matchesQuery("Codex CLI", "vibe")).toBe(false);
  });
});

describe("needsSearch", () => {
  it("skips the bar for short menus", () => {
    expect(needsSearch(4)).toBe(false);
    expect(needsSearch(5)).toBe(true);
  });
});

describe("searchKeyAction", () => {
  it("clears before closing", () => {
    expect(searchKeyAction("Escape", "ab")).toBe("clear");
    expect(searchKeyAction("Escape", "")).toBe("close");
  });
  it("maps arrows and enter", () => {
    expect(searchKeyAction("ArrowDown", "")).toBe("down");
    expect(searchKeyAction("Enter", "x")).toBe("run");
    expect(searchKeyAction("a", "")).toBeNull();
  });
});
