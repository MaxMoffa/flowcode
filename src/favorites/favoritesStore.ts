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

/** Trailing-separator-insensitive form, used to de-dupe (`/a/b` and `/a/b/`
 * are the same favorite). */
const normalize = trimTrailingSeparators;

/** What the explorer and the new tab page need of a favorites list. */
export interface FavoritesStore {
  list: () => FavoriteFolder[];
  isFavorite: (path: string) => boolean;
  add: (path: string, shell?: string) => void;
  remove: (path: string) => void;
  subscribe: (listener: () => void) => () => void;
}

/** One persisted favorites list under `storageKey`. */
export function createFavoritesStore(storageKey: string): FavoritesStore {
  const store = createListStore<FavoriteFolder>(
    storageKey,
    (f): f is FavoriteFolder =>
      typeof (f as FavoriteFolder)?.path === "string" &&
      typeof (f as FavoriteFolder)?.name === "string" &&
      ["string", "undefined"].includes(typeof (f as FavoriteFolder).shell),
  );
  return {
    list: store.get,
    isFavorite: (path) => {
      const target = normalize(path);
      return store.get().some((f) => normalize(f.path) === target);
    },
    add(path, shell) {
      if (!path) return;
      const target = normalize(path);
      if (store.get().some((f) => normalize(f.path) === target)) return;
      store.set([...store.get(), { path, name: basename(path), ...(shell ? { shell } : {}) }]);
    },
    remove(path) {
      const target = normalize(path);
      store.set(store.get().filter((f) => normalize(f.path) !== target));
    },
    subscribe: store.subscribe,
  };
}

const local = createFavoritesStore(STORAGE_KEY);

export const localFavorites: FavoritesStore = local;
export const listFavorites = local.list;
export const isFavorite = local.isFavorite;
export const addFavorite = local.add;
export const removeFavorite = local.remove;
export const subscribeFavorites = local.subscribe;

/** Favorites of another PC, kept on this client (one list per PC). */
const remoteStores = new Map<string, FavoritesStore>();
export function remoteFavorites(hostId: string): FavoritesStore {
  let store = remoteStores.get(hostId);
  if (!store) {
    store = createFavoritesStore(`flowcode.remoteFavorites.${hostId}`);
    remoteStores.set(hostId, store);
  }
  return store;
}
