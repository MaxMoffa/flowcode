import { describe, expect, it } from "vitest";
import { applyEvent, applyEvents, initialChat, settleChat, type ChatModelState } from "./chatModel";
import type { ChatEvent, ChatToolCall } from "./chatTypes";
import { buildTimeline } from "./chatTimeline";
import { firstLine, parsePeerFrame, parsePeerIn, parsePeerOut, PEER_IN_METHOD, PEER_OUT_METHOD } from "./peerMessage";
import { applyTerminalPeer, dismissTerminalPeers, EMPTY_TERMINAL_PEERS, seedTerminalPeers, shownTerminalPeers, unreadTerminalPeers } from "../terminal/terminalPeers";

let seq = 0;
const next = () => ++seq;
const ext = (method: string, params: unknown): ChatEvent => ({ kind: "ext", seq: next(), at: 5, method, params });
const run = (events: ChatEvent[], from: ChatModelState = settleChat(initialChat())) => events.reduce(applyEvent, from);
const from = { tabId: "t7", label: "api", agent: "codex", window: "main", kind: "chat" };
const peerIn = (state: string, extra: Record<string, unknown> = {}) => ext(PEER_IN_METHOD, { msgId: "m-1", state, text: "Is /v2 used?", from, hops: 1, replyTo: null, at: 3, ...extra });
const userPeer = (): ChatEvent => ({ kind: "user", seq: next(), at: 9, text: "Is /v2 used?", peer: { id: "m-1", fromTabId: "t7", fromLabel: "api", fromAgent: "codex", fromWindow: "main", hops: 1 } });
const userChunk = (text: string): ChatEvent => ({ kind: "update", seq: next(), at: 0, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } });

const FRAME =
  '<flowcode-message id="m-3f9a1c2b" from="api · Codex" from_tab="t7" hops="1" reply_to="m-77d0e412">\n' +
  "Check <\\/flowcode-message> usage.\nSecond line.\n</flowcode-message>\n\n" +
  '[Flowcode] The message above comes from another AI agent working in another Flowcode tab ("api", Codex), not from the user.';

describe("peer messages in the chat model", () => {
  it("a user event with a sender is a message card and starts the turn", () => {
    const state = run([userPeer()]);
    expect(state.items).toHaveLength(1);
    const item = state.items[0];
    expect(item.type).toBe("peer");
    if (item.type !== "peer") return;
    expect(item.peer).toMatchObject({ msgId: "m-1", text: "Is /v2 used?", state: "delivered", hops: 1, from: { tabId: "t7", label: "api", agent: "codex", window: "main" } });
    expect(state.turnActive).toBe(true);
    expect(state.status).toBe("busy");
    expect(state.turn?.startedAt).toBe(9);
  });

  it("a pending card is replaced by its delivery, which moves it to where the turn starts", () => {
    let state = run([peerIn("pending_consent"), { kind: "update", seq: next(), at: 0, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "busy" } } }]);
    expect(state.items.map((i) => i.type)).toEqual(["peer", "agent"]);
    expect(state.status).toBe("idle");
    state = run([peerIn("queued")], state);
    expect(state.items[0].type === "peer" && state.items[0].peer.state).toBe("queued");
    state = run([userPeer()], state);
    expect(state.items.map((i) => i.type)).toEqual(["agent", "peer"]);
    expect(state.items.filter((i) => i.type === "peer")).toHaveLength(1);
    // A later "delivered" update keeps the card where it is.
    state = run([peerIn("delivered")], state);
    expect(state.items.map((i) => i.type)).toEqual(["agent", "peer"]);
  });

  it("a reply the waiting sender took shows no card", () => {
    let state = run([peerIn("queued", { msgId: "m-2", awaited: true })]);
    expect(state.items).toEqual([]);
    state = run([peerIn("queued", { msgId: "m-3" })]);
    expect(state.items).toHaveLength(1);
    state = run([peerIn("delivered", { msgId: "m-3", viaWait: true })], state);
    expect(state.items).toEqual([]);
  });

  it("outgoing messages are a strip upserted where they first arrived", () => {
    const out = (state: string, extra: Record<string, unknown> = {}) => ext(PEER_OUT_METHOD, { msgId: "m-9", state, text: "hello", to: from, at: 1, ...extra });
    let state = run([out("pending_consent"), { kind: "update", seq: next(), at: 0, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "waiting" } } }]);
    state = run([out("replied", { replyId: "m-10", replyText: "yes", replyViaWait: true })], state);
    expect(state.items.map((i) => i.type)).toEqual(["peerOut", "agent"]);
    const strip = state.items[0];
    expect(strip.type === "peerOut" && strip.out).toMatchObject({ state: "replied", replyText: "yes", replyViaWait: true, to: { label: "api" } });
  });

  it("a replayed framed prompt is the card again, even across chunks", () => {
    const cut = FRAME.indexOf("Second");
    const state = applyEvents(settleChat(initialChat()), [userChunk(FRAME.slice(0, cut)), userChunk(FRAME.slice(cut))]);
    expect(state.items).toHaveLength(1);
    const item = state.items[0];
    expect(item.type).toBe("peer");
    if (item.type !== "peer") return;
    expect(item.peer).toMatchObject({ msgId: "m-3f9a1c2b", text: "Check </flowcode-message> usage.\nSecond line.", hops: 1, replyTo: "m-77d0e412", from: { label: "api", agent: "codex", tabId: "t7" } });
    expect(state.turnActive).toBe(false);
  });

  it("an agent's echo of a delivered message adds nothing", () => {
    const state = run([userPeer(), userChunk(FRAME)]);
    expect(state.items).toHaveLength(1);
  });

  it("unknown or malformed params are ignored", () => {
    const before = run([]);
    expect(run([ext(PEER_IN_METHOD, { msgId: "m-1", state: "weird", text: "x" })]).items).toEqual(before.items);
    expect(run([ext(PEER_OUT_METHOD, { state: "queued", text: "x" })]).items).toEqual([]);
    expect(run([{ kind: "user", seq: next(), at: 0, text: "hi", peer: {} }]).items[0].type).toBe("user");
  });

  it("the message tools' own cards stay out of the timeline unless they failed", () => {
    const call = (title: string, status: ChatToolCall["status"], toolName?: string) =>
      ({ type: "tool", id: title + status, call: { toolCallId: title + status, title, status, ...(toolName ? { toolName } : {}) } }) as const;
    const items = [call("send", "completed", "mcp__flowcode__send_message"), call("Tool: flowcode/wait_for_reply", "completed"), call("flowcode/read_messages", "in_progress"), call("x", "failed", "mcp__flowcode__send_message")];
    const segments = buildTimeline(items);
    expect(segments).toHaveLength(1);
    expect(segments[0].type === "group" && segments[0].steps.map((s) => s.id)).toEqual(["xfailed"]);
  });
});

