import { createStore } from "../lib/externalStore";
import type { HistoryDeleteResult } from "../../shared/remote-types";
import type { HistoryItem } from "../agents/historyDelete";
import { hostRequest } from "./hostRequest";

/** Deletes saved chats on the other PC. Rejects when the request itself fails. */
export async function remoteHistoryDelete(hostId: string, items: HistoryItem[]): Promise<HistoryDeleteResult> {
  const res = await hostRequest(hostId, "historydelete", (requestId) => ({ t: "historydelete", requestId, items: items.map((i) => ({ cli: i.cli, sessionId: i.sessionId, profile: i.profile, wslDistro: i.wslDistro })) }), 120_000);
  return res.result ?? { deleted: [], failed: items.map((i) => ({ sessionId: i.sessionId, error: "no result" })) };
}

/** `hostId` + NUL + `cli:sessionId` of the rows hidden from a PC's History: per host, since ids of two PCs may collide.
 * They stay hidden for the app session (the host's lists can lag); they come back only on failure or undo. */
const hidden = createStore<ReadonlySet<string>>(new Set());
export const useRemoteHiddenRows = hidden.use;
export const getRemoteHiddenRows = hidden.get;
export const remoteHiddenKey = (hostId: string, key: string) => `${hostId}\0${key}`;

export function hideRemoteRows(keys: string[]) {
  if (keys.length > 0) hidden.set(new Set([...hidden.get(), ...keys]));
}

export function unhideRemoteRows(keys: string[]) {
  if (!keys.some((k) => hidden.get().has(k))) return;
  const drop = new Set(keys);
  hidden.set(new Set([...hidden.get()].filter((k) => !drop.has(k))));
}
