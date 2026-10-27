import { describe, expect, it } from "vitest";
import type { ChatInfo, Tab } from "../../shared/remote-types";
import { claimBusyRefusal, errorNotice, firstNewKey, pickActiveKey, remoteEntries, setPromptInFlight } from "./remoteHosts";

const tab = (ptyId: string, window: string): Tab => ({ ptyId, tabId: "t" + ptyId, window, label: ptyId, cwd: "/", cols: 80, rows: 24 });
const chat = (chatId: string, window: string): ChatInfo => ({ chatId, tabId: "t" + chatId, window, label: chatId, agent: "claude", cwd: "/" });

describe("remoteEntries", () => {
  it("groups by window, terminals before chats", () => {
    const keys = remoteEntries([tab("a", "w1"), tab("b", "w2"), tab("c", "w1")], [chat("x", "w2"), chat("y", "w1")]).map((e) => e.key);
    expect(keys).toEqual(["pty:a", "pty:c", "chat:y", "pty:b", "chat:x"]);
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
  it("is null with no tabs", () => {
    expect(pickActiveKey("pty:a", [])).toBeNull();
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
