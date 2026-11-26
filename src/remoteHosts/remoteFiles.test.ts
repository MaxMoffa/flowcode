import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

let listCalls = 0;
let listReply: () => Promise<unknown> = () => Promise.resolve({ response: { kind: "list", entries: [], truncated: false } });
vi.mock("./hostRequest", () => ({
  hostRequest: () => {
    listCalls++;
    return listReply();
  },
}));

import { absoluteRemote, checkRemotePath, joinRemote } from "./remoteFiles";
import { relativeToFolder } from "./RemoteLinks";
import { loopbackPort } from "./remoteTunnel";

describe("paths of another PC", () => {
  it("joins with the separator the folder uses", () => {
    expect(joinRemote("/home/me/", "a.ts")).toBe("/home/me/a.ts");
    expect(joinRemote("C:\\proj", "a.ts")).toBe("C:\\proj\\a.ts");
  });

  it("places relative paths in the folder and folds . and ..", () => {
    expect(absoluteRemote("src/a.ts", "/home/me/proj")).toBe("/home/me/proj/src/a.ts");
    expect(absoluteRemote("./src/../b.ts", "/home/me/proj")).toBe("/home/me/proj/b.ts");
    expect(absoluteRemote("src\\a.ts", "C:\\proj")).toBe("C:\\proj\\src\\a.ts");
    expect(absoluteRemote("C:\\proj\\x\\..\\a.ts", null)).toBe("C:\\proj\\a.ts");
    expect(absoluteRemote("/etc/hosts", null)).toBe("/etc/hosts");
    expect(absoluteRemote("a.ts", null)).toBeNull();
  });

  it("keeps UNC paths in either spelling", () => {
    expect(absoluteRemote("//wsl.localhost/Ubuntu/home/me/a.ts", null)).toBe("//wsl.localhost/Ubuntu/home/me/a.ts");
    expect(absoluteRemote("//wsl.localhost/Ubuntu/home/../a.ts", null)).toBe("//wsl.localhost/Ubuntu/a.ts");
    expect(absoluteRemote("\\\\srv\\share\\x\\a.ts", null)).toBe("\\\\srv\\share\\x\\a.ts");
    expect(absoluteRemote("///etc/hosts", null)).toBe("/etc/hosts");
    expect(absoluteRemote("a.ts", "//wsl.localhost/Ubuntu/home")).toBe("//wsl.localhost/Ubuntu/home/a.ts");
  });

  it("tells whether a path is under a folder", () => {
    expect(relativeToFolder("/home/me/proj/dist/index.html", "/home/me/proj")).toBe("dist/index.html");
    expect(relativeToFolder("dist/index.html", "/home/me/proj")).toBe("dist/index.html");
    expect(relativeToFolder("/home/me/other/a.html", "/home/me/proj")).toBeNull();
    expect(relativeToFolder("/home/me/project2/a.html", "/home/me/proj")).toBeNull();
    expect(relativeToFolder("c:\\Proj\\out\\a.html", "C:\\proj")).toBe("out/a.html");
  });
});

describe("addresses on the other PC's loopback", () => {
  it("finds the port", () => {
    expect(loopbackPort("http://localhost:5173/app")).toBe(5173);
    expect(loopbackPort("http://127.0.0.1:3000")).toBe(3000);
    expect(loopbackPort("http://[::1]:8080/x")).toBe(8080);
    expect(loopbackPort("http://localhost/")).toBe(80);
    expect(loopbackPort("https://localhost/")).toBe(443);
    expect(loopbackPort("http://0.0.0.0:4000")).toBe(4000);
  });

  it("leaves other addresses alone", () => {
    expect(loopbackPort("https://example.com:5173/")).toBeNull();
    expect(loopbackPort("file:///C:/a.html")).toBeNull();
    expect(loopbackPort("not a url")).toBeNull();
  });
});

describe("link lookup in a folder listing", () => {
  const listing = (...names: string[]) => ({ response: { kind: "list", entries: names.map((name) => ({ name, dir: false })), truncated: false } });
  beforeEach(() => {
    vi.useFakeTimers();
    listCalls = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("does not remember a failed listing", async () => {
    listReply = () => Promise.reject(new Error("timeout"));
    expect(await checkRemotePath("h-fail", "a.ts", "/p")).toBeNull();
    listReply = () => Promise.resolve(listing("a.ts"));
    expect((await checkRemotePath("h-fail", "a.ts", "/p"))?.path).toBe("/p/a.ts");
    expect(listCalls).toBe(2);
  });

  it("re-lists once on a miss against an old listing, not a fresh one", async () => {
    listReply = () => Promise.resolve(listing("a.ts"));
    expect(await checkRemotePath("h-miss", "b.ts", "/p")).toBeNull(); // fresh: no second ask
    expect(listCalls).toBe(1);
    vi.advanceTimersByTime(3_000);
    listReply = () => Promise.resolve(listing("a.ts", "b.ts"));
    expect((await checkRemotePath("h-miss", "b.ts", "/p"))?.path).toBe("/p/b.ts");
    expect(listCalls).toBe(2);
  });
});
