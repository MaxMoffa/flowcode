import { describe, expect, it } from "vitest";
import { isDialogTab, listedTabs, makeTermTab } from "./tabState";

describe("listedTabs", () => {
  it("leaves out the new tab dialog", () => {
    const a = makeTermTab("a", "C:\a");
    const draft = makeTermTab("d", "", { newTab: true, dialog: true });
    const b = makeTermTab("b", "C:\b");
    expect(isDialogTab(draft)).toBe(true);
    expect(isDialogTab(a)).toBe(false);
    expect(listedTabs([a, draft, b])).toEqual([a, b]);
  });

  it("returns the very same array when there is no dialog", () => {
    const tabs = [makeTermTab("a", "C:\a")];
    expect(listedTabs(tabs)).toBe(tabs);
  });
});
