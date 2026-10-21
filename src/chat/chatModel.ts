import type {
  ChatCommand,
  ChatEvent,
  ChatPermissionOption,
  ChatPlanEntry,
  ChatStatus,
  ChatToolCall,
  ChatUpdate,
} from "./chatTypes";

/** One thing in the conversation, in the order it happened. */
export type ChatItem =
  /** `local`: sent from this app (a `user` event), as opposed to history the agent replayed. */
  | { type: "user"; id: string; text: string; local?: boolean }
  | { type: "agent"; id: string; text: string }
  | { type: "thought"; id: string; text: string }
  | { type: "tool"; id: string; call: ChatToolCall }
  | {
      type: "permission";
      id: string;
      requestId: string;
      toolCall: ChatToolCall;
      options: ChatPermissionOption[];
      /** Unset while it waits for an answer; the chosen option id after it, null if cancelled. */
      resolved?: string | null;
    }
  | { type: "error"; id: string; message: string };

export interface ChatModelState {
  items: ChatItem[];
  plan: ChatPlanEntry[] | null;
  commands: ChatCommand[];
  currentModeId: string | null;
  status: ChatStatus;
  /** Highest event `seq` applied - replayed and live events never apply twice. */
  lastSeq: number;
  /** A turn is running (from the user's message to `turnEnd`). */
  turnActive: boolean;
  /** What the agent last said about itself (e.g. it is retrying a rate limit); cleared by the next real progress. */
  notice: { kind: "retrying"; category: string; detail: string } | null;
}

export function initialChat(): ChatModelState {
  return { items: [], plan: null, commands: [], currentModeId: null, status: "starting", lastSeq: -1, turnActive: false, notice: null };
}

/** Updates that show the agent is making progress again, so a notice is stale. */
const PROGRESS_UPDATES = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]);

function statusOf(items: ChatItem[], turnActive: boolean, current: ChatStatus): ChatStatus {
  if (current === "exited" || current === "starting") return current;
  if (items.some((i) => i.type === "permission" && i.resolved === undefined)) return "waiting";
  return turnActive ? "busy" : "idle";
}

function withItems(state: ChatModelState, items: ChatItem[], turnActive = state.turnActive): ChatModelState {
  return { ...state, items, turnActive, status: statusOf(items, turnActive, state.status) };
}

/** The agent is up: leaves "starting", and treats a turn that was only the
 * replay of a resumed session's history as over. */
export function settleChat(state: ChatModelState): ChatModelState {
  if (state.status === "exited") return state;
  return { ...state, turnActive: false, status: statusOf(state.items, false, "idle") };
}

/** Appends `text` to the last item when it has `type`, else starts a new one. */
function appendText(state: ChatModelState, type: "user" | "agent" | "thought", text: string, seq: number): ChatModelState {
  const last = state.items[state.items.length - 1];
  // Some agents (Vibe) echo the prompt back as user chunks: already shown.
  if (type === "user" && last?.type === "user" && last.local) return state;
  const items =
    last && last.type === type
      ? [...state.items.slice(0, -1), { ...last, text: last.text + text }]
      : [...state.items, { type, id: `${type}-${seq}`, text }];
  // A user chunk is history being replayed, not a turn starting.
  return withItems(state, items, type === "user" ? state.turnActive : true);
}

function textOf(update: ChatUpdate): string | null {
  const content = update.content as { type?: string; text?: string } | undefined;
  return content?.type === "text" && typeof content.text === "string" ? content.text : null;
}

function upsertTool(state: ChatModelState, patch: ChatToolCall): ChatModelState {
  const index = state.items.findIndex((i) => i.type === "tool" && i.id === patch.toolCallId);
  const items = [...state.items];
  if (index < 0) {
    items.push({ type: "tool", id: patch.toolCallId, call: patch });
  } else {
    const prev = items[index] as Extract<ChatItem, { type: "tool" }>;
    const merged = { ...prev.call } as Record<string, unknown>;
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
    items[index] = { ...prev, call: merged as unknown as ChatToolCall };
  }
  return withItems(state, items, true);
}

