// The prompt-cache lifetime and last model call of a Claude chat, asked of the desktop (it reads the transcript).
import { hostSupports, onMessage, send } from "./remote";

/** What the desktop read from the transcript. */
export interface ChatCacheInfo {
  ttlMs: number;
  lastCallAt: string | null;
}

/** How long to wait for the desktop's answer. */
const TIMEOUT_MS = 10_000;

/** Requests in flight, by chat, so concurrent callers share one. */
const pending = new Map<string, Promise<ChatCacheInfo>>();

/**
 * Asks the desktop for a chat's cache info (`chatcacheinfo`). Rejects when the desktop is too old to answer,
 * cannot read the transcript (no values in the reply), or does not answer within 10 s.
 */
export function loadChatCacheInfo(chatId: string): Promise<ChatCacheInfo> {
  if (!hostSupports("chatCacheInfo")) return Promise.reject(new Error("unsupported"));
  const running = pending.get(chatId);
  if (running) return running;
  const request = new Promise<ChatCacheInfo>((resolve, reject) => {
    const finish = (done: () => void) => {
      clearTimeout(timer);
      stop();
      pending.delete(chatId);
      done();
    };
    const stop = onMessage((m) => {
      if (m.t !== "chatcacheinfo" || m.chatId !== chatId) return;
      finish(() =>
        typeof m.ttlMs === "number" ? resolve({ ttlMs: m.ttlMs, lastCallAt: m.lastCallAt ?? null }) : reject(new Error("unavailable")),
      );
    });
    const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), TIMEOUT_MS);
    send({ t: "chatcacheinfo", chatId });
  });
  pending.set(chatId, request);
  return request;
}
