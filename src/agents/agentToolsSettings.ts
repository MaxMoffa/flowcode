import { AGENT_CLIS, defaultCliStatus, type AgentCli } from "./cliInfo";
import { createStore } from "../lib/externalStore";
import { getBrowserSettings } from "../browser/browserSettings";
import { getExperimentalSettings } from "../settings/experimentalSettings";
import { invoke } from "@tauri-apps/api/core";
import { readBool, readEnum, readJson, readNumber, removeKey, writeBool, writeJson, writeString } from "../lib/storage";

/** A tab's answer to messages from other tabs' agents. */
export type MessagesAccept = "always" | "ask" | "never";
const ACCEPTS: readonly MessagesAccept[] = ["always", "ask", "never"];

/** What a chat's agent may do through Flowcode's own tools (its MCP server): opening pages in the browser panel, and handing tasks to other agents. Applies to chats started afterwards. */
export interface AgentToolsSettings {
  /** Master switch: off, no server reaches the agent at all. */
  enabled: boolean;
  open: boolean;
  /** `open_in_browser` goes through without a permission question. */
  openAutoAllow: boolean;
  /** `call_user`: the agent can get the user's attention with a bubble from its tab. */
  call: boolean;
  delegate: boolean;
  /** The agents a task may be delegated to; null = every one (the backend still checks each is installed). */
  delegateAgents: AgentCli[] | null;
  /** Delegated tasks running at once, per chat. */
  maxParallel: number;
  /** WSL terminal tabs start bash through Flowcode's startup file, so agents typed by hand get the tools too (their shims lead PATH). */
  shellIntegration: boolean;
  /** `send_message` & co.: agents in different tabs message each other (the target's consent, below, is the guard). */
  messages: boolean;
  /** What a tab that set nothing does when a message arrives. */
  messagesAccept: MessagesAccept;
}

export const MAX_PARALLEL_RANGE = { min: 1, max: 5 } as const;

const KEYS = {
  enabled: "flowcode.agentTools.enabled",
  open: "flowcode.agentTools.open",
  openAutoAllow: "flowcode.agentTools.openAutoAllow",
  call: "flowcode.agentTools.call",
  delegate: "flowcode.agentTools.delegate",
  delegateAgents: "flowcode.agentTools.delegateAgents",
  maxParallel: "flowcode.agentTools.maxParallel",
  shellIntegration: "flowcode.agentTools.shellIntegration",
  messages: "flowcode.agentTools.messages",
  messagesAccept: "flowcode.agentTools.messagesAccept",
} as const;

const isAgentList = (v: unknown): v is AgentCli[] => Array.isArray(v) && v.every((x) => (AGENT_CLIS as readonly unknown[]).includes(x));

function load(): AgentToolsSettings {
  return {
    enabled: readBool(KEYS.enabled, true),
    open: readBool(KEYS.open, true),
    openAutoAllow: readBool(KEYS.openAutoAllow, true),
    call: readBool(KEYS.call, true),
    delegate: readBool(KEYS.delegate, true),
    delegateAgents: readJson<AgentCli[] | null>(KEYS.delegateAgents, (v): v is AgentCli[] | null => v === null || isAgentList(v), null),
    maxParallel: Math.round(readNumber(KEYS.maxParallel, 3, MAX_PARALLEL_RANGE.min, MAX_PARALLEL_RANGE.max)),
    shellIntegration: readBool(KEYS.shellIntegration, true),
    messages: readBool(KEYS.messages, true),
    messagesAccept: readEnum(KEYS.messagesAccept, ACCEPTS, "ask"),
  };
}

// Settings flips it, the chat hook reads it when a chat starts, and they sit far apart in the tree.
const store = createStore<AgentToolsSettings>(load());

export const useAgentToolsSettings = store.use;

export function setAgentToolsSetting<K extends keyof AgentToolsSettings>(key: K, value: AgentToolsSettings[K]) {
  if (Object.is(store.get()[key], value)) return;
  if (key === "delegateAgents") {
    if (value === null) removeKey(KEYS.delegateAgents);
    else writeJson(KEYS.delegateAgents, value);
  } else if (key === "maxParallel") writeString(KEYS.maxParallel, String(value));
  else if (key === "messagesAccept") writeString(KEYS.messagesAccept, String(value));
  else writeBool(KEYS[key], value as boolean);
  store.update((s) => ({ ...s, [key]: value }));
  // Unlike the start-time tools, the backend reads these at every message: a change applies at once.
  if (key === "enabled" || key === "messages" || key === "messagesAccept") pushAgentMessagesConfig();
}

/** Tells the backend whether messages between agents are on and the default policy (`agent_messages_config`). */
export function pushAgentMessagesConfig() {
  const s = store.get();
  invoke("agent_messages_config", { enabled: s.enabled && s.messages, defaultAccept: s.messagesAccept }).catch(() => {});
}

/** The policy of tabs that set none, now. */
export const defaultMessagesAccept = (): MessagesAccept => store.get().messagesAccept;

/** The `tools` argument of `chat_start`: everything off when the master switch is, so the backend injects no server. */
export interface AgentToolsConfig {
  enabled: boolean;
  open: boolean;
  openAutoAllow: boolean;
  call: boolean;
  delegate: boolean;
  /** The `browser_*` tools (agent browser control): on unless the Browser setting says "off". */
  browserControl: boolean;
  delegateAgents: string[];
  maxParallel: number;
  shellIntegration: boolean;
  /** The message tools (`send_message`, `wait_for_reply`, `read_messages` in terminal tabs). */
  messages: boolean;
  /** The experimental ACP v2 setting: delegated children of a terminal tab inherit it (a chat's own protocol decides for its children). */
  acpV2: boolean;
}

/** `available`: the agents offered while the settings say "every one" (those installed and signed in); all of them when unknown. */
export function toolsConfig(s: AgentToolsSettings, available: readonly AgentCli[] = AGENT_CLIS): AgentToolsConfig {
  if (!s.enabled) return { enabled: false, open: false, openAutoAllow: false, call: false, delegate: false, browserControl: false, delegateAgents: [], maxParallel: s.maxParallel, shellIntegration: false, messages: false, acpV2: false };
  return { enabled: true, open: s.open, openAutoAllow: s.open && s.openAutoAllow, call: s.call, delegate: s.delegate, browserControl: getBrowserSettings().control !== "off", delegateAgents: s.delegate ? [...(s.delegateAgents ?? available)] : [], maxParallel: s.maxParallel, shellIntegration: s.shellIntegration, messages: s.messages, acpV2: getExperimentalSettings().acpV2 };
}

/** What a chat starting now gets (see `toolsConfig`). By default delegation offers the CLIs installed and signed in under the default profile (a failed check counts as available). */
export async function readAgentToolsConfig(): Promise<AgentToolsConfig> {
  const s = store.get();
  if (!s.enabled || !s.delegate || s.delegateAgents !== null) return toolsConfig(s);
  const ok = await Promise.all(AGENT_CLIS.map((cli) => defaultCliStatus(cli).then((st) => (st ? st.installed && st.logged_in : true), () => true)));
  return toolsConfig(s, AGENT_CLIS.filter((_, i) => ok[i]));
}

/** What a terminal tab starting now gets: no delegation there yet, so no need to check which agents are signed in. */
export function currentAgentToolsConfig(): AgentToolsConfig {
  return toolsConfig(store.get());
}
