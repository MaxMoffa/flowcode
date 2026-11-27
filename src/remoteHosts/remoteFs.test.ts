import { describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
let reply: unknown = null;
vi.mock("./hostRequest", () => ({
  hostRequest: (_host: string, _kind: string, build: (id: string) => unknown) => {
    sent.push(build("r1"));
    return Promise.resolve(reply);
  },
}));

import { remoteFsBackend } from "./remoteFs";

describe("remote file system backend", () => {
  it("maps the listing, sorts folders first and hides dot and hidden entries", async () => {
    reply = {
      response: {
        kind: "list",
        path: "C:\\proj",
        parent: null,
        truncated: false,
        entries: [
          { name: "b.ts", dir: false },
          { name: ".git", dir: true },
          { name: "src", dir: true },
          { name: "sys.dat", dir: false, hidden: true },
          { name: "a.ts", dir: false },
        ],
      },
    };
    const fs = remoteFsBackend("h1");
    expect(await fs.readDir("C:\\proj", false)).toEqual([
      { name: "src", path: "C:\\proj\\src", is_dir: true },
      { name: "a.ts", path: "C:\\proj\\a.ts", is_dir: false },
      { name: "b.ts", path: "C:\\proj\\b.ts", is_dir: false },
    ]);
    expect((await fs.readDir("C:\\proj", true)).map((e) => e.name)).toEqual([".git", "src", "a.ts", "b.ts", "sys.dat"]);
  });

  it("sends delete, rename and create as fs requests", async () => {
    reply = { response: { kind: "done", path: "x" } };
    sent.length = 0;
    const fs = remoteFsBackend("h1");
    await fs.remove("/a/b", false);
    await fs.rename("/a/b", "c");
    await fs.create("/a", "d", "dir");
    expect(sent.map((m) => (m as { request: unknown }).request)).toEqual([
      { op: "delete", path: "/a/b" },
      { op: "rename", path: "/a/b", name: "c" },
      { op: "create", path: "/a", name: "d", dir: true },
    ]);
    expect(fs.watch).toBeUndefined();
    expect(fs.search).toBeUndefined();
  });
});
