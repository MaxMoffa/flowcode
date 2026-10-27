// SDK for Flowcode agent views (bridge protocol v1, see PLUGINS.md): the
// handshake, the event log folded into the chat model, and the requests. It is
// bundled by `npm run build:view-sdk` into one dependency-free ES module that
// plugins ship a copy of (docs/agent-views/sdk/flowcode-view.js).

import { applyEvent, initialChat, lineDiff, type ChatModelState } from "../../src/chat/chatModel";
import type { ChatEvent } from "../../src/chat/chatTypes";
import type { HostMessage, ViewStatus, ViewTheme } from "../../shared/agentViewBridge";

export { lineDiff };
export { renderMarkdown } from "./markdown";

const API_VERSION = 1;

export type ViewInit = Extract<HostMessage, { type: "init" }>;
type ViewPermission = ViewInit["permissions"][number];
export type ViewError = Extract<HostMessage, { type: "error" }>;

/** When an item of the model appeared (`start`) and last changed (`end`), in the
 * events' `at` (epoch ms). A finished tool call's duration is `end - start`. */
export interface ItemTiming {
  start: number;
  end: number;
}

interface ViewEvents {
  model: ChatModelState;
  status: ViewStatus;
  theme: ViewTheme;
  init: ViewInit;
  error: ViewError;
}

export interface ViewClient {
  readonly init: ViewInit;
  /** The conversation so far: every received event folded by `applyEvent`. */
  readonly model: ChatModelState;
  /** Timing of each model item, by item id. */
  readonly timing: ReadonlyMap<string, ItemTiming>;
  /** The last status message, null until the first arrives. */
  readonly status: ViewStatus | null;
  readonly theme: ViewTheme;
  /** `init` fires on a new conversation (the model is already reset). */
  on<K extends keyof ViewEvents>(type: K, listener: (value: ViewEvents[K]) => void): () => void;
  send(text: string): void;
  cancel(): void;
  setMode(modeId: string): void;
  /** Needs the `setModel` permission; `init.models` lists the choices. */
  setModel(modelId: string): void;
  openFile(path: string): void;
  switchView(viewId: string): void;
  /** Whether the host granted `permission` (the host enforces it anyway). */
  can(permission: ViewPermission): boolean;
}

/** The window to talk through; the page's own, unless a test provides one. */
interface ViewWindow {
  parent: Pick<Window, "postMessage">;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface ConnectOptions {
  window?: ViewWindow;
}

/** Says hello to the host, takes the port it answers with and resolves after the first `init`. */
export function connect({ window: win = window }: ConnectOptions = {}): Promise<ViewClient> {
  return new Promise((resolve) => {
    const listeners: { [K in keyof ViewEvents]: Set<(value: ViewEvents[K]) => void> } = {
      model: new Set(),
      status: new Set(),
      theme: new Set(),
      init: new Set(),
      error: new Set(),
    };
    const emit = <K extends keyof ViewEvents>(type: K, value: ViewEvents[K]) => {
      for (const listener of listeners[type]) listener(value);
    };

    let port: MessagePort | null = null;
    let init: ViewInit | null = null;
    let model = initialChat();
    let timing = new Map<string, ItemTiming>();
    let status: ViewStatus | null = null;
    let theme: ViewTheme | null = null;

    const request = (message: object) => port?.postMessage(message);

    const client: ViewClient = {
      get init() {
        return init!;
      },
      get model() {
        return model;
      },
      get timing() {
        return timing;
      },
      get status() {
        return status;
      },
      get theme() {
        return theme!;
      },
      on(type, listener) {
        const set = listeners[type] as Set<typeof listener>;
        set.add(listener);
        return () => void set.delete(listener);
      },
      send: (text) => request({ type: "send", text }),
      cancel: () => request({ type: "cancel" }),
      setMode: (modeId) => request({ type: "setMode", modeId }),
      setModel: (modelId) => request({ type: "setModel", modelId }),
      openFile: (path) => request({ type: "openFile", path }),
      switchView: (viewId) => request({ type: "switchView", viewId }),
      can: (permission) => init?.permissions.includes(permission) ?? false,
    };

    function applyEvents(events: ChatEvent[]) {
      for (const event of events) {
        const before = model.items;
        model = applyEvent(model, event);
        // Items are only appended or replaced in place, so index tells which changed.
        model.items.forEach((item, i) => {
          if (item === before[i]) return;
          const known = timing.get(item.id);
          timing.set(item.id, { start: known?.start ?? event.at, end: event.at });
        });
      }
      emit("model", model);
    }

    function onMessage(e: MessageEvent<HostMessage<ChatEvent>>) {
      const message = e.data;
      switch (message.type) {
        case "init": {
          // A new init is a new conversation.
          const first = init === null;
          // An older host sends no `models`.
          init = { ...message, models: message.models ?? null };
          model = initialChat();
          timing = new Map();
          status = null;
          theme = message.theme;
          if (first) resolve(client);
          else {
            emit("init", message);
            emit("model", model);
          }
          break;
        }
        case "events":
          applyEvents(message.events);
          break;
        case "status":
          // An older host sends no `currentModelId`.
          status = { status: message.status, queued: message.queued, currentModeId: message.currentModeId, currentModelId: message.currentModelId ?? null };
          emit("status", status);
          break;
        case "theme":
          theme = message.theme;
          emit("theme", message.theme);
          break;
        case "error":
          emit("error", message);
          break;
      }
    }

    function onConnect({ source, data, ports }: MessageEvent) {
      if (source !== win.parent || data?.type !== "flowcode:connect" || !ports[0]) return;
      win.removeEventListener("message", onConnect);
      port = ports[0];
      port.onmessage = onMessage;
    }

    win.addEventListener("message", onConnect);
    win.parent.postMessage({ type: "flowcode:hello", apiVersion: API_VERSION }, "*");
  });
}

/** Puts the theme's tokens on `root` as CSS variables and sets `color-scheme`. */
export function applyTheme(theme: ViewTheme, root: HTMLElement = document.documentElement) {
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
}
