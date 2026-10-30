/** Wire types of the chat mode: what the Rust side (an Agent Client Protocol
 * client, see the `chat_*` commands) hands the UI. */

type ChatToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
type ChatToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ChatToolContent =
  | { type: "content"; content: { type: string; text?: string; mimeType?: string; data?: string; uri?: string; flowcodeImageId?: string } }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

interface ChatToolLocation {
  path: string;
  line?: number | null;
}

/** A tool call as the agent reports it - `tool_call_update` carries any subset. */
export interface ChatToolCall {
  toolCallId: string;
  title?: string;
  kind?: ChatToolKind;
  status?: ChatToolStatus;
  content?: ChatToolContent[];
  locations?: ChatToolLocation[];
  rawInput?: unknown;
  /** Claude's ACP adapter (`_meta.claudeCode`): the Agent/Task call a subagent's tool call belongs to. */
  parentToolUseId?: string;
  /** Claude's ACP adapter (`_meta.claudeCode.toolName`): the SDK tool name, "Agent" or "Task" for a subagent launch. */
  toolName?: string;
  /** Subagent launches only: when the call first appeared and when it finished (event time, ms). */
  startedAt?: number;
  endedAt?: number;
}

export interface ChatPlanEntry {
  content: string;
  priority?: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ChatCommand {
  name: string;
  description?: string;
  input?: unknown;
}

interface ChatMode {
  id: string;
  name: string;
  description?: string;
}

export interface ChatModes {
  currentModeId: string;
  availableModes: ChatMode[];
}

export interface ChatModelOption {
  modelId: string;
  name: string;
  description?: string;
  /** The caption of the group it is listed under, when the agent groups its models. */
  group?: string;
}

/** The models the agent offers, normalized by the backend from either ACP API (`models` or the `model` config option). */
export interface ChatModels {
  currentModelId: string;
  availableModels: ChatModelOption[];
}

export interface ChatThoughtOption {
  id: string;
  name: string;
  description?: string;
}

/** The thinking levels the agent offers (its `thought_level` config option); they can change with the model. */
export interface ChatThought {
  currentId: string;
  available: ChatThoughtOption[];
}

export interface ChatPermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

/** The raw ACP `session/update` object; `sessionUpdate` says which one. */
export interface ChatUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

interface EventBase {
  seq: number;
  at: number;
}

export type ChatEvent =
  | (EventBase & { kind: "update"; update: ChatUpdate })
  | (EventBase & { kind: "user"; text: string; attachments?: string[]; images?: { name: string; mimeType: string; id: string }[] })
  | (EventBase & { kind: "permission"; requestId: string; toolCall: ChatToolCall; options: ChatPermissionOption[] })
  | (EventBase & { kind: "permissionResolved"; requestId: string; optionId: string | null })
  | (EventBase & { kind: "turnEnd"; stopReason: string })
  | (EventBase & { kind: "error"; message: string })
  | (EventBase & { kind: "exit"; code: number | null })
  | (EventBase & { kind: "ext"; method: string; params: unknown });

/** One image to show - exactly one of `id` (stored by the desktop, fetched by id), `path` (a file on the chat's PC, as written; resolved by the desktop against the chat's cwd/WSL), `url` (http(s) or data: url, used as is). */
export interface ChatImageRef {
  id?: string;
  path?: string;
  url?: string;
  mimeType?: string;
  name?: string;
}

/** A file sent with a prompt: its bytes (base64, no `data:` prefix) or a path on this PC. */
export interface ChatAttachment {
  name: string;
  mime: string;
  data?: string;
  path?: string;
}

/** What `chat_start` answers. */
export interface ChatStartResult {
  chatId: string;
  sessionId: string;
  agent: string;
  modes: ChatModes | null;
  models: ChatModels | null;
  thought?: ChatThought | null;
  configOptions: unknown;
  /** The session was resumed: its history arrives as events. */
  loaded: boolean;
  /** The WSL distro the agent runs in (its paths are Linux ones); null/absent for a Windows chat. */
  wslDistro?: string | null;
}

export type ChatStatus = "starting" | "idle" | "busy" | "waiting" | "exited";
