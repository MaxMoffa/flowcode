// Per-chat caches (drafts, attachments, goal state, last view) register here to
// drop what they hold for a chat that no longer exists. No imports on purpose:
// chats.ts announces, the components' modules listen, no cycles.
const listeners = new Set<(chatId: string) => void>();

/** Calls `fn` when a chat is gone for good; returns the unsubscribe function. */
export function onChatGone(fn: (chatId: string) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Announces that `chatId` no longer exists. */
export function chatGone(chatId: string) {
  listeners.forEach((fn) => fn(chatId));
}
