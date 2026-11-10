import { describe, expect, it } from "vitest";
import type { ChatInfo, Tab } from "../../shared/remote-types";
import { claimBusyRefusal, errorNotice, firstNewKey, pickActiveKey, rememberVisit, remoteEntries, setPromptInFlight } from "./remoteHosts";

const tab = (ptyId: string, window: string): Tab => ({ ptyId, tabId: "t" + ptyId, window, label: ptyId, cwd: "/", cols: 80, rows: 24 });
const chat = (chatId: string, window: string): ChatInfo => ({ chatId, tabId: "t" + chatId, window, label: chatId, agent: "claude", cwd: "/" });

describe("remoteEntries", () => {
  it("groups by window, terminals before chats", () => {
    const keys = remoteEntries([tab("a", "w1"), tab("b", "w2"), tab("c", "w1")], [chat("x", "w2"), chat("y", "w1")]).map((e) => e.key);
    expect(keys).toEqual(["pty:a", "pty:c", "chat:y", "pty:b", "chat:x"]);
  });
  it("follows the window's own strip order when the desktop sends it", () => {
    const at = <T extends object>(x: T, order: number) => ({ ...x, order });
    const keys = remoteEntries([at(tab("a", "w1"), 2), at(tab("b", "w2"), 0), at(tab("c", "w1"), 0)], [at(chat("x", "w2"), 1), at(chat("y", "w1"), 1)]).map((e) => e.key);
    expect(keys).toEqual(["pty:c", "chat:y", "pty:a", "pty:b", "chat:x"]);
  });
  it("keeps the grouped order when a position is missing", () => {
    const keys = remoteEntries([{ ...tab("a", "w1"), order: 1 }], [{ ...chat("y", "w1") }]).map((e) => e.key);
    expect(keys).toEqual(["pty:a", "chat:y"]);
  });
});

describe("pickActiveKey", () => {
  it("keeps the current key while it exists", () => {
    expect(pickActiveKey("pty:b", ["pty:a", "pty:b"])).toBe("pty:b");
  });
  it("falls back to the first key", () => {
    expect(pickActiveKey("pty:gone", ["pty:a", "pty:b"])).toBe("pty:a");
    expect(pickActiveKey(null, ["chat:x"])).toBe("chat:x");
  });
  it("moves to the neighbour of a tab that went, not to the first", () => {
    const before = ["pty:a", "pty:b", "chat:c", "pty:d"];
    expect(pickActiveKey("chat:c", ["pty:a", "pty:b", "pty:d"], before)).toBe("pty:d");
    expect(pickActiveKey("pty:d", ["pty:a", "pty:b", "chat:c"], before)).toBe("chat:c");
    expect(pickActiveKey("chat:c", ["pty:a"], before)).toBe("pty:a");
  });
  it("is null with no tabs", () => {
    expect(pickActiveKey("pty:a", [])).toBeNull();
  });
});

describe("rememberVisit", () => {
  it("keeps every terminal but only the latest background chats", () => {
    let v: string[] = [];
    for (const k of ["pty:a", "chat:1", "chat:2", "chat:3", "chat:4", "chat:5", "chat:6", "pty:b", "chat:7", "chat:8"]) v = rememberVisit(v, k);
    expect(v).toEqual(["pty:a", "chat:2", "chat:3", "chat:4", "chat:5", "chat:6", "pty:b", "chat:7", "chat:8"]);
  });
  it("moves a revisited key to the end", () => {
    expect(rememberVisit(["pty:a", "chat:1"], "pty:a")).toEqual(["chat:1", "pty:a"]);
  });
});

describe("firstNewKey", () => {
  it("finds the key that was not there before", () => {
    expect(firstNewKey(new Set(["pty:a"]), ["pty:a", "pty:n"])).toBe("pty:n");
  });
  it("is null when nothing is new", () => {
    expect(firstNewKey(new Set(["pty:a"]), ["pty:a"])).toBeNull();
  });
});

describe("errorNotice", () => {
  it("shows non-fatal errors, never a busy refusal or a fatal one", () => {
    expect(errorNotice({ t: "error", message: "no such file", fatal: false })).toBe("no such file");
    expect(errorNotice({ t: "error", message: "agent_busy: the agent is still working on its turn", fatal: false })).toBeNull();
    expect(errorNotice({ t: "error", message: "bad token", fatal: true })).toBeNull();
    expect(errorNotice({ t: "tabs", tabs: [] })).toBeNull();
  });
  it("words an exited agent instead of the raw code", () => {
    const notice = errorNotice({ t: "error", message: "agent_exited: the agent has exited", fatal: false });
    expect(notice).toBeTruthy();
    expect(notice).not.toContain("agent_exited");
  });
});

describe("claimBusyRefusal", () => {
  it("lets a sender claim only while its prompt is the window's one in flight to that host", () => {
    expect(claimBusyRefusal("h", "a")).toBe(false);
    setPromptInFlight("h", "a", true);
    expect(claimBusyRefusal("h", "a")).toBe(true);
    expect(claimBusyRefusal("other", "a")).toBe(false);
    setPromptInFlight("h", "b", true);
    // Two in flight: the refusal can't be told apart.
    expect(claimBusyRefusal("h", "a")).toBe(false);
    expect(claimBusyRefusal("h", "b")).toBe(false);
    setPromptInFlight("h", "a", false);
    expect(claimBusyRefusal("h", "b")).toBe(true);
    setPromptInFlight("h", "b", false);
    expect(claimBusyRefusal("h", "b")).toBe(false);
  });
});
