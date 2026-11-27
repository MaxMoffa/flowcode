import { useSyncExternalStore } from "react";
import type { LsEntry } from "../../shared/remote-types";
import type { PathTarget } from "../lib/fileLinks";
import { hostRequest } from "./hostRequest";

/** Joins `name` onto `dir` with the separator `dir` uses (the other PC may be a Windows one). */
export function joinRemote(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

/** An absolute path on the other PC, or null when `path` is relative and there is no folder to place it in. `.` and `..` segments are folded. */
export function absoluteRemote(path: string, cwd: string | null): string | null {
  const absolute = /^([A-Za-z]:[\\/]|\/|\\\\)/.test(path);
  let full = path;
  if (!absolute) {
    if (!cwd) return null;
    full = joinRemote(cwd, path.replace(/^\.[\\/]/, ""));
  }
  const sep = full.includes("\\") && !full.includes("/") ? "\\" : "/";
  const drive = /^[A-Za-z]:/.test(full) ? full.slice(0, 2) : "";
  // `\\host\share` and its `//host/share` spelling (WSL roots from a Windows host); `//` then a slash is just a root.
  const uncBack = full.startsWith("\\\\");
  const uncFwd = !uncBack && /^\/\/[^\\/]/.test(full);
  const parts: string[] = [];
  for (const seg of full.slice(drive.length).split(/[\\/]+/)) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  const lead = uncBack ? "\\\\" : uncFwd ? "//" : drive ? drive + sep : sep === "/" ? "/" : "";
  return lead + parts.join(sep);
}

function parentOf(path: string): { dir: string; name: string } | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (at < 0) return null;
  const name = trimmed.slice(at + 1);
  if (!name) return null;
  let dir = trimmed.slice(0, at);
  // "/file" lists "/", "C:\file" lists "C:\".
  if (dir === "" || /^[A-Za-z]:$/.test(dir)) dir += trimmed[at];
  return { dir, name };
}

interface DirListing {
  at: number;
  entries: Promise<{ entries: LsEntry[]; truncated: boolean } | null>;
}

const DIR_TTL_MS = 20_000;
/** A miss against a listing older than this is re-checked once: the file may have been created since. */
const MISS_RELIST_MS = 2_000;
const listings = new Map<string, DirListing>();

function listDir(hostId: string, dir: string, fresh = false): DirListing {
  const key = `${hostId}\0${dir}`;
  const hit = listings.get(key);
  if (!fresh && hit && Date.now() - hit.at < DIR_TTL_MS) return hit;
  if (listings.size > 200) listings.clear();
  const entries = hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: { op: "list", path: dir } }), 15_000)
    .then((m) => (m.response?.kind === "list" ? { entries: m.response.entries, truncated: m.response.truncated } : null))
    .catch(() => null);
  const listing: DirListing = { at: Date.now(), entries };
  listings.set(key, listing);
  // Failures and timeouts are not remembered: the next link asks again.
  void entries.then((r) => {
    if (!r && listings.get(key) === listing) listings.delete(key);
  });
  return listing;
}

/** What `path` (relative ones against `cwd`) is on the other PC, found in its parent's listing (one listing serves every link in that folder); null when nothing is there or it can't be told. */
export async function checkRemotePath(hostId: string, path: string, cwd: string | null): Promise<PathTarget | null> {
  const full = absoluteRemote(path, cwd);
  const split = full && parentOf(full);
  if (!full || !split) return null;
  const windows = /^[A-Za-z]:|^\\\\/.test(full);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  const find = (l: { entries: LsEntry[] }) => l.entries.find((e) => same(e.name, split.name));
  let used = listDir(hostId, split.dir);
  let listing = await used.entries;
  if (!listing) return null;
  let entry = find(listing);
  if (!entry && Date.now() - used.at > MISS_RELIST_MS) {
    used = listDir(hostId, split.dir, true);
    listing = await used.entries;
    if (!listing) return null;
    entry = find(listing);
  }
  if (!entry) return null;
  return { path: joinRemote(split.dir, entry.name), kind: entry.dir ? "dir" : "file", text: !entry.dir };
}

export interface RemoteFileText {
  path: string;
  text: string;
  truncated: boolean;
}

