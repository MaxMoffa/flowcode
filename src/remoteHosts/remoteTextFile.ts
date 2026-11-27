import type { FsRequest } from "../../shared/remote-types";
import { TextConflictError, type TextFileBackend, type TextFileRead } from "../editor/textFileBackend";
import { hostRequest } from "./hostRequest";

const request = (hostId: string, req: FsRequest) => hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: req }));

async function read(hostId: string, path: string): Promise<TextFileRead> {
  const m = await request(hostId, { op: "read", path });
  if (m.response?.kind !== "file") throw new Error("unreadable");
  const { text, version } = m.response;
  // No version = truncated or binary: the host would refuse a write anyway.
  return { text, version, readOnly: version === null };
}

/** Another PC's files for the editor, through its `fs` messages. The version is the host's sha256 of the file. */
export function remoteTextBackend(hostId: string): TextFileBackend {
  return {
    read: (path) => read(hostId, path),
    write: async (path, text, version) => {
      // Overwriting regardless: take the file's current version first.
      const expected = version ?? (await read(hostId, path)).version;
      if (expected === null) throw new Error("read-only");
      try {
        await request(hostId, { op: "write", path, text, version: expected });
      } catch (e) {
        // The host reports a changed file as a plain error: tell it from the rest by looking again.
        const now = await read(hostId, path).catch(() => null);
        if (now && now.version !== expected) throw new TextConflictError();
        throw e;
      }
      return (await read(hostId, path).catch(() => null))?.version ?? null;
    },
    rename: async (path, name) => {
      const m = await request(hostId, { op: "rename", path, name });
      if (m.response?.kind !== "done") throw new Error("rename failed");
      return m.response.path;
    },
  };
}
