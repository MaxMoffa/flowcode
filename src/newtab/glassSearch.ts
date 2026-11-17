import { basename, comparablePath, separatorOf, trimTrailingSeparators } from "../lib/path";

/** What a "Vetro" entry is - the search lists them in this order, one section each. */
export type ResultKind = "agent" | "recent" | "favorite" | "folder" | "shell";
export const KIND_ORDER: readonly ResultKind[] = ["agent", "recent", "favorite", "folder", "shell"];

/** The pills under the search field; Tab cycles them. */
export type SearchFilter = "all" | "folders" | "agents" | "recents";
export const SEARCH_FILTERS: readonly SearchFilter[] = ["all", "folders", "agents", "recents"];

export function nextFilter(current: SearchFilter, step: 1 | -1): SearchFilter {
  const at = SEARCH_FILTERS.indexOf(current);
  return SEARCH_FILTERS[(at + step + SEARCH_FILTERS.length) % SEARCH_FILTERS.length];
}

/** Which sections a filter lets through ("Cartelle" is the favorites and the folders found). */
export function kindsShown(filter: SearchFilter): ReadonlySet<ResultKind> {
  switch (filter) {
    case "folders":
      return new Set<ResultKind>(["favorite", "folder"]);
    case "agents":
      return new Set<ResultKind>(["agent"]);
    case "recents":
      return new Set<ResultKind>(["recent"]);
    default:
      return new Set<ResultKind>(KIND_ORDER);
  }
}

/** `items` regrouped by section, each group keeping its own order - the order the arrow keys walk. */
export function groupByKind<T extends { kind: ResultKind }>(items: readonly T[]): T[] {
  return KIND_ORDER.flatMap((kind) => items.filter((item) => item.kind === kind));
}

export interface SearchRoot {
  path: string;
  /** The user's home (named "Home", not by its folder). */
  home: boolean;
}

const isInside = (child: string, parent: string): boolean => {
  const c = comparablePath(child);
  const p = comparablePath(parent);
  const prefix = /[\\/]$/.test(p) ? p : p + (p.includes("\\") ? "\\" : "/");
  return c.startsWith(prefix);
};

/** Where the folder search starts: each favorite folder and the home, minus
 * duplicates and any root already inside another (its walk would repeat). */
export function searchRoots(favoritePaths: readonly string[], home: string | null): SearchRoot[] {
  const all: SearchRoot[] = [...favoritePaths.map((path) => ({ path, home: false })), ...(home ? [{ path: home, home: true }] : [])];
  return all.filter((root, i) =>
    all.every((other, j) => {
      if (i === j) return true;
      if (comparablePath(other.path) === comparablePath(root.path)) return j > i;
      return !isInside(root.path, other.path);
    }),
  );
}

/** "Progetti, Home": the roots by folder name, for the "in ..." chip. */
export const rootsLabel = (roots: readonly SearchRoot[], homeLabel: string): string =>
  roots.map((root) => (root.home ? homeLabel : basename(root.path))).join(", ");

/** The folders found under every root as one list: the ones already shown
 * elsewhere (`known`) and repeats dropped, name matches that begin with the
 * query first, then shorter names and paths. */
export function mergeFolders<T extends { name: string; path: string }>(lists: readonly (readonly T[])[], query: string, known: readonly string[], limit: number): T[] {
  const q = query.trim().toLowerCase();
  const seen = new Set(known.map(comparablePath));
  const merged: T[] = [];
  for (const entry of lists.flat()) {
    const key = comparablePath(entry.path);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  const starts = (e: T) => (e.name.toLowerCase().startsWith(q) ? 0 : 1);
  return merged.sort((a, b) => starts(a) - starts(b) || a.name.length - b.name.length || a.path.length - b.path.length).slice(0, limit);
}

/** `text` cut around the first (case-insensitive) occurrence of `query`; null when it isn't there. */
export function splitMatch(text: string, query: string): { before: string; match: string; after: string } | null {
  const q = query.trim();
  const at = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (at < 0) return null;
  return { before: text.slice(0, at), match: text.slice(at, at + q.length), after: text.slice(at + q.length) };
}

/** A query that reads as a path: the folder typed so far and the name being typed in it. */
export interface PathQuery {
  /** The folder as typed, with its trailing separator (`~/Doc` -> `~/`). */
  dir: string;
  /** The same folder as the file system takes it (`~` expanded, a relative one resolved). */
  readPath: string;
  /** What follows the last separator. */
  segment: string;
  /** A drive, UNC, `~/` or `/` path is one for sure; a relative one only when its folder exists. */
  explicit: boolean;
}

const joinSeparators = (path: string, sep: string): string => path.replace(/[\\/]/g, sep);

/** Reads `query` as a path, or null when it has no separator. `~` is `home`; a
 * relative path is resolved against `base`, else `home`; a leading `/` is a
 * path only off Windows (there it is the current drive's root: too easily a
 * command's argument). */
export function parsePathQuery(query: string, env: { home: string | null; base: string | null; windows: boolean }): PathQuery | null {
  const q = query.trimStart();
  const cut = Math.max(q.lastIndexOf("/"), q.lastIndexOf("\\"));
  if (cut < 0) return null;
  const dir = q.slice(0, cut + 1);
  const segment = q.slice(cut + 1);
  if (/^[A-Za-z]:[\\/]/.test(q) || q.startsWith("\\\\") || (q.startsWith("/") && !env.windows)) return { dir, readPath: dir, segment, explicit: true };
  if (/^~[\\/]/.test(q)) {
    if (!env.home) return null;
    const home = trimTrailingSeparators(env.home);
    return { dir, readPath: home + joinSeparators(dir.slice(1), separatorOf(home)), segment, explicit: true };
  }
  const base = env.base ?? env.home;
  if (!base || /^[\\/]/.test(q)) return null;
  const root = trimTrailingSeparators(base);
  const sep = separatorOf(root);
  return { dir, readPath: (/[\\/]$/.test(root) ? root : root + sep) + joinSeparators(dir, sep), segment, explicit: false };
}

/** The subfolders of the typed folder that the typed name starts (ignoring case). */
export const matchingSubfolders = <T extends { name: string; is_dir: boolean }>(entries: readonly T[], segment: string): T[] =>
  entries.filter((e) => e.is_dir && e.name.toLowerCase().startsWith(segment.toLowerCase()));

/** The query once Tab completes `name` into it: the typed folder, the name, a separator. */
export const completePath = (pq: PathQuery, name: string): string => pq.dir + name + pq.dir.slice(-1);

/** The folder Enter opens when nothing is highlighted: the one typed so far. */
export const typedFolder = (pq: PathQuery): string => pq.readPath + pq.segment;
