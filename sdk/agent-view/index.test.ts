import { describe, expect, it } from "vitest";
import type { ChatEvent } from "../../src/chat/chatTypes";
import type { HostMessage } from "../../shared/agentViewBridge";
import { applyTheme, connect, type ViewClient } from "./index";

const theme = { scheme: "dark" as const, tokens: { "--fg": "#eee", "--accent": "#09f" } };
const init = (permissions: ("send" | "cancel" | "setMode" | "setModel" | "openFile")[] = ["send"]): HostMessage<ChatEvent> => ({
  type: "init",
  apiVersion: 1,
  viewId: "test",
  session: { agent: "claude", agentLabel: "Claude", cwd: "/p", sessionId: null, title: "t" },
  modes: null,
  models: null,
  permissions,
  locale: "it",
  device: "desktop",
  theme,
});
const user = (seq: number, text: string): ChatEvent => ({ kind: "user", seq, at: 1000 + seq, text });
const chunk = (seq: number, text: string): ChatEvent => ({
  kind: "update",
  seq,
  at: 1000 + seq,
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const toolCall = (seq: number, status: string): ChatEvent => ({
  kind: "update",
  seq,
  at: 1000 + seq,
  update: { sessionUpdate: seq === 1 ? "tool_call" : "tool_call_update", toolCallId: "t1", title: "Read", kind: "read", status },
});

/** A fake host: the view's window and parent, and the host's end of the channel. */
function setup() {
  let listener: ((e: MessageEvent) => void) | null = null;
  const sent: unknown[] = [];
  const host = new MessageChannel();
  const requests: unknown[] = [];
  host.port1.onmessage = (e) => requests.push(e.data);
  const parent = {
    postMessage(message: unknown) {
      sent.push(message);
      // The host answers the hello with the connect message and its port.
      queueMicrotask(() => listener?.({ source: parent, data: { type: "flowcode:connect", apiVersion: 1 }, ports: [host.port2] } as unknown as MessageEvent));
    },
  };
  const win = {
    parent,
    addEventListener: (_type: string, l: (e: MessageEvent) => void) => void (listener = l),
    removeEventListener: () => void (listener = null),
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  const post = async (message: HostMessage<ChatEvent>) => {
    host.port1.postMessage(message);
    await tick();
  };
  return { win, sent, requests, post, tick, close: () => (host.port1.close(), host.port2.close()) };
}

async function start(permissions?: ("send" | "cancel" | "setMode" | "setModel" | "openFile")[]) {
  const s = setup();
  const pending = connect({ window: s.win });
  await s.tick();
  await s.post(init(permissions));
  const client: ViewClient = await pending;
  return { ...s, client };
}

describe("agent view SDK", () => {
  it("says hello, takes the port and resolves after init", async () => {
    const { client, sent, close } = await start();
    expect(sent).toEqual([{ type: "flowcode:hello", apiVersion: 1 }]);
    expect(client.init.viewId).toBe("test");
    expect(client.theme).toEqual(theme);
    expect(client.status).toBeNull();
    close();
  });

  it("folds replayed and live events into the model, with timing", async () => {
    const { client, post, close } = await start();
    let notified = 0;
    client.on("model", () => notified++);
    await post({ type: "events", events: [user(0, "ciao"), chunk(1, "Ok "), chunk(2, "fatto"), toolCall(3, "in_progress")] });
    await post({ type: "events", events: [toolCall(4, "completed"), chunk(2, "dup")] });
    expect(client.model.items.map((i) => i.type)).toEqual(["user", "agent", "tool"]);
    expect(client.model.items[1]).toMatchObject({ text: "Ok fatto" });
    expect(notified).toBe(2);
    expect(client.timing.get(client.model.items[2].id)).toEqual({ start: 1003, end: 1004 });
    expect(client.timing.get(client.model.items[1].id)).toEqual({ start: 1001, end: 1002 });
    close();
  });

  it("keeps the last status and theme and tells the listeners", async () => {
    const { client, post, close } = await start();
    const seen: string[] = [];
    const off = client.on("status", (s) => seen.push(s.status));
    client.on("theme", (t) => seen.push(t.scheme));
    await post({ type: "status", status: "busy", queued: ["a"], currentModeId: null, currentModelId: null });
    await post({ type: "theme", theme: { scheme: "light", tokens: {} } });
    off();
    await post({ type: "status", status: "idle", queued: [], currentModeId: null, currentModelId: null });
    expect(seen).toEqual(["busy", "light"]);
    expect(client.status).toEqual({ status: "idle", queued: [], currentModeId: null, currentModelId: null });
    expect(client.theme.scheme).toBe("light");
    close();
  });

  it("gates requests with can() and sends the granted ones", async () => {
    const { client, requests, tick, close } = await start(["send", "openFile"]);
    expect(client.can("send")).toBe(true);
    expect(client.can("cancel")).toBe(false);
    client.send("hi");
    client.openFile("a.ts");
    client.cancel();
    client.setMode("plan");
    client.setModel("opus");
    client.switchView("chat");
    await tick();
    expect(requests).toEqual([
      { type: "send", text: "hi" },
      { type: "openFile", path: "a.ts" },
      { type: "cancel" },
      { type: "setMode", modeId: "plan" },
      { type: "setModel", modelId: "opus" },
      { type: "switchView", viewId: "chat" },
    ]);
    close();
  });

  it("passes the host's errors on", async () => {
    const { client, post, close } = await start();
    const errors: string[] = [];
    client.on("error", (e) => errors.push(`${e.code}:${e.request}`));
    await post({ type: "error", code: "permission_denied", request: "cancel" });
    expect(errors).toEqual(["permission_denied:cancel"]);
    close();
  });

  it("resets the model on a new init", async () => {
    const { client, post, close } = await start(["send"]);
    await post({ type: "events", events: [user(0, "ciao")] });
    await post({ type: "status", status: "busy", queued: [], currentModeId: null, currentModelId: null });
    const seen: number[] = [];
    client.on("init", () => seen.push(client.model.items.length));
    await post(init(["cancel"]));
    expect(seen).toEqual([0]);
    expect(client.model.items).toEqual([]);
    expect(client.timing.size).toBe(0);
    expect(client.status).toBeNull();
    expect(client.can("cancel")).toBe(true);
    expect(client.can("send")).toBe(false);
    // The log starts over: seq 0 applies again.
    await post({ type: "events", events: [user(0, "nuova")] });
    expect(client.model.items).toMatchObject([{ text: "nuova" }]);
    close();
  });

  it("applies the theme as CSS variables and color-scheme", () => {
    const style = new Map<string, string>();
    const root = { style: { setProperty: (k: string, v: string) => style.set(k, v), colorScheme: "" } } as unknown as HTMLElement;
    applyTheme(theme, root);
    expect(Object.fromEntries(style)).toEqual(theme.tokens);
    expect(root.style.colorScheme).toBe("dark");
  });
});
