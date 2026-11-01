import type { ChatEvent } from "./chatTypes";

/** How long a chat can sit idle before the provider's prompt cache (Anthropic's default TTL: 5 minutes) is likely gone. */
export const CACHE_IDLE_MS = 5 * 60_000;

/** Below this context size (tokens, from the agent's `usage_update`) re-reading the conversation is cheap: no warning. */
export const CACHE_MIN_TOKENS = 40_000;

/** Without a usage figure, a conversation needs at least this many items (with a user message) to be worth warning about. */
export const CACHE_MIN_ITEMS = 4;

/** When the chat last did anything (event time, ms) and the context size the agent last reported; null when unknown. */
export interface ChatActivity {
  at: number | null;
  tokens: number | null;
}

export const NO_ACTIVITY: ChatActivity = { at: null, tokens: null };

/** The activity after one more event: its time, and the context size when it is a `usage_update`. */
export function trackActivity(prev: ChatActivity, ev: ChatEvent): ChatActivity {
  const at = prev.at === null || ev.at > prev.at ? ev.at : prev.at;
  let tokens = prev.tokens;
  if (ev.kind === "update" && ev.update.sessionUpdate === "usage_update") {
    const used = (ev.update as Record<string, unknown>).used;
    if (typeof used === "number" && Number.isFinite(used)) tokens = used;
  }
  return at === prev.at && tokens === prev.tokens ? prev : { at, tokens };
}

/**
 * The activity of a resumed chat once its history replayed: the replayed events all carry the load time, not the
 * time things happened, so the time is the one known from before (`knownAt`); unknown stays unknown (null), so no
 * notice until something real says when the chat last worked. The context size still comes from the replay.
 */
export function resumedActivity(replayed: ChatActivity, knownAt: number | undefined): ChatActivity {
  return { at: knownAt ?? null, tokens: replayed.tokens };
}

/** The activity of a whole list of events. */
export function eventsActivity(events: ChatEvent[]): ChatActivity {
  return events.reduce(trackActivity, NO_ACTIVITY);
}

/**
 * Milliseconds until the "prompt cache likely expired" notice should show: 0 when it should show now, null when it
 * never should (not a Claude chat, not idle, nothing worth re-reading, or no known last activity).
 * `usageTokens`: the context size the agent reported; without it, the item count stands in for the size.
 */
export function cacheWarningDelay(opts: {
  agent: string;
  idle: boolean;
  items: { type: string }[];
  lastActivityAt: number | null;
  now: number;
  usageTokens?: number | null;
  /** The cache's lifetime (5 min or 1 h, read from the transcript); defaults to CACHE_IDLE_MS. */
  ttlMs?: number;
}): number | null {
  const { agent, idle, items, lastActivityAt, now, usageTokens, ttlMs } = opts;
  if (agent !== "claude" || !idle || lastActivityAt === null) return null;
  if (!items.some((i) => i.type === "user")) return null;
  if (typeof usageTokens === "number") {
    if (usageTokens < CACHE_MIN_TOKENS) return null;
  } else if (items.length < CACHE_MIN_ITEMS) return null;
  return Math.max(0, lastActivityAt + (ttlMs ?? CACHE_IDLE_MS) - now);
}
