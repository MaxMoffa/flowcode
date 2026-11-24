import { describe, expect, it } from "vitest";
import { absoluteRemote, joinRemote } from "./remoteFiles";
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
