import { basename, trimTrailingSeparators } from "../lib/path";
import { createListStore } from "../lib/createListStore";

const STORAGE_KEY = "flowcode.favorites";

export interface FavoriteFolder {
  path: string;
  name: string;
  /** `pty_spawn` shell id of the terminal the folder was saved from (e.g.
   * `wsl:Ubuntu`, `pwsh`) - opening the favorite brings that same kind of
   * terminal back, so a WSL folder reopens inside WSL rather than in a
   * Windows shell that can't `cd` there. Missing on favorites saved before
   * this existed: those just open in the active terminal, as they used to. */
  shell?: string;
}

const store = createListStore<FavoriteFolder>(
  STORAGE_KEY,
  (f): f is FavoriteFolder =>
    typeof (f as FavoriteFolder)?.path === "string" &&
    typeof (f as FavoriteFolder)?.name === "string" &&
    ["string", "undefined"].includes(typeof (f as FavoriteFolder).shell),
);

/** Trailing-separator-insensitive form, used to de-dupe (`/a/b` and `/a/b/`
 * are the same favorite). */
const normalize = trimTrailingSeparators;

export function listFavorites(): FavoriteFolder[] {
  return store.get();
}

export function isFavorite(path: string): boolean {
  const target = normalize(path);
  return store.get().some((f) => normalize(f.path) === target);
}

export function addFavorite(path: string, shell?: string) {
  if (!path) return;
  const target = normalize(path);
  if (store.get().some((f) => normalize(f.path) === target)) return;
  store.set([...store.get(), { path, name: basename(path), ...(shell ? { shell } : {}) }]);
}

export function removeFavorite(path: string) {
  const target = normalize(path);
  store.set(store.get().filter((f) => normalize(f.path) !== target));
}

export const subscribeFavorites = store.subscribe;
