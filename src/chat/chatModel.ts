import type {
  ChatCommand,
  ChatEvent,
  ChatModelOption,
  ChatModels,
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
  /** `local`: raised here (a send or an answer the backend refused), not an event of the agent's stream. */
  | { type: "error"; id: string; message: string; local?: boolean }
  /** A turn that ended for another reason than finishing or being cancelled (ACP `stopReason`: `max_tokens`, `max_turn_requests`, `refusal`, ...). */
  | { type: "stop"; id: string; reason: string };

export interface ChatModelState {
  items: ChatItem[];
  plan: ChatPlanEntry[] | null;
  commands: ChatCommand[];
  currentModeId: string | null;
  /** The model the agent last said it uses (a `_flowcode/model` event or a `config_option_update`); null until then. */
  currentModelId: string | null;
  /** The models the agent offers, as its events last said (a `_flowcode/model` event, or a `config_option_update` with a model option): null when it offers none, undefined until an event says (the ones announced at the start hold). */
  models?: ChatModels | null;
  status: ChatStatus;
  /** Highest event `seq` applied - replayed and live events never apply twice. */
  lastSeq: number;
  /** A turn is running (from the user's message to `turnEnd`). */
  turnActive: boolean;
  /** What the agent last said about itself (e.g. it is retrying a rate limit); cleared by the next real progress. */
  notice: { kind: "retrying"; category: string; detail: string } | null;
  /** The running turn: when it started (event time, ms) and how much text the agent streamed in it, for the "thinking" line. Null between turns. */
  turn: { startedAt: number; outChars: number } | null;
}

export function initialChat(): ChatModelState {
  return { items: [], plan: null, commands: [], currentModeId: null, currentModelId: null, status: "starting", lastSeq: -1, turnActive: false, notice: null, turn: null };
}

/** The backend's event saying the chat's model changed (params: the normalized `ChatModels`). */
export const MODEL_EXT_METHOD = "_flowcode/model";

/** The current value of the model option among ACP session config options (category `model`, else id `model`); null without one. */
export function configModelValue(configOptions: unknown): string | null {
  if (!Array.isArray(configOptions)) return null;
  const options = configOptions.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null);
  const option = options.find((o) => o.category === "model") ?? options.find((o) => o.id === "model");
  return option && typeof option.currentValue === "string" && option.currentValue !== "" ? option.currentValue : null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** The backend's normalized models (`{ currentModelId, availableModels }`, the `_flowcode/model` params and `ChatInfo.models`), checked; null when there are none (`availableModels: []` = the agent offers no choice any more). */
export function normalizeModels(raw: unknown): ChatModels | null {
  const m = raw as Partial<ChatModels> | null | undefined;
  if (!m || typeof m !== "object" || !Array.isArray(m.availableModels)) return null;
  const availableModels = m.availableModels.filter(
    (x): x is ChatModelOption => !!x && typeof x.modelId === "string" && x.modelId !== "" && typeof x.name === "string",
  );
  if (availableModels.length === 0) return null;
  return { currentModelId: str(m.currentModelId) ?? availableModels[0].modelId, availableModels };
}

/** The models of ACP session config options, like the backend reads them: the `select` option of category `model` (else id `model`), its choices flat or grouped (the group's name as caption). Null without one. */
export function configModels(configOptions: unknown): ChatModels | null {
  if (!Array.isArray(configOptions)) return null;
  const options = configOptions.filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null);
  const option = options.find((o) => o.category === "model") ?? options.find((o) => o.id === "model");
  if (!option || (typeof option.type === "string" && option.type !== "select")) return null;
  const currentModelId = str(option.currentValue);
  if (!currentModelId || !Array.isArray(option.options)) return null;
  const choice = (v: unknown, group: string | null): ChatModelOption[] => {
    const o = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
    const modelId = str(o.value);
    if (!modelId) return [];
    const description = str(o.description);
    return [{ modelId, name: str(o.name) ?? modelId, ...(description ? { description } : {}), ...(group ? { group } : {}) }];
  };
  const availableModels = (option.options as unknown[]).flatMap((entry) => {
    const e = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    return Array.isArray(e.options) ? e.options.flatMap((v) => choice(v, str(e.name) ?? str(e.group))) : choice(entry, null);
  });
  return availableModels.length > 0 ? { currentModelId, availableModels } : null;
}

