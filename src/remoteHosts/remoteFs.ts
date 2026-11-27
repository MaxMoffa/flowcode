import type { FsRequest, LsEntry } from "../../shared/remote-types";
import type { FsBackend, FsEntry } from "../sidebar/fsBackend";
import { hostRequest } from "./hostRequest";
import { joinRemote } from "./remoteFiles";

const request = (hostId: string, req: FsRequest) => hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: req }));

/** Hidden on the host: its attribute, or a dot name. */
const isHidden = (e: LsEntry) => !!e.hidden || e.name.startsWith(".");

/** Another PC's file system, through its `fs` messages: listing, delete, rename and create (no watcher, search, duplicate, reveal or info). */
export function remoteFsBackend(hostId: string): FsBackend {
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
  };
}