function applyUpdate(state: ChatModelState, update: ChatUpdate, seq: number): ChatModelState {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      const text = textOf(update);
      if (text === null) return state;
      const type = update.sessionUpdate === "user_message_chunk" ? "user" : update.sessionUpdate === "agent_message_chunk" ? "agent" : "thought";
      return appendText(state, type, text, seq);
    }
    case "tool_call":
    case "tool_call_update":
      return upsertTool(state, update as unknown as ChatToolCall);
    case "plan":
      return { ...state, plan: (update.entries as ChatPlanEntry[]) ?? [], turnActive: true, status: statusOf(state.items, true, state.status) };
    case "available_commands_update":
      return { ...state, commands: (update.availableCommands as ChatCommand[]) ?? [] };
    case "current_mode_update":
      return { ...state, currentModeId: (update.currentModeId as string) ?? state.currentModeId };
    default:
      return state;
  }
}

function reduce(state: ChatModelState, ev: ChatEvent): ChatModelState {
  switch (ev.kind) {
    case "update": {
      const next = applyUpdate(state, ev.update, ev.seq);
      return PROGRESS_UPDATES.has(ev.update.sessionUpdate) ? { ...next, notice: null } : next;
    }
    case "ext": {
      // A retry reported after the turn ended (e.g. it was cancelled) is stale.
      if (ev.method !== "_session/retrying" || !state.turnActive) return state;
      const params = (ev.params ?? {}) as Record<string, unknown>;
      return {
        ...state,
        notice: {
          kind: "retrying",
          category: typeof params.category === "string" ? params.category : "",
          detail: typeof params.detail === "string" ? params.detail : "",
        },
      };
    }
    case "user":
      return withItems(state, [...state.items, { type: "user", id: `user-${ev.seq}`, text: ev.text, local: true }], true);
    case "permission":
      return withItems(state, [
        ...state.items,
        { type: "permission", id: `perm-${ev.requestId}`, requestId: ev.requestId, toolCall: ev.toolCall, options: ev.options },
      ]);
    case "permissionResolved":
      return withItems(
        state,
        state.items.map((i) => (i.type === "permission" && i.requestId === ev.requestId ? { ...i, resolved: ev.optionId } : i)),
      );
    case "turnEnd":
      return { ...withItems(state, state.items, false), notice: null };
    case "error":
      return {
        ...withItems(state, [...state.items, { type: "error", id: `error-${ev.seq}`, message: ev.message }], false),
        notice: null,
      };
    case "exit":
      return { ...state, turnActive: false, status: "exited", notice: null };
    default:
      // A kind added by a newer desktop: an older phone or view plugin must not break on it.
      return state;
  }
}

/** Folds one event into the conversation. Pure: the same events in the same
 * order always give the same state, and one already applied (by `seq`) is skipped. */
export function applyEvent(state: ChatModelState, ev: ChatEvent): ChatModelState {
  if (ev.seq <= state.lastSeq) return state;
  return { ...reduce(state, ev), lastSeq: ev.seq };
}

export interface DiffRow {
  type: "ctx" | "add" | "del";
  text: string;
}

const DIFF_MAX_LINES = 400;
const DIFF_FALLBACK_LINES = 200;

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Line diff by longest common subsequence. Past 400 lines on either side it
 * gives up on matching and lists the first 200 new lines as additions. */
export function lineDiff(oldText: string | null, newText: string): DiffRow[] {
  const a = splitLines(oldText ?? "");
  const b = splitLines(newText);
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return b.slice(0, DIFF_FALLBACK_LINES).map((text) => ({ type: "add", text }));
  }
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      rows.push({ type: "del", text: a[i++] });
    } else {
      rows.push({ type: "add", text: b[j++] });
    }
  }
  while (i < a.length) rows.push({ type: "del", text: a[i++] });
  while (j < b.length) rows.push({ type: "add", text: b[j++] });
  return rows;
}
