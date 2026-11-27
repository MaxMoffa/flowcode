import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FsRequest, FsResponse } from "../../shared/remote-types";

const requests: FsRequest[] = [];
let reply: FsResponse = { kind: "done", path: "/x" };
vi.mock("./hostRequest", () => ({
  hostRequest: (_host: string, _kind: string, build: (id: string) => { request: FsRequest }) => {
    requests.push(build("r").request);
    return Promise.resolve({ response: reply });
  },
}));

import { remoteFsBackend, searchRemoteDirs } from "./remoteFs";

describe("remote file system optional ops", () => {
  beforeEach(() => {
    requests.length = 0;
  });

  it("offers search, duplicate and info only with the host's caps", () => {
    const old = remoteFsBackend("h", []);
    expect(old.search).toBeUndefined();
    expect(old.duplicate).toBeUndefined();
    expect(old.info).toBeUndefined();
    const full = remoteFsBackend("h", ["fsSearch", "fsExtra"]);
    expect(full.search && full.duplicate && full.info).toBeTruthy();
  });

  it("maps search hits to explorer entries", async () => {
    reply = { kind: "search", entries: [{ name: "a", path: "/p/a", dir: true }] };
    const fs = remoteFsBackend("h", ["fsSearch"]);
    expect(await fs.search?.("/p", "a", true, 1)).toEqual([{ name: "a", path: "/p/a", is_dir: true }]);
    expect(await searchRemoteDirs("h", "/p", "a", 2)).toEqual([{ name: "a", path: "/p/a", is_dir: true }]);
    expect(requests).toEqual([
      { op: "search", path: "/p", query: "a", showHidden: true },
      { op: "search", path: "/p", query: "a", dirsOnly: true, maxDepth: 2 },
    ]);
  });

  it("duplicates and reads info through the fs ops", async () => {
    const fs = remoteFsBackend("h", ["fsExtra"]);
    reply = { kind: "done", path: "/p/a copy" };
    await fs.duplicate?.("/p/a");
    const info = { name: "a", path: "/p/a", is_dir: false, size: 3, entry_count: null, modified: null, created: null, permissions_mode: null, readonly: false };
    reply = { kind: "info", info };
    expect(await fs.info?.("/p/a")).toEqual(info);
    expect(requests).toEqual([{ op: "duplicate", path: "/p/a" }, { op: "info", path: "/p/a" }]);
  });
});
