import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface TextFileRead {
  text: string;
  /** What the file looked like when read (opaque); handed back on `write`. Null: cannot be saved. */
  version: string | null;
  /** Shown but not editable (truncated or binary on the other PC). */
  readOnly?: boolean;
}

/** `write` found the file changed since `version` was read. */
export class TextConflictError extends Error {
  constructor() {
    super("changed");
    this.name = "TextConflictError";
  }
}

/** What the editor asks of a file system: this PC's by default, another PC's (through its `fs` protocol messages) inside a remote workspace. A missing optional member hides its feature. */
export interface TextFileBackend {
  read: (path: string) => Promise<TextFileRead>;
  /** Saves `text`; throws `TextConflictError` when the file no longer matches `version`. A null `version` overwrites regardless. Resolves with the new version. */
  write: (path: string, text: string, version: string | null) => Promise<string | null>;
  /** Renames the file inside its folder; resolves with the new path. Absent: no rename. */
  rename?: (path: string, newName: string) => Promise<string>;
}

/** The version of a local file is its text: a save re-reads the disk and compares. */
const localText: TextFileBackend = {
  read: async (path) => {
    const text = await invoke<string>("read_text_file", { path });
    return { text, version: text };
  },
  write: async (path, text, version) => {
    if (version !== null) {
      // An unreadable file is written anyway (the write reports the real error).
      const onDisk = await invoke<string>("read_text_file", { path }).catch(() => null);
      if (onDisk !== null && onDisk !== version) throw new TextConflictError();
    }
    await invoke("write_text_file", { path, contents: text });
    return text;
  },
  rename: async (path, newName) => (await invoke<{ name: string; path: string; is_dir: boolean }>("rename_entry", { path, newName })).path,
};

export const TextFileBackendContext = createContext<TextFileBackend>(localText);
export const useTextFileBackend = () => useContext(TextFileBackendContext);
