import { invoke } from "@tauri-apps/api/core";
import { createStore } from "../lib/externalStore";

/** One saved chat to delete or locate: the backend rebuilds its path from these. */
export interface HistoryItem {
  cli: string;
  sessionId: string;
  profile: string | null;
  wslDistro: string | null;
}

export interface DeleteResult {
  deleted: string[];
  failed: { sessionId: string; error: string }[];
}

/** Absolute path (file or folder) of a saved chat, to show in the file manager. */
export const historySessionPath = ({ cli, sessionId, profile, wslDistro }: HistoryItem) => invoke<string>("history_session_path", { cli, sessionId, profile, wslDistro });

/** Permanently deletes saved chats (no trash). */
export const historyDeleteSessions = (items: HistoryItem[]) => invoke<DeleteResult>("history_delete_sessions", { items });

/** `cli:sessionId` of the rows hidden from the History. They stay hidden for the app session even after a successful
 * delete (the backend lists can lag, e.g. the WSL cache) and come back only on failure or undo. */
const hidden = createStore<ReadonlySet<string>>(new Set());

export const useHiddenRows = hidden.use;
export const getHiddenRows = hidden.get;

export function hideRows(keys: string[]) {
  if (keys.length === 0) return;
  hidden.set(new Set([...hidden.get(), ...keys]));
}

export function unhideRows(keys: string[]) {
  if (!keys.some((k) => hidden.get().has(k))) return;
  const drop = new Set(keys);
  hidden.set(new Set([...hidden.get()].filter((k) => !drop.has(k))));
}
