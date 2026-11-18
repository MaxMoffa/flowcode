import { describe, expect, it } from "vitest";
import type { AppTab, ChatTab } from "./types";
import { newChatPane, patchChatPane, patchChatTab, showChatSession, swapChatPane } from "./chatPanes";

const chat = (over: Partial<ChatTab> = {}): ChatTab =>
  ({ id: "c1", kind: "chat", label: "one", cwd: "/work/proj", agent: "claude", sessionId: "s1", ...over }) as ChatTab;

describe("chatPanes", () => {
  it("patchChatTab patches only the chat tab with that id", () => {
    const tabs: AppTab[] = [chat(), chat({ id: "c2" })];
    const out = patchChatTab(tabs, "c1", { explorerPath: "/x" }) as ChatTab[];
    expect(out[0].explorerPath).toBe("/x");
    expect(out[1].explorerPath).toBeUndefined();
  });

  it("patchChatPane patches the shown pane on the tab and a parked pane in parked", () => {
    const tabs: AppTab[] = [chat({ paneKey: "p1", parked: [{ paneKey: "p2", label: "two", sessionId: "s2" }] })];
    const shown = patchChatPane(tabs, "c1", "p1", { label: "new" })[0] as ChatTab;
    expect(shown.label).toBe("new");
    const parked = patchChatPane(tabs, "c1", "p2", { label: "newer" })[0] as ChatTab;
    expect(parked.label).toBe("one");
    expect(parked.parked?.[0].label).toBe("newer");
  });

  it("swapChatPane shows next and parks the current one", () => {
    const out = swapChatPane(chat(), { paneKey: "p9", label: "nine", sessionId: "s9" });
    expect(out.paneKey).toBe("p9");
    expect(out.sessionId).toBe("s9");
    expect(out.parked).toEqual([expect.objectContaining({ paneKey: "c1", sessionId: "s1", label: "one" })]);
  });

  it("showChatSession swaps in a parked conversation of that session", () => {
    const tabs: AppTab[] = [chat({ parked: [{ paneKey: "p2", label: "two", sessionId: "s2" }] })];
    const out = showChatSession(tabs, "c1", "s2")[0] as ChatTab;
    expect(out.sessionId).toBe("s2");
    expect(out.paneKey).toBe("p2");
    expect(out.parked?.map((p) => p.sessionId)).toEqual(["s1"]);
  });

  it("showChatSession starts a new resuming pane for an unknown session, and ignores the shown one", () => {
    const tabs: AppTab[] = [chat()];
    expect(showChatSession(tabs, "c1", "s1")[0]).toBe(tabs[0]);
    const out = showChatSession(tabs, "c1", "s7", 5)[0] as ChatTab;
    expect(out.sessionId).toBe("s7");
    expect(out.lastActiveAt).toBe(5);
    expect(out.label).toBe("proj");
    expect(out.parked).toHaveLength(1);
  });

  it("newChatPane parks the shown conversation and starts an untalked one", () => {
    const out = newChatPane([chat()], "c1")[0] as ChatTab;
    expect(out.sessionId).toBeUndefined();
    expect(out.talked).toBe(false);
    expect(out.parked?.[0].sessionId).toBe("s1");
  });
});
