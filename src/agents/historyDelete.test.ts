import { describe, expect, it } from "vitest";
import { getHiddenRows, hideRows, unhideRows } from "./historyDelete";

describe("hidden rows", () => {
  it("hides and unhides by key", () => {
    hideRows(["claude:a", "codex:b"]);
    expect(getHiddenRows().has("claude:a")).toBe(true);
    unhideRows(["claude:a"]);
    expect(getHiddenRows().has("claude:a")).toBe(false);
    expect(getHiddenRows().has("codex:b")).toBe(true);
  });

  it("keeps the same set when nothing changes", () => {
    const before = getHiddenRows();
    unhideRows(["nope:1"]);
    hideRows([]);
    expect(getHiddenRows()).toBe(before);
  });
});
