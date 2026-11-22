import { detectLimit } from "../agents/limitText";
import type { ChatItem } from "./chatModel";

/** Longest agent text still read as a limit notice (the CLIs' own are well under it). */
const MAX_NOTICE_CHARS = 300;

/** The usage-limit notice in the current turn (after the last user message), if any: the item that carries it and the reset time it names (null when it doesn't say). */
export function limitOf(items: ChatItem[], now = new Date()): { id: string; at: number | null } | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === "user") return null;
    // A subagent's text is not the account's state.
    if (item.type === "agent" && item.parentToolUseId) continue;
    const text = item.type === "agent" ? item.text : item.type === "error" ? item.message : null;
    if (!text) {
      if (item.type === "error" && item.limit) return { id: item.id, at: null };
      continue;
    }
    // The backend knew it from the adapter's structured error (any agent), whatever the wording: the text only adds the reset time.
    if (item.type === "error" && item.limit) return { id: item.id, at: detectLimit(text, now)?.at ?? null };
    // A notice is a line or two: a long reply that merely quotes one is the agent's own text.
    if (item.type === "agent" && text.trim().length > MAX_NOTICE_CHARS) continue;
    const hit = detectLimit(text, now);
    if (hit) return { id: item.id, at: hit.at };
  }
  return null;
}
