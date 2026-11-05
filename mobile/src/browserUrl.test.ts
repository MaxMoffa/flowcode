import { describe, expect, it } from "vitest";
import { localLinkPage, pageLabel, pageSrc, parseTyped, sandboxFor, type Page } from "./browserUrl";

const port = (p: number, path = "/"): Page => ({ kind: "port", port: p, path });

describe("parseTyped", () => {
  it("accepts port forms", () => {
    expect(parseTyped("5173", null)).toEqual(port(5173));
    expect(parseTyped(":5173", null)).toEqual(port(5173));
    expect(parseTyped("localhost:5173", null)).toEqual(port(5173));
    expect(parseTyped("127.0.0.1:5173/a/b?x=1", null)).toEqual(port(5173, "/a/b?x=1"));
    expect(parseTyped("http://localhost:5173/x", null)).toEqual(port(5173, "/x"));
    expect(parseTyped("https://localhost:3000", null)).toEqual(port(3000));
    expect(parseTyped("[::1]:5173", null)).toEqual(port(5173));
    expect(parseTyped("localhost:5173?x=1", null)).toEqual(port(5173, "/?x=1"));
  });
  it("rejects foreign hosts and bad ports", () => {
    expect(parseTyped("example.com:80", null)).toBeNull();
    expect(parseTyped("https://example.com", "p1")).toBeNull();
    expect(parseTyped("192.168.1.2:5173", null)).toBeNull();
    expect(parseTyped("localhost:0", null)).toBeNull();
    expect(parseTyped("localhost:65536", null)).toBeNull();
    expect(parseTyped("", "p1")).toBeNull();
    expect(parseTyped("javascript:alert(1)", "p1")).toBeNull();
    expect(parseTyped("index.html", null)).toBeNull();
  });
  it("accepts relative files only with a terminal", () => {
    expect(parseTyped("index.html", "p1")).toEqual({ kind: "file", ptyId: "p1", path: "index.html" });
    expect(parseTyped("dist/index.html", "p1")).toEqual({ kind: "file", ptyId: "p1", path: "dist/index.html" });
    expect(parseTyped("./a.html", "p1")).toEqual({ kind: "file", ptyId: "p1", path: "a.html" });
    expect(parseTyped("../a.html", "p1")).toBeNull();
    expect(parseTyped("5173", "p1")).toEqual(port(5173));
  });
});

describe("pageSrc", () => {
  const base = (p: string) => `scheme://x/${p}`;
  it("composes port and file URLs", () => {
    expect(pageSrc(port(5173, "/a/b?x=1"), base)).toBe("scheme://x/p/5173/a/b?x=1");
    expect(pageSrc(port(5173), base)).toBe("scheme://x/p/5173/");
    expect(pageSrc({ kind: "file", ptyId: "p1", path: "dist/my file.html" }, base)).toBe("scheme://x/f/p1/dist/my%20file.html");
  });
  it("labels and sandboxes", () => {
    expect(pageLabel(port(5173))).toBe("localhost:5173");
    expect(pageLabel(port(5173, "/a"))).toBe("localhost:5173/a");
    expect(sandboxFor(port(1))).toContain("allow-same-origin");
    expect(sandboxFor({ kind: "file", ptyId: "p", path: "a" })).toBe("allow-scripts");
  });
});

describe("localLinkPage", () => {
  it("turns loopback links into ports", () => {
    expect(localLinkPage("http://localhost:5173/login")).toEqual(port(5173, "/login"));
    expect(localLinkPage("http://127.0.0.1:3000")).toEqual(port(3000));
    expect(localLinkPage("http://0.0.0.0:8080/x")).toEqual(port(8080, "/x"));
  });
  it("leaves everything else to the system browser", () => {
    expect(localLinkPage("https://vite.dev/guide")).toBeNull();
    expect(localLinkPage("http://localhost/x")).toBeNull();
    expect(localLinkPage("mailto:a@b.c")).toBeNull();
    expect(localLinkPage("not a url")).toBeNull();
  });
});
