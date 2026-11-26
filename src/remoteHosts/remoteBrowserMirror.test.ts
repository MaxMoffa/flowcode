import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (_cmd: string, _args?: unknown) => 41000);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

import { browserTabsSnapshot, closePage, dropMirroredPages, getBrowser, navigatePage, restorePages, closePages, setMirrorHooks, upsertMirroredPage, type MirrorTag } from "../browser/browserStore";
import { toHostUrl } from "../browser/mirrorUrl";
import { mirrorKey, mirrorTarget } from "./remoteBrowserMirror";

const tag = (remoteId: string, key = "k"): MirrorTag => ({ hostId: "h1", remoteId, key });

describe("a remote browser tab as a page here", () => {
  beforeEach(() => {
    invoke.mockClear();
    dropMirroredPages("h1");
    dropMirroredPages("h2");
  });

  it("keys change exactly when the page changes", () => {
    expect(mirrorKey({ id: "p", kind: "url", url: "http://a", canBack: false, canForward: true })).toBe(mirrorKey({ id: "p", kind: "url", url: "http://a", canBack: true, canForward: false }));
    expect(mirrorKey({ id: "p", kind: "url", url: "http://a", canBack: false, canForward: false })).not.toBe(mirrorKey({ id: "p", kind: "url", url: "http://b", canBack: false, canForward: false }));
  });

  it("opens loopback pages and files of the page's folder through a tunnel, external ones directly", async () => {
    expect(await mirrorTarget("h1", { id: "p1", kind: "url", url: "http://localhost:3000/x?y=1", canBack: false, canForward: false })).toEqual({ kind: "url", url: "http://localhost:41000/x?y=1" });
    expect(invoke).toHaveBeenLastCalledWith("remote_host_tunnel", { id: "h1", port: 3000 });
    expect(await mirrorTarget("h1", { id: "p2", kind: "url", url: "https://example.com/", canBack: false, canForward: false })).toEqual({ kind: "url", url: "https://example.com/" });
    expect(await mirrorTarget("h1", { id: "p3", kind: "file", path: "C:\\proj\\my page.html" })).toEqual({ kind: "url", url: "http://localhost:41000/my%20page.html" });
    expect(invoke).toHaveBeenLastCalledWith("remote_host_tunnel", { id: "h1", pageId: "p3" });
    expect(await mirrorTarget("h1", { id: "p4", kind: "pdf", src: "/home/me/doc.pdf" })).toEqual({ kind: "pdf", src: "http://localhost:41000/doc.pdf" });
    expect(await mirrorTarget("h1", { id: "p5", kind: "pdf", src: "https://example.com/a.pdf" })).toEqual({ kind: "pdf", src: "https://example.com/a.pdf" });
  });

  it("updates a mirrored page in place when the other PC navigates, and ignores our own changes", () => {
    const id = upsertMirroredPage(tag("p1", "url|a"), { kind: "url", url: "http://localhost:41000/" });
    expect(upsertMirroredPage(tag("p1", "url|a"), { kind: "url", url: "http://localhost:41000/" })).toBe(id);
    const page = () => getBrowser().pages.find((p) => p.id === id);
    expect(page()).toMatchObject({ requestedUrl: "http://localhost:41000/" });
    expect(upsertMirroredPage(tag("p1", "url|b"), { kind: "url", url: "http://localhost:41000/b" })).toBe(id);
    expect(page()).toMatchObject({ requestedUrl: "http://localhost:41000/b", mirror: { key: "url|b" } });
  });

  it("reloads a page whose tunnel moved even when the other PC did not change it", () => {
    const id = upsertMirroredPage({ ...tag("p1", "url|a"), origin: "http://localhost:3000/" }, { kind: "url", url: "http://localhost:41000/" });
    const page = () => getBrowser().pages.find((p) => p.id === id);
    expect(upsertMirroredPage(tag("p1", "url|a"), { kind: "url", url: "http://localhost:42000/" })).toBe(id);
    expect(page()).toMatchObject({ requestedUrl: "http://localhost:42000/", mirror: { key: "url|a", local: "http://localhost:42000/" } });
  });

  it("maps the tunnel address back to the other PC's, and shows it that way", () => {
    const t = { local: "http://localhost:41000/", origin: "http://localhost:3000/" };
    expect(toHostUrl("http://localhost:41000/x?y=1#z", t)).toBe("http://localhost:3000/x?y=1#z");
    expect(toHostUrl("http://127.0.0.1:41000/x", t)).toBe("http://localhost:3000/x");
    expect(toHostUrl("http://localhost:5000/x", t)).toBe("http://localhost:5000/x");
    expect(toHostUrl("https://example.com:41000/", t)).toBe("https://example.com:41000/");
    expect(toHostUrl("http://localhost:41000/", { local: "http://localhost:41000/", origin: "https://localhost/" })).toBe("https://localhost/");
    expect(toHostUrl("http://localhost:41000/", {})).toBe("http://localhost:41000/");
  });

  it("drops what the other PC closed or left, without telling it, and keeps other hosts' pages", () => {
    const close = vi.fn();
    setMirrorHooks({ close, navigate: vi.fn() });
    upsertMirroredPage(tag("p1"), { kind: "url", url: "http://x/" });
    upsertMirroredPage(tag("p2"), { kind: "url", url: "http://y/" });
    upsertMirroredPage({ hostId: "h2", remoteId: "p1", key: "k" }, { kind: "url", url: "http://z/" });
    dropMirroredPages("h1", new Set(["p2"]));
    expect(getBrowser().pages.map((p) => p.mirror?.remoteId + "@" + p.mirror?.hostId)).toEqual(["p2@h1", "p1@h2"]);
    dropMirroredPages("h1");
    expect(getBrowser().pages.some((p) => p.mirror?.hostId === "h1")).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(getBrowser().pages.some((p) => p.mirror?.hostId === "h2")).toBe(true);
  });

  it("tells the other PC when the user closes or navigates a mirrored page, and does not bring a closed one back", () => {
    const close = vi.fn();
    const navigate = vi.fn();
    setMirrorHooks({ close, navigate });
    const id = upsertMirroredPage(tag("p1"), { kind: "url", url: "http://x/" });
    navigatePage(id, "http://typed/");
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining(tag("p1")), "http://typed/");
    expect(getBrowser().pages[0]).toMatchObject({ requestedUrl: "http://x/" });
    const closed = closePages([id]);
    expect(close).toHaveBeenCalledWith(expect.objectContaining(tag("p1")));
    restorePages(closed!);
    expect(getBrowser().pages.some((p) => p.id === id)).toBe(false);
    const id2 = upsertMirroredPage(tag("p2"), { kind: "url", url: "http://y/" });
    closePage(id2);
    expect(close).toHaveBeenLastCalledWith(expect.objectContaining(tag("p2")));
  });

  it("does not share mirrored pages with the phone", () => {
    const id = upsertMirroredPage(tag("p1"), { kind: "url", url: "http://x/" }, true);
    expect(getBrowser().activeId).toBe(id);
    const snap = browserTabsSnapshot(getBrowser());
    expect(snap.pages).toEqual([]);
    expect(snap.activeId).toBeNull();
  });
});
