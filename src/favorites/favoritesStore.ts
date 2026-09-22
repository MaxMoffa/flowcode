const STORAGE_KEY = "flowcode.favorites";

export interface FavoriteFolder {
  path: string;
  name: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();

function readFromStorage(): FavoriteFolder[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is FavoriteFolder => typeof f?.path === "string" && typeof f?.name === "string",
    );
  } catch {
    return [];
  }
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

/** Trailing-slash-insensitive name for a folder path, used both as the
 * stored label and to de-dupe (`/a/b` and `/a/b/` are the same favorite). */
function nameForPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed || path;
}

function normalize(path: string): string {
  return path.replace(/[\\/]+$/, "") || path;
}

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
  setCache([...cache, { path, name: nameForPath(path) }]);
}

export function removeFavorite(path: string) {
  const target = normalize(path);
  setCache(cache.filter((f) => normalize(f.path) !== target));
}

export function subscribeFavorites(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
