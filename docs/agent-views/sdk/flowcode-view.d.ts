// Typings of flowcode-view.js (ES module) and flowcode-view.iife.js (global
// `FlowcodeView`), the Flowcode agent-view SDK (bridge protocol v1).
// Written by hand next to index.ts: keep the two in step.

export type ViewPermission = "send" | "cancel" | "setMode" | "setModel" | "openFile";
export type ViewDevice = "desktop" | "tablet" | "phone";

export interface ViewTheme {
  scheme: "dark" | "light";
  /** CSS custom properties by name (`--fg`, `--accent`, ...). */
  tokens: Record<string, string>;
}

export interface ViewStatus {
  status: "starting" | "idle" | "busy" | "waiting" | "exited";
  /** Messages waiting for the agent's turn to end. */
  queued: string[];
  currentModeId: string | null;
  /** The model the agent uses, when it offers a choice (`init.models`). */
  currentModelId: string | null;
}

export interface ViewInit {
  type: "init";
  apiVersion: number;
  viewId: string;
  session: { agent: string; agentLabel: string; cwd: string; sessionId: string | null; title: string };
  modes: { currentModeId: string; availableModes: { id: string; name: string; description?: string }[] } | null;
  /** The models the agent offers; null when there is no choice. `group` is a caption for grouped lists. */
  models: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string; group?: string }[] } | null;
  permissions: ViewPermission[];
  /** "it" or "en". */
  locale: string;
  device: ViewDevice;
  /** Only where the screen has unsafe edges. */
  insets?: { top: number; right: number; bottom: number; left: number };
  theme: ViewTheme;
}

export interface ViewError {
  type: "error";
  code: "permission_denied" | "bad_request";
  /** The type of the refused request. */
  request: string;
}

export type ChatToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";

export type ChatToolContent =
  | { type: "content"; content: { type: string; text?: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export interface ChatToolCall {
  toolCallId: string;
  title?: string;
  kind?: ChatToolKind;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content?: ChatToolContent[];
  locations?: { path: string; line?: number | null }[];
  rawInput?: unknown;
}

export interface ChatPlanEntry {
  content: string;
  priority?: string;
  status: "pending" | "in_progress" | "completed";
}

export type ChatItem =
  | { type: "user"; id: string; text: string }
  | { type: "agent"; id: string; text: string }
  | { type: "thought"; id: string; text: string }
  | { type: "tool"; id: string; call: ChatToolCall }
  | {
      type: "permission";
      id: string;
      requestId: string;
      toolCall: ChatToolCall;
      options: { optionId: string; name: string; kind: string }[];
      /** Unset while it waits for an answer; the chosen option id after it, null if cancelled. */
      resolved?: string | null;
    }
  | { type: "error"; id: string; message: string }
  /** A turn that ended early (ACP stopReason: max_tokens, max_turn_requests, refusal, ...). */
  | { type: "stop"; id: string; reason: string };
// New item types may be added: a view should skip a `type` it doesn't know.

export interface ChatModelState {
  items: ChatItem[];
  plan: ChatPlanEntry[] | null;
  commands: { name: string; description?: string; input?: unknown }[];
  currentModeId: string | null;
  /** The model the agent last said it uses; null until it changes in this conversation (see `init.models`). */
  currentModelId: string | null;
  /** The models the agent offers as its events last said (`_flowcode/model`); null when it offers none, absent until an event says (then `init.models` holds). */
  models?: { currentModelId: string; availableModels: { modelId: string; name: string; description?: string; group?: string }[] } | null;
  status: "starting" | "idle" | "busy" | "waiting" | "exited";
  lastSeq: number;
  turnActive: boolean;
}

export interface DiffRow {
  type: "ctx" | "add" | "del";
  text: string;
}

/** When an item of the model appeared (`start`) and last changed (`end`), epoch ms. */
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
  readonly model: ChatModelState;
  readonly timing: ReadonlyMap<string, ItemTiming>;
  readonly status: ViewStatus | null;
  readonly theme: ViewTheme;
  on<K extends keyof ViewEvents>(type: K, listener: (value: ViewEvents[K]) => void): () => void;
  send(text: string): void;
  cancel(): void;
  setMode(modeId: string): void;
  /** Needs the `setModel` permission; applies from the next message if a turn runs. */
  setModel(modelId: string): void;
  openFile(path: string): void;
  switchView(viewId: string): void;
  can(permission: ViewPermission): boolean;
}

export interface ConnectOptions {
  window?: {
    parent: { postMessage(message: unknown, targetOrigin: string): void };
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  };
}

export function connect(options?: ConnectOptions): Promise<ViewClient>;
export function applyTheme(theme: ViewTheme, root?: HTMLElement): void;
export function lineDiff(oldText: string | null, newText: string): DiffRow[];
/** A light markdown subset (fenced code, `code`, **bold**, "- " bullets, line
 * breaks, links) as DOM nodes built with createElement/textContent. Links are
 * `span.md-link` with the address in `title`: a view can't open anything. */
export function renderMarkdown(text: string, doc?: Document): DocumentFragment;

export as namespace FlowcodeView;
