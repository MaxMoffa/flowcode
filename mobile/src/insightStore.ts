// The agent panel's data: what the desktop answers to `agentinsight`, kept per terminal / chat and refreshed while the panel is open.
import { useEffect } from "react";
import type { AgentSessionUsage, AgentToolsInfo } from "../../shared/remote-types";
import { onMessage, send, useSupports } from "./remote";
import { createStore } from "./store";

export interface AgentInsightReply {
  cli?: string | null;
  context?: { used: number; window: number; model?: string } | null;
  usage?: AgentSessionUsage | null;
  tools?: AgentToolsInfo | null;
}

export type InsightTarget = { ptyId: string; chatId?: undefined } | { chatId: string; ptyId?: undefined };

const POLL_MS = 10_000;

const store = createStore<{ replies: Record<string, AgentInsightReply> }>({ replies: {} });

/** Stores a reply under the key the desktop echoed. */
/** @internal exported for tests */
export function storeInsight(key: string, reply: AgentInsightReply) {
  const next = { ...store.get().replies };
  delete next[key];
  next[key] = reply;
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - MAX_REPLIES; i++) delete next[keys[i]];
  store.set({ replies: next });
}

/** Replies kept; the oldest go first. */
const MAX_REPLIES = 50;
/** The desktop the replies came from. */
let lastHost: string | undefined;

/** @internal exported for tests */
export const getInsight = (key: string): AgentInsightReply | undefined => store.get().replies[key];

/** @internal exported for tests */
export function insightKey(target: InsightTarget): string {
  return target.chatId ?? target.ptyId ?? "";
}

/** Asks the desktop for a terminal's or a chat's agent insight (answered with `agentinsight`). */
function requestAgentInsight(target: InsightTarget) {
  send(target.chatId ? { t: "agentinsight", chatId: target.chatId } : { t: "agentinsight", ptyId: target.ptyId });
}

/** The last reply for the target, asked now and every 10 s while `enabled`; undefined until it comes (or on a desktop without the feature). */
export function useAgentInsight(target: InsightTarget, enabled: boolean): AgentInsightReply | undefined {
  const supported = useSupports("agentInsight");
  const key = insightKey(target);
  const reply = store.useSelector((s) => s.replies[key]);
  useEffect(() => {
    if (!enabled || !supported || !key) return;
    const ask = () => requestAgentInsight(target.chatId ? { chatId: key } : { ptyId: key });
    ask();
    const id = setInterval(ask, POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, supported, key, !!target.chatId]);
  return reply;
}

onMessage((m) => {
  if (m.t === "ready" && m.hostName !== lastHost) {
    lastHost = m.hostName;
    store.set({ replies: {} });
  }
  if (m.t === "agentinsight") storeInsight(m.key, { cli: m.cli, context: m.context, usage: m.usage, tools: m.tools });
});
