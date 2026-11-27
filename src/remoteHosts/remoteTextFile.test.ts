import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg, FsResponse } from "../../shared/remote-types";

const sent: { op: string; [k: string]: unknown }[] = [];
let handler: (req: { op: string; [k: string]: unknown }) => FsResponse | Error;

vi.mock("./hostRequest", () => ({
  hostRequest: (_host: string, _kind: string, build: (id: string) => ClientMsg) => {
    const req = (build("r1") as unknown as { request: { op: string } }).request;
    sent.push(req);
    const out = handler(req);
    return out instanceof Error ? Promise.reject(out) : Promise.resolve({ t: "fs", requestId: "r1", response: out });
  },
}));

import { TextConflictError } from "../editor/textFileBackend";
import { remoteTextBackend } from "./remoteTextFile";

const file = (text: string, version: string | null, truncated = false): FsResponse => ({ kind: "file", path: "/a.txt", text, truncated, version });

describe("remoteTextBackend", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("maps the host version and marks unversioned files read-only", async () => {
    const backend = remoteTextBackend("h");
    handler = () => file("hi", "v1");
    expect(await backend.read("/a.txt")).toEqual({ text: "hi", version: "v1", readOnly: false });
    handler = () => file("hi", null, true);
    expect((await backend.read("/a.txt")).readOnly).toBe(true);
  });

  it("writes with the version and returns the new one", async () => {
    let disk = "v1";
    handler = (req) => {
      if (req.op === "write") {
        disk = "v2";
        return { kind: "done", path: "/a.txt" };
      }
      return file("x", disk);
    };
    const v = await remoteTextBackend("h").write("/a.txt", "new", "v1");
    expect(sent[0]).toMatchObject({ op: "write", text: "new", version: "v1" });
    expect(v).toBe("v2");
  });

  it("turns a refused write on a changed file into a conflict, and overwrites with a null version", async () => {
    handler = (req) => (req.op === "write" ? new Error("changed") : file("other", "v9"));
    await expect(remoteTextBackend("h").write("/a.txt", "new", "v1")).rejects.toBeInstanceOf(TextConflictError);
    sent.length = 0;
    handler = (req) => (req.op === "write" ? { kind: "done", path: "/a.txt" } : file("other", "v9"));
    await remoteTextBackend("h").write("/a.txt", "new", null);
    expect(sent.find((r) => r.op === "write")).toMatchObject({ version: "v9" });
  });

  it("keeps other write errors as they are", async () => {
    handler = (req) => (req.op === "write" ? new Error("denied") : file("same", "v1"));
    await expect(remoteTextBackend("h").write("/a.txt", "new", "v1")).rejects.toThrow("denied");
  });
});
