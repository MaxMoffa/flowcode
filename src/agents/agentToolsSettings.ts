import { AGENT_CLIS, defaultCliStatus, type AgentCli } from "./cliInfo";
import { createStore } from "../lib/externalStore";
import { readBool, readJson, readNumber, removeKey, writeBool, writeJson, writeString } from "../lib/storage";

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
  else writeBool(KEYS[key], value as boolean);
  store.update((s) => ({ ...s, [key]: value }));
}

/** The `tools` argument of `chat_start`: everything off when the master switch is, so the backend injects no server. */
export interface AgentToolsConfig {
  enabled: boolean;
  open: boolean;
  openAutoAllow: boolean;
  call: boolean;
  delegate: boolean;
  delegateAgents: string[];
  maxParallel: number;
}

/** `available`: the agents offered while the settings say "every one" (those installed and signed in); all of them when unknown. */
export function toolsConfig(s: AgentToolsSettings, available: readonly AgentCli[] = AGENT_CLIS): AgentToolsConfig {
  if (!s.enabled) return { enabled: false, open: false, openAutoAllow: false, call: false, delegate: false, delegateAgents: [], maxParallel: s.maxParallel };
  return { enabled: true, open: s.open, openAutoAllow: s.open && s.openAutoAllow, call: s.call, delegate: s.delegate, delegateAgents: s.delegate ? [...(s.delegateAgents ?? available)] : [], maxParallel: s.maxParallel };
}

/** What a chat starting now gets (see `toolsConfig`). By default delegation offers the CLIs installed and signed in under the default profile (a failed check counts as available). */
export async function readAgentToolsConfig(): Promise<AgentToolsConfig> {
  const s = store.get();
  if (!s.enabled || !s.delegate || s.delegateAgents !== null) return toolsConfig(s);
  const ok = await Promise.all(AGENT_CLIS.map((cli) => defaultCliStatus(cli).then((st) => (st ? st.installed && st.logged_in : true), () => true)));
  return toolsConfig(s, AGENT_CLIS.filter((_, i) => ok[i]));
}
