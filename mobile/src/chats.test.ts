import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatInfo, ClientMsg, ServerMsg } from "../../shared/remote-types";

// The remote module is replaced by a scripted link: what the phone sends is recorded, what the desktop says is pushed in by hand.
const link = vi.hoisted(() => ({
  chats: null as ChatInfo[] | null,
  sent: [] as unknown[],
  handler: null as ((m: ServerMsg) => void) | null,
  online: true,
}));

vi.mock("./remote", () => ({
  currentChats: () => link.chats,
  onMessage: (l: (m: ServerMsg) => void) => void (link.handler = l),
  send: (m: ClientMsg) => void link.sent.push(m),
  sendChecked: async (m: ClientMsg) => {
    if (link.online) link.sent.push(m);
    return link.online;
  },
  useRemoteSelector: () => undefined,
}));

// Each test gets a fresh store, as a freshly started app would.
let chatsModule: typeof import("./chats");
const followChat = (id: string) => chatsModule.followChat(id);
const getChatSession = (id: string) => chatsModule.getChatSession(id);
const sendChatPrompt = (id: string, text: string) => chatsModule.sendChatPrompt(id, text);
const cancelChat = (id: string) => chatsModule.cancelChat(id);

const info = (status: ChatInfo["status"], over: Partial<ChatInfo> = {}): ChatInfo => ({ chatId: "c1", tabId: "t1", window: "main", label: "Chat", agent: "claude", cwd: "/x", status, ...over });
const say = (m: ServerMsg) => link.handler!(m);
const ready = () => say({ t: "ready", deviceName: "Telefono", hostName: "PC", caps: ["chat"] });
const chats = (list: ChatInfo[]) => {
  link.chats = list;
  say({ t: "chats", chats: list });
};
const ev = (seq: number, text: string) => ({ seq, at: 0, kind: "update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const opens = () => link.sent.filter((m): m is Extract<ClientMsg, { t: "chatopen" }> => (m as ClientMsg).t === "chatopen");
const prompts = () => link.sent.filter((m) => (m as ClientMsg).t === "chatprompt");

beforeEach(async () => {
  vi.resetModules();
  chatsModule = await import("./chats");
  link.sent = [];
  link.chats = null;
  link.online = true;
});

describe("following a chat", () => {
  it("opens it from the start, resumes from the last event after a reconnect, and closes it when left", () => {
    ready();
    chats([info("idle")]);
    const unfollow = followChat("c1");
    expect(opens()).toEqual([{ t: "chatopen", chatId: "c1", afterSeq: 0 }]);

    say({ t: "chatevents", chatId: "c1", events: [ev(1, "a"), ev(2, "b")], replay: true });
    say({ t: "chatevents", chatId: "c1", events: [ev(3, "c")], replay: false });
    expect(getChatSession("c1")?.model.lastSeq).toBe(3);

    // The link drops and comes back: nothing is asked until the new connection lists its chats...
    link.sent = [];
    ready();
    expect(opens()).toEqual([]);
    // ...then the chat is opened again from the last event the phone has.
    chats([info("idle")]);
    expect(opens()).toEqual([{ t: "chatopen", chatId: "c1", afterSeq: 3 }]);
    // The delta arrives, overlapping the last event the phone had: nothing is shown twice.
    say({ t: "chatevents", chatId: "c1", events: [ev(3, "c"), ev(4, "d")], replay: true });
    const agent = getChatSession("c1")?.model.items.filter((i) => i.type === "agent");
    expect(agent).toHaveLength(1);
    expect(agent?.[0].type === "agent" && agent[0].text).toBe("abcd");

    link.sent = [];
    unfollow();
    expect(link.sent).toEqual([{ t: "chatclose", chatId: "c1" }]);
  });

  it("follows a chat waiting on a permission even when no screen shows it", () => {
    ready();
    chats([info("waiting")]);
    expect(opens()).toHaveLength(1);
    // The answer arrives: it stops being followed.
    link.sent = [];
    chats([info("idle")]);
    expect(link.sent).toEqual([{ t: "chatclose", chatId: "c1" }]);
  });

  it("does not open the same chat twice, or one the desktop no longer lists", () => {
    ready();
    chats([info("idle")]);
    const a = followChat("c1");
    const b = followChat("c1");
    expect(opens()).toHaveLength(1);
    a();
    expect(link.sent.filter((m) => (m as ClientMsg).t === "chatclose")).toHaveLength(0);
    b();
    chats([]);
    link.sent = [];
    followChat("gone")();
    expect(link.sent).toEqual([]);
  });
});

describe("the send queue", () => {
  it("holds a message while the agent works and sends it when it is idle", async () => {
    ready();
    chats([info("busy")]);
    const stop = followChat("c1");
    say({ t: "chatevents", chatId: "c1", events: [{ seq: 1, at: 0, kind: "user", text: "primo" }], replay: true });
    sendChatPrompt("c1", "  dopo  ");
    expect(prompts()).toEqual([]);

    chats([info("idle")]);
    await Promise.resolve();
    expect(prompts()).toEqual([{ t: "chatprompt", chatId: "c1", text: "dopo" }]);
    stop();
  });

  it("sends the next queued message only after the previous one has started its turn", async () => {
    ready();
    chats([info("idle")]);
    say({ t: "chatevents", chatId: "c1", events: [{ seq: 1, at: 0, kind: "turnEnd", stopReason: "end_turn" }], replay: true });
    sendChatPrompt("c1", "uno");
    sendChatPrompt("c1", "due");
    await Promise.resolve();
    expect(prompts()).toHaveLength(1);

    // The desktop says idle again but nothing new happened yet: still one.
    chats([info("idle")]);
    expect(prompts()).toHaveLength(1);

    // The turn ran and ended: now the second goes.
    say({ t: "chatevents", chatId: "c1", events: [{ seq: 2, at: 0, kind: "user", text: "uno" }, { seq: 3, at: 0, kind: "turnEnd", stopReason: "end_turn" }], replay: false });
    await Promise.resolve();
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toEqual({ t: "chatprompt", chatId: "c1", text: "due" });
  });

  it("keeps a message the link refused and sends it after the next ready", async () => {
    ready();
    chats([info("idle")]);
    say({ t: "chatevents", chatId: "c1", events: [{ seq: 1, at: 0, kind: "turnEnd", stopReason: "end_turn" }], replay: true });
    link.online = false;
    sendChatPrompt("c1", "perso");
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts()).toEqual([]);

    link.online = true;
    ready();
    chats([info("idle")]);
    await new Promise((r) => setTimeout(r, 0));
    expect(prompts()).toEqual([{ t: "chatprompt", chatId: "c1", text: "perso" }]);
  });
});

describe("plain commands", () => {
  it("cancel goes straight out", () => {
    cancelChat("c1");
    expect(link.sent).toEqual([{ t: "chatcancel", chatId: "c1" }]);
  });
});
