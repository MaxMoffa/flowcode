/** Wire types of the chat mode: what the Rust side (an Agent Client Protocol
 * client, see the `chat_*` commands) hands the UI. */

type ChatToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
type ChatToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type ChatToolContent =
  | { type: "content"; content: { type: string; text?: string } }
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
  | (EventBase & { kind: "user"; text: string })
  | (EventBase & { kind: "permission"; requestId: string; toolCall: ChatToolCall; options: ChatPermissionOption[] })
  | (EventBase & { kind: "permissionResolved"; requestId: string; optionId: string | null })
  | (EventBase & { kind: "turnEnd"; stopReason: string })
  | (EventBase & { kind: "error"; message: string })
  | (EventBase & { kind: "exit"; code: number | null })
  | (EventBase & { kind: "ext"; method: string; params: unknown });

/** What `chat_start` answers. */
export interface ChatStartResult {
  chatId: string;
  sessionId: string;
  agent: string;
  modes: ChatModes | null;
  configOptions: unknown;
  /** The session was resumed: its history arrives as events. */
  loaded: boolean;
}

export type ChatStatus = "starting" | "idle" | "busy" | "waiting" | "exited";