/** The announced models with the live current one (from events) over the announced one; null when there is no choice to make (fewer than two models). */
export function liveModels(models: ChatModels | null | undefined, currentModelId: string | null): ChatModels | null {
  if (!models || models.availableModels.length < 2) return null;
  return currentModelId && currentModelId !== models.currentModelId ? { ...models, currentModelId } : models;
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
  return { ...state, turnActive: false, turn: null, status: statusOf(state.items, false, "idle") };
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
  // Only a `user` event (a prompt sent from here) starts a turn: replayed
  // history streams the same chunks with no turn running, and treating them as
  // one left a resumed chat "busy" until a turnEnd that never comes.
  return withItems(state, items);
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
  // Like text: a tool call alone (replayed history) doesn't start a turn.
  return withItems(state, items);
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
      return { ...state, plan: (update.entries as ChatPlanEntry[]) ?? [] };
    case "available_commands_update":
      return { ...state, commands: (update.availableCommands as ChatCommand[]) ?? [] };
    case "current_mode_update":
      return { ...state, currentModeId: (update.currentModeId as string) ?? state.currentModeId };
    case "config_option_update": {
      const modelId = configModelValue(update.configOptions);
      // The list too when the option carries it (the backend's `_flowcode/model` that follows says the same).
      const models = configModels(update.configOptions);
      if (modelId === null || (modelId === state.currentModelId && !models)) return state;
      return { ...state, currentModelId: modelId, ...(models ? { models } : {}) };
    }
    default:
      return state;
  }
}

