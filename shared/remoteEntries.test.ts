import { describe, expect, it } from "vitest";
import { remoteEntries } from "./remoteEntries";
import type { ChatInfo, Tab } from "./remote-types";

const tab = (ptyId: string, window: string, order?: number): Tab => ({ ptyId, tabId: "t" + ptyId, window, label: ptyId, cwd: "/", cols: 80, rows: 24, order });
const chat = (chatId: string, window: string, order?: number): ChatInfo => ({ chatId, tabId: "t" + chatId, window, label: chatId, agent: "claude", cwd: "/", order });
const keys = (tabs: Tab[], chats: ChatInfo[]) => remoteEntries(tabs, chats).map((e) => e.key);

describe("remoteEntries", () => {
  it("groups by window in order of appearance", () => {
    expect(keys([tab("a", "w1", 0), tab("b", "w2", 0)], [chat("x", "w2", 1), chat("y", "w1", 1)])).toEqual(["pty:a", "chat:y", "pty:b", "chat:x"]);
  });
  it("sorts by order within a window", () => {
    expect(keys([tab("a", "w1", 2), tab("c", "w1", 0)], [chat("y", "w1", 1)])).toEqual(["pty:c", "chat:y", "pty:a"]);
  });
  it("puts terminals before chats when any order is missing", () => {
    expect(keys([tab("a", "w1", 5), tab("b", "w1")], [chat("y", "w1", 0)])).toEqual(["pty:a", "pty:b", "chat:y"]);
  });
});
