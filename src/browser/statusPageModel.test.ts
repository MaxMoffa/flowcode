import { describe, expect, it } from "vitest";
import type { PageError } from "./browserStore";
import { detailLines, detailsText, hostOfUrl, portOfUrl, statusPageFor } from "./statusPageModel";

const err = (kind: PageError["kind"], url = "https://example.com/"): PageError => ({ kind, code: "X", url, at: 0 });

describe("statusPageFor", () => {
  it("a refused loopback address is the dead dev server, any other refusal is unreachable", () => {
    expect(statusPageFor(err("refused", "http://localhost:5173/"))).toBe("local");
    expect(statusPageFor(err("refused", "http://127.0.0.1:3000/"))).toBe("local");
    expect(statusPageFor(err("refused"))).toBe("offline");
  });
  it("maps the other kinds", () => {
    expect(statusPageFor(err("dns"))).toBe("offline");
    expect(statusPageFor(err("offline"))).toBe("offline");
    expect(statusPageFor(err("other"))).toBe("offline");
    for (const kind of ["timeout", "cert", "blocked", "crash"] as const) expect(statusPageFor(err(kind))).toBe(kind);
  });
});

describe("urls", () => {
  it("reads host and port, with the scheme's default port", () => {
    expect(hostOfUrl("https://a.b:8080/x")).toBe("a.b:8080");
    expect(hostOfUrl("junk")).toBe("junk");
    expect(portOfUrl("http://localhost:5173/")).toBe("5173");
    expect(portOfUrl("https://a.b/")).toBe("443");
    expect(portOfUrl("junk")).toBe("");
  });
});

describe("details", () => {
  it("lists the live ports for a dead local server and the new tab only", () => {
    const ports = detailLines("local", err("refused", "http://localhost:1/"), [{ port: 1420 }, { port: 6006 }]);
    expect(ports.find((l) => l.label === "browser.page.detail.ports")?.value).toBe(":1420 :6006");
    expect(detailLines("cert", err("cert"), [{ port: 1 }]).some((l) => l.label === "browser.page.detail.ports")).toBe(false);
    expect(detailLines("newtab", null, [])).toEqual([{ label: "browser.page.detail.ports", value: "-" }]);
  });
  it("writes plain text for the clipboard", () => {
    expect(detailsText("E", "http://x/", "", [{ label: "kind", value: "refused" }])).toBe("E · http://x/\nkind: refused");
  });
});
