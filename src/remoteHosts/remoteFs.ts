import type { FsRequest, LsEntry } from "../../shared/remote-types";
import type { FsBackend, FsEntry } from "../sidebar/fsBackend";
import { hostRequest } from "./hostRequest";
import { joinRemote } from "./remoteFiles";

const request = (hostId: string, req: FsRequest) => hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: req }));

/** Hidden on the host: its attribute, or a dot name. */
const isHidden = (e: LsEntry) => !!e.hidden || e.name.startsWith(".");

/** Another PC's file system, through its `fs` messages: listing, delete, rename and create, plus search, duplicate and info when its `caps` have them (no watcher or reveal). */
export function remoteFsBackend(hostId: string, caps: readonly string[] = []): FsBackend {
  return {
    readDir: async (path, showHidden) => {
      const m = await request(hostId, { op: "list", path });
      if (m.response?.kind !== "list") throw new Error("unreadable");
      const list = m.response;
      return list.entries
        .filter((e) => showHidden || !isHidden(e))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        .map((e): FsEntry => ({ name: e.name, path: joinRemote(path, e.name), is_dir: e.dir }));
    },
    remove: async (path) => void (await request(hostId, { op: "delete", path })),
    rename: async (path, name) => void (await request(hostId, { op: "rename", path, name })),
    create: async (dir, name, kind) => void (await request(hostId, { op: "create", path: dir, name, dir: kind === "dir" })),
    // The host cancels an older walk of this connection itself, so `generation` isn't sent.
    ...(caps.includes("fsSearch") && {
      search: async (path: string, query: string, showHidden: boolean): Promise<FsEntry[]> => {
        const m = await request(hostId, { op: "search", path, query, showHidden });
        if (m.response?.kind !== "search") throw new Error("unreadable");
        return m.response.entries.map((e) => ({ name: e.name, path: e.path, is_dir: e.dir }));
      },
    }),
    ...(caps.includes("fsExtra") && {
      duplicate: async (path: string) => void (await request(hostId, { op: "duplicate", path })),
      info: async (path: string) => {
        const m = await request(hostId, { op: "info", path });
        if (m.response?.kind !== "info") throw new Error("unreadable");
        return m.response.info;
      },
    }),
  };
}

/** Folder-only search under `root` on another PC (the new tab page's search): names and paths of the folders found, `depth` levels down. */
export async function searchRemoteDirs(hostId: string, root: string, query: string, depth: number): Promise<FsEntry[]> {
  const m = await request(hostId, { op: "search", path: root, query, dirsOnly: true, maxDepth: depth });
  if (m.response?.kind !== "search") throw new Error("unreadable");
  return m.response.entries.map((e) => ({ name: e.name, path: e.path, is_dir: e.dir }));
}
