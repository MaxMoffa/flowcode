import { basename, trimTrailingSeparators } from "../lib/path";
import { readJson, writeString } from "../lib/storage";

const STORAGE_KEY = "flowcode.favorites";

export interface FavoriteFolder {
  path: string;
  name: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();

const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

function readFromStorage(): FavoriteFolder[] {
  return readJson(STORAGE_KEY, isArray, []).filter(
    (f): f is FavoriteFolder =>
      typeof (f as FavoriteFolder)?.path === "string" && typeof (f as FavoriteFolder)?.name === "string",
  );
}

// A single cached array reference, only ever replaced (never mutated in
// place) when favorites actually change - `useSyncExternalStore`'s
// `getSnapshot` must return the same reference across calls when nothing
// changed, or React re-renders every commit forever ("Maximum update depth
// exceeded"), which a plain "reparse localStorage every call" implementation
// hit immediately.
let cache: FavoriteFolder[] = readFromStorage();

function setCache(favorites: FavoriteFolder[]) {
  cache = favorites;
  writeString(STORAGE_KEY, JSON.stringify(favorites));
  listeners.forEach((l) => l());
}

/** Trailing-separator-insensitive form, used to de-dupe (`/a/b` and `/a/b/`
 * are the same favorite). */
const normalize = trimTrailingSeparators;

export function listFavorites(): FavoriteFolder[] {
  return cache;
}

export function isFavorite(path: string): boolean {
  const target = normalize(path);
  return cache.some((f) => normalize(f.path) === target);
}

export function addFavorite(path: string) {
  if (!path) return;
  const target = normalize(path);
  if (cache.some((f) => normalize(f.path) === target)) return;
  setCache([...cache, { path, name: basename(path) }]);
}

export function removeFavorite(path: string) {
  const target = normalize(path);
  setCache(cache.filter((f) => normalize(f.path) !== target));
}

export function subscribeFavorites(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