/** Keeps the turn stats after an update: a turn joined mid-way (a phone opening a busy chat) starts at this event, and streamed text counts toward it. */
function trackTurn(next: ChatModelState, update: ChatUpdate, at: number): ChatModelState {
  let turn = next.turn;
  if (!turn && next.turnActive) turn = { startedAt: at, outChars: 0 };
  if (turn && (update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")) {
    turn = { ...turn, outChars: turn.outChars + (textOf(update)?.length ?? 0) };
  }
  return turn === next.turn ? next : { ...next, turn };
}

function reduce(state: ChatModelState, ev: ChatEvent): ChatModelState {
  switch (ev.kind) {
    case "update": {
      const next = applyUpdate(state, ev.update, ev.seq);
      return trackTurn(PROGRESS_UPDATES.has(ev.update.sessionUpdate) ? { ...next, notice: null } : next, ev.update, ev.at);
    }
    case "ext": {
      if (ev.method === MODEL_EXT_METHOD) {
        const params = (ev.params ?? {}) as Record<string, unknown>;
        if (!Array.isArray(params.availableModels) && str(params.currentModelId) === null) return state;
        // Normalized by the backend: the whole list, `availableModels: []` when the agent offers none any more.
        const models = Array.isArray(params.availableModels) ? normalizeModels(params) : state.models;
        return { ...state, models, currentModelId: str(params.currentModelId) ?? state.currentModelId };
      }
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
      return {
        ...withItems(state, [...state.items, { type: "user", id: `user-${ev.seq}`, text: ev.text, local: true }], true),
        turn: { startedAt: ev.at, outChars: 0 },
      };
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
    case "turnEnd": {
      // Finishing and a cancel the user asked for need no word; anything else (a length or step limit, a refusal) is said.
      const reason = typeof ev.stopReason === "string" ? ev.stopReason : "";
      const items = !reason || QUIET_STOPS.has(reason) ? state.items : [...state.items, { type: "stop" as const, id: `stop-${ev.seq}`, reason }];
      return { ...withItems(state, items, false), notice: null, turn: null };
    }
    case "error": {
      // The same failure already shown from the refused call (the backend reports it both ways, in either order): shown once.
      const last = state.items[state.items.length - 1];
      const dup = last?.type === "error" && last.local && last.message === ev.message;
      return {
        ...withItems(state, dup ? state.items : [...state.items, { type: "error", id: `error-${ev.seq}`, message: ev.message }], false),
        notice: null,
        turn: null,
      };
    }
    case "exit": {
      // Nobody is left to answer an open permission request: it reads as cancelled (the backend says so too, this is in case it didn't).
      const items = state.items.some((i) => i.type === "permission" && i.resolved === undefined)
        ? state.items.map((i) => (i.type === "permission" && i.resolved === undefined ? { ...i, resolved: null } : i))
        : state.items;
      return { ...state, items, turnActive: false, status: "exited", notice: null, turn: null };
    }
    default:
      // A kind added by a newer desktop: an older phone or view plugin must not break on it.
      return state;
  }
}

/** Stop reasons that need no notice: the turn finished, or the user cancelled it. */
const QUIET_STOPS = new Set(["end_turn", "cancelled"]);

/** How a `stop` item reads: one of the ACP stop reasons the UI words, or "other" (shown with the raw reason). */
export type StopKind = "maxTokens" | "maxTurnRequests" | "refusal" | "other";

export function stopKind(reason: string): StopKind {
  switch (reason) {
    case "max_tokens":
      return "maxTokens";
    case "max_turn_requests":
      return "maxTurnRequests";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** Folds one event into the conversation. Pure: the same events in the same
 * order always give the same state, and one already applied (by `seq`) is skipped. */
export function applyEvent(state: ChatModelState, ev: ChatEvent): ChatModelState {
  if (ev.seq <= state.lastSeq) return state;
  return { ...reduce(state, ev), lastSeq: ev.seq };
}

/** An error raised here rather than by the agent (a send or answer the backend
 * refused). It is not an event: `lastSeq` is left alone, so the backend's next
 * events are never mistaken for already applied. Shown once if the same error
 * is the last thing in the conversation. */
export function applyLocalError(state: ChatModelState, message: string): ChatModelState {
  const last = state.items[state.items.length - 1];
  if (last?.type === "error" && last.message === message) return state;
  // A client may drop the oldest items (see shared/remoteChatSession.ts), so the count alone could repeat: a running number keeps the id unique.
  return withItems(state, [...state.items, { type: "error", id: `error-local-${++localErrors}`, message, local: true }]);
}
let localErrors = 0;

/** The backend refused a prompt because the agent is still working on a turn: the message wasn't sent and should wait for the next idle. */
export const isAgentBusy = (message: string): boolean => message.startsWith("agent_busy");

/** The backend refused a prompt because the agent process is gone. */
export const isAgentExited = (message: string): boolean => message.startsWith("agent_exited");

/**
 * The events to fold when a chat starts: its replay (`chat_events`) and what
 * the live listener caught meanwhile, in `seq` order and each once. Applying
 * the live ones first would raise `lastSeq` past the replay, which would then
 * be skipped as already applied - the whole resumed history lost. The replay
 * is authoritative up to its last `seq`: the backend's log merges runs of
 * text chunks into one entry carrying the last chunk's `seq`, so a live
 * chunk below it is already inside that entry - only newer live events count.
 */
export function mergeReplay(past: ChatEvent[], live: ChatEvent[]): ChatEvent[] {
  const bySeq = new Map<number, ChatEvent>();
  for (const ev of past) if (!bySeq.has(ev.seq)) bySeq.set(ev.seq, ev);
  const maxPast = past.reduce((max, ev) => Math.max(max, ev.seq), -Infinity);
  for (const ev of live) if (ev.seq > maxPast && !bySeq.has(ev.seq)) bySeq.set(ev.seq, ev);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** "Send now" interrupts the agent when a turn runs, or when the last prompt is still on its way (sent, its turn not started yet): otherwise the forced one would be refused as busy behind it. */
export const forceCancels = (status: ChatStatus, promptInFlight: boolean): boolean => status === "busy" || status === "waiting" || promptInFlight;

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
