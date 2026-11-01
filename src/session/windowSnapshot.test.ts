import { describe, expect, it, vi } from "vitest";
import { windowSnapshot, type WindowSnapshotState } from "./windowSnapshot";
import { makeTermTab } from "../tabs/tabState";

describe("window session snapshot", () => {
  it("keeps restored scrollback and skips virgin terminals and transient tabs", () => {
    const serialize = vi.fn(() => "new shell prompt");
    const state: WindowSnapshotState = {
      tabs: [makeTermTab("virgin", "/work"), makeTermTab("restored", "/work"), { ...makeTermTab("dialog", "/work"), dialog: true }, { kind: "editor", id: "e", path: "/work/a", label: "a" }],
      activeTabId: "e", restoreContent: true, restoredTabIds: new Set(["restored"]),
      terminals: new Map([["restored", { wasUsed: () => false, serialize }]]),
      restoredContent: new Map([["restored", "original scrollback"]]), shellOf: () => "bash",
    };
    const snapshot = windowSnapshot(state);
    expect(snapshot.activeIndex).toBe(1);
    expect(snapshot.tabs).toEqual([
      expect.objectContaining({ kind: "terminal", content: "original scrollback", shell: "bash" }),
      { kind: "editor", path: "/work/a", label: "a" },
    ]);
    expect(serialize).not.toHaveBeenCalled();
  });
  it("does not restore a chat that nobody spoke to as an existing session", () => {
    const state: WindowSnapshotState = {
      tabs: [{ kind: "chat", id: "c", agent: "claude", cwd: "/work", label: "Claude", talked: false, sessionId: "not-on-disk", lastActiveAt: 100 }],
      activeTabId: "c", restoreContent: true, restoredTabIds: new Set(), terminals: new Map(), restoredContent: new Map(), shellOf: () => undefined,
    };
    expect(windowSnapshot(state).tabs[0]).toMatchObject({ kind: "chat", sessionId: undefined, lastActiveAt: undefined });
  });
});
