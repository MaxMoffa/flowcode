import { invoke } from "@tauri-apps/api/core";
import { createStore } from "../lib/externalStore";

/** The custom chat names set from the History ("Rename"), keyed `cli:sessionId`. They live in the backend
 * (never in the agents' own files); this store mirrors them so every list shows a new name at once. */
const titles = createStore<Readonly<Record<string, string>>>({});

export const useHistoryTitles = titles.use;

/** Loads the saved names (once per panel mount is enough: only this window changes them). */
export function loadHistoryTitles() {
  invoke<Record<string, string>>("history_titles")
    .then((map) => titles.set(map))
    .catch(() => {});
}

function put(key: string, title: string | undefined) {
  const next = { ...titles.get() };
  if (title) next[key] = title;
  else delete next[key];
  titles.set(next);
}

/** Renames a chat (empty title = back to the agent's own). The list shows the change right away;
 * if saving fails it is put back and the error is thrown. */
export async function renameHistoryChat(cli: string, sessionId: string, title: string) {
  const key = `${cli}:${sessionId}`;
  const before = titles.get()[key];
  const next = title.trim();
  put(key, next);
  try {
    await invoke("history_rename", { cli, sessionId, title: next });
  } catch (err) {
    put(key, before);
    throw err;
  }
}