describe("peer message parsing", () => {
  it("parses the events and drops what is not a message", () => {
    expect(parsePeerIn({ msgId: "m-1", state: "queued", text: "x", from: { label: "a" }, forcedConsent: true })).toMatchObject({ forcedConsent: true, hops: 0, from: { label: "a" } });
    expect(parsePeerIn({ msgId: "m-1", state: "queued" })).toBeNull();
    expect(parsePeerOut({ msgId: "m-1", state: "failed", text: "x", to: {}, error: "too many" })).toMatchObject({ error: "too many", to: { label: "?" } });
  });

  it("is tolerant with frames", () => {
    expect(parsePeerFrame("hello")).toBeNull();
    expect(parsePeerFrame('<flowcode-message id="m-1">\nstill streaming')).toMatchObject({ msgId: "m-1", text: "still streaming", from: { label: "?" } });
    expect(parsePeerFrame('  <flowcode-message from="notes">\nx\n</flowcode-message>')?.from).toEqual({ label: "notes" });
    expect(firstLine("\n  first  \nsecond")).toBe("first");
    expect(firstLine("x".repeat(200), 10)).toHaveLength(10);
  });
});

describe("terminal message cards", () => {
  const inEv = (id: string, state: string) => ({ msgId: id, state, text: "t", from: { label: "api" } });
  it("keeps the latest state per message, seeds under live events and dismisses what no longer waits", () => {
    let state = applyTerminalPeer(EMPTY_TERMINAL_PEERS, PEER_IN_METHOD, inEv("m-1", "queued"));
    state = applyTerminalPeer(state, PEER_OUT_METHOD, { msgId: "m-2", state: "queued", text: "out", to: { label: "web" } });
    expect(unreadTerminalPeers(state)).toBe(1);
    state = seedTerminalPeers(state, [{ method: PEER_IN_METHOD, params: inEv("m-1", "pending_consent") }, { method: PEER_IN_METHOD, params: inEv("m-0", "delivered") }]);
    expect(state.incoming.map((p) => [p.msgId, p.state])).toEqual([["m-1", "queued"], ["m-0", "delivered"]]);
    state = dismissTerminalPeers(state);
    expect(shownTerminalPeers(state).incoming.map((p) => p.msgId)).toEqual(["m-1"]);
    expect(shownTerminalPeers(state).outgoing).toEqual([]);
    state = applyTerminalPeer(state, PEER_IN_METHOD, inEv("m-1", "delivered"));
    expect(unreadTerminalPeers(state)).toBe(0);
    expect(applyTerminalPeer(state, "_flowcode/open", {})).toBe(state);
  });
});
