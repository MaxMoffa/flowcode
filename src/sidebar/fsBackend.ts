import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { normalizeDir } from "../lib/path";

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** What the file explorer asks of a file system: this PC's by default, another PC's (through its `fs` protocol messages) when the explorer shows that one. A missing optional member hides its feature. */
export interface FsBackend {
  readDir: (path: string, showHidden: boolean) => Promise<FsEntry[]>;
  remove: (path: string, isDir: boolean) => Promise<void>;
  rename: (path: string, newName: string) => Promise<void>;
  create: (dir: string, name: string, kind: "file" | "dir") => Promise<void>;
  /** Calls `onChange` when `path`'s entries change; `onUnavailable` when it can't be watched (the explorer polls then). Absent: the explorer polls slowly. */
  watch?: (path: string, onChange: () => void, onUnavailable: () => void) => () => void;
  /** Recursive name search under `path`; `generation` lets the backend drop an older walk. Absent: no search. */
  search?: (path: string, query: string, showHidden: boolean, generation: number) => Promise<FsEntry[]>;
  duplicate?: (path: string) => Promise<void>;
  reveal?: (path: string) => void;
  /** The Info dialog (reads this PC's `get_file_info`). */
  info?: boolean;
}

const localFs: FsBackend = {
  readDir: (path, showHidden) => invoke<FsEntry[]>("read_dir", { path, showHidden }),
  remove: (path, isDir) => invoke("delete_entry", { path, isDir }),
  rename: (path, newName) => invoke("rename_entry", { path, newName }),
  create: (dir, name, kind) => invoke(kind === "file" ? "create_file_entry" : "create_dir_entry", { dir, name }),
  // The backend watches one folder per window and says when entries are created, removed or renamed.
  watch: (path, onChange, onUnavailable) => {
    const unlisten = listen<string>("fs-changed", (event) => {
      if (normalizeDir(event.payload) === normalizeDir(path)) onChange();
    });
    invoke("watch_dir", { path }).catch(onUnavailable);
    return () => {
      // The window's one watcher - a new path's `watch_dir` replaces it, but a closed explorer would otherwise keep it running.
      invoke("unwatch_dir").catch(() => {});
      unlisten.then((fn) => fn());
    };
  },
  search: (path, query, showHidden, generation) => invoke<FsEntry[]>("search_dir", { path, query, showHidden, generation }),
  duplicate: (path) => invoke("duplicate_entry", { path }),
  reveal: (path) => void revealItemInDir(path).catch(() => {}),
  info: true,
};

export const FsBackendContext = createContext<FsBackend>(localFs);
export const useFsBackend = () => useContext(FsBackendContext);