/** The text of a file of the other PC, through its file explorer (read-only). */
export async function readRemoteFile(hostId: string, path: string): Promise<RemoteFileText> {
  const m = await hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: { op: "read", path } }));
  if (m.response?.kind !== "file") throw new Error("unreadable");
  return { path: m.response.path, text: m.response.text, truncated: m.response.truncated };
}

// ---- the editor tabs of a PC ------------------------------------------------

export interface OpenRemoteFile {
  hostId: string;
  path: string;
  line?: number;
}

export interface RemoteEditorTab {
  path: string;
  /** Line to scroll to; `seq` changes on every open so asking for the same line again scrolls again. */
  line?: number;
  seq: number;
  dirty: boolean;
  /** Unsaved text kept while the PC is left; handed back to the editor when it is mounted again. */
  draft?: string;
}

export interface RemoteEditors {
  tabs: readonly RemoteEditorTab[];
  /** Path of the editor in front; null when a tab of the PC itself is. */
  front: string | null;
}

const NONE: RemoteEditors = { tabs: [], front: null };
const state = new Map<string, RemoteEditors>();
const subs = new Set<() => void>();
let seq = 0;

function patch(hostId: string, fn: (s: RemoteEditors) => RemoteEditors) {
  const prev = state.get(hostId) ?? NONE;
  const next = fn(prev);
  if (next === prev) return;
  state.set(hostId, next);
  subs.forEach((f) => f());
}

/** Opens a file of the other PC as an editor tab in front (an open one is focused; a new `line` scrolls). */
export function openRemoteFile({ hostId, path, line }: OpenRemoteFile) {
  patch(hostId, (s) => {
    const has = s.tabs.some((t) => t.path === path);
    const tabs = has ? s.tabs.map((t) => (t.path === path ? { ...t, line, seq: ++seq } : t)) : [...s.tabs, { path, line, seq: ++seq, dirty: false }];
    return { tabs, front: path };
  });
}

/** Puts the editor of `path` in front; null puts the PC's own tabs back in front. */
export function showRemoteEditor(hostId: string, path: string | null) {
  patch(hostId, (s) => (s.front === path || (path !== null && !s.tabs.some((t) => t.path === path)) ? s : { ...s, front: path }));
}

/** Closes an editor tab; the one before it (or the PC's tabs) comes to the front if it was in front. */
export function closeRemoteEditor(hostId: string, path: string) {
  patch(hostId, (s) => {
    const at = s.tabs.findIndex((t) => t.path === path);
    if (at < 0) return s;
    const tabs = s.tabs.filter((t) => t.path !== path);
    return { tabs, front: s.front === path ? (tabs[Math.min(at, tabs.length - 1)]?.path ?? null) : s.front };
  });
}

/** A clean editor drops its draft. */
export function setRemoteEditorDirty(hostId: string, path: string, dirty: boolean) {
  patch(hostId, (s) => (s.tabs.some((t) => t.path === path && (t.dirty !== dirty || (!dirty && t.draft !== undefined))) ? { ...s, tabs: s.tabs.map((t) => (t.path === path ? { ...t, dirty, draft: dirty ? t.draft : undefined } : t)) } : s));
}

/** Keeps the unsaved text of a dirty editor whose workspace is going away. */
export function stashRemoteDraft(hostId: string, path: string, draft: string) {
  patch(hostId, (s) => ({ ...s, tabs: s.tabs.map((t) => (t.path === path && t.dirty ? { ...t, draft } : t)) }));
}

/** The file was renamed on the PC from its editor tab. */
export function renameRemoteEditor(hostId: string, path: string, newPath: string) {
  patch(hostId, (s) => (s.tabs.some((t) => t.path === path) ? { tabs: s.tabs.map((t) => (t.path === path ? { ...t, path: newPath } : t)), front: s.front === path ? newPath : s.front } : s));
}

export function getRemoteEditors(hostId: string): RemoteEditors {
  return state.get(hostId) ?? NONE;
}

export function useRemoteEditors(hostId: string): RemoteEditors {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    () => getRemoteEditors(hostId),
  );
}

/** Test hook: forgets every open editor. */
export function resetRemoteEditors() {
  state.clear();
}
