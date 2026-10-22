import { describe, expect, it } from "vitest";
import { fuzzyFilter, fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("needs every character, in order", () => {
    expect(fuzzyScore("fcd", "flowcode")).not.toBeNull();
    expect(fuzzyScore("cf", "flowcode")).toBeNull();
    expect(fuzzyScore("xyz", "flowcode")).toBeNull();
  });
  it("ignores case and matches everything for a blank query", () => {
    expect(fuzzyScore("FLOW", "flowcode")).not.toBeNull();
    expect(fuzzyScore("  ", "anything")).toBe(0);
  });
  it("prefers runs and word starts", () => {
    expect(fuzzyScore("flow", "flowcode")!).toBeGreaterThan(fuzzyScore("flow", "f-l-o-w")!);
    expect(fuzzyScore("fc", "flow-code")!).toBeGreaterThan(fuzzyScore("fc", "afbc")!);
  });
});

describe("fuzzyFilter", () => {
  const names = ["api-server", "flowcode", "notes", "front-cache"];
  it("keeps the order for a blank query", () => {
    expect(fuzzyFilter(names, "", (n) => [n])).toEqual(names);
  });
  it("drops what does not match and ranks the rest", () => {
    expect(fuzzyFilter(names, "flow", (n) => [n])).toEqual(["flowcode"]);
    expect(fuzzyFilter(names, "fc", (n) => [n])[0]).toBe("front-cache");
  });
  it("matches on any of an item's texts", () => {
    const items = [{ name: "a", path: "C:/work/flowcode" }, { name: "b", path: "C:/other" }];
    expect(fuzzyFilter(items, "flowcode", (i) => [i.name, i.path])).toEqual([items[0]]);
  });
});
