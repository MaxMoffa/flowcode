import { beforeEach, describe, expect, it } from "vitest";
import {
  activatePage,
  addDetectedServer,
  closePage,
  convertPageToPdf,
  extractLocalServers,
  getBrowser,
  goBack,
  goForward,
  isLocalUrl,
  isPdfTarget,
  isPreviewableFile,
  navigatePage,
  normalizeLocalUrl,
  normalizeTypedUrl,
  openFileInPreview,
  openUrlInPreview,
  removeServersOfTab,
  setBrowserFocusTab,
  setBrowserOpen,
  setServerAlive,
  takePendingPage,
  whenTabFocused,
} from "./browserStore";

describe("isLocalUrl", () => {
  it("accepts loopback hosts", () => {
    for (const u of ["http://localhost:3000", "http://127.0.0.1/", "http://0.0.0.0:8080", "http://[::1]:5173", "http://app.localhost"]) {
      expect(isLocalUrl(u)).toBe(true);
    }
  });
  it("rejects the rest", () => {
    for (const u of ["https://example.com", "http://localhost.evil.com", "nonsense"]) expect(isLocalUrl(u)).toBe(false);
  });
});

describe("normalizeLocalUrl", () => {
  it("rewrites unspecified addresses to localhost", () => {
    expect(normalizeLocalUrl("http://0.0.0.0:3000/a")).toBe("http://localhost:3000/a");
    expect(normalizeLocalUrl("http://[::]:3000/")).toBe("http://localhost:3000/");
  });
  it("leaves other urls alone", () => {
    expect(normalizeLocalUrl("http://127.0.0.1:3000/")).toBe("http://127.0.0.1:3000/");
    expect(normalizeLocalUrl("junk")).toBe("junk");
  });
});

describe("normalizeTypedUrl", () => {
  it("adds https to bare hosts", () => {
    expect(normalizeTypedUrl("example.com/x")).toBe("https://example.com/x");
  });
  it("uses http for local addresses", () => {
    expect(normalizeTypedUrl("localhost:3000")).toBe("http://localhost:3000/");
    expect(normalizeTypedUrl("127.0.0.1:8080/a")).toBe("http://127.0.0.1:8080/a");
    expect(normalizeTypedUrl(":5173")).toBe("http://localhost:5173/");
  });
  it("keeps an explicit scheme", () => {
    expect(normalizeTypedUrl("http://example.com")).toBe("http://example.com/");
  });
  it("returns null for empty, invalid or non-http input", () => {
    expect(normalizeTypedUrl("")).toBeNull();
    expect(normalizeTypedUrl("   ")).toBeNull();
    expect(normalizeTypedUrl("two words")).toBeNull();
    expect(normalizeTypedUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeTypedUrl("javascript://x")).toBeNull();
  });
});

describe("isPreviewableFile", () => {
  it("matches the supported extensions, case-insensitive", () => {
    expect(isPreviewableFile("C:\\a\\Report.HTML")).toBe(true);
    expect(isPreviewableFile("/x/y.webm")).toBe(true);
    expect(isPreviewableFile("a.svg")).toBe(true);
  });
  it("rejects others", () => {
    expect(isPreviewableFile("a.ts")).toBe(false);
    expect(isPreviewableFile("html")).toBe(false);
    expect(isPreviewableFile("dir.html/file")).toBe(false);
  });
});

describe("store", () => {
  beforeEach(() => {
    for (const p of [...getBrowser().pages]) closePage(p.id);
    for (const s of [...getBrowser().servers]) removeServersOfTab(s.tabId);
  });

  it("dedupes pages and activates them", () => {
    openUrlInPreview("http://localhost:1");
    openUrlInPreview("http://localhost:2");
    openUrlInPreview("http://localhost:1");
    openFileInPreview("/a/b.html");
    openFileInPreview("/a/b.html");
    const { pages, activeId, open } = getBrowser();
    expect(pages).toHaveLength(3);
    expect(activeId).toBe(pages[2].id);
    expect(open).toBe(true);
    activatePage(pages[0].id);
    expect(getBrowser().activeId).toBe(pages[0].id);
  });

  it("activates the neighbour on close", () => {
    openUrlInPreview("http://localhost:1");
    openUrlInPreview("http://localhost:2");
    openUrlInPreview("http://localhost:3");
    const [a, b, c] = getBrowser().pages;
    activatePage(b.id);
    closePage(b.id);
    expect(getBrowser().activeId).toBe(c.id);
    closePage(c.id);
    expect(getBrowser().activeId).toBe(a.id);
    closePage(a.id);
    expect(getBrowser().activeId).toBeNull();
  });

  it("keeps back/forward history", () => {
    openUrlInPreview("http://localhost:1/");
    const id = getBrowser().activeId!;
    navigatePage(id, "http://localhost:1/a");
    navigatePage(id, "http://localhost:1/b");
    goBack(id);
    goBack(id);
    let page = getBrowser().pages[0];
    expect(page.kind === "url" && page.url).toBe("http://localhost:1/");
    goForward(id);
    navigatePage(id, "http://localhost:1/c");
    page = getBrowser().pages[0];
    expect(page.kind === "url" && page.forward).toEqual([]);
    expect(page.kind === "url" && page.back).toEqual(["http://localhost:1/", "http://localhost:1/a"]);
  });

  it("tracks detected servers by port", () => {
    expect(addDetectedServer("http://localhost:5173", 5173, "t1")).toBe(true);
    expect(addDetectedServer("http://localhost:5173", 5173, "t2")).toBe(false);
    setServerAlive(5173, false);
    expect(getBrowser().servers[0].alive).toBe(false);
    removeServersOfTab("t1");
    expect(getBrowser().servers).toHaveLength(0);
  });
});

describe("extractLocalServers", () => {
  it("reads a Vite banner through its colour codes", () => {
    const text = "  [32m➜[39m  [1mLocal[22m:   [36mhttp://localhost:[1m5173[22m/[39m";
    expect(extractLocalServers(text)).toEqual([{ url: "http://localhost:5173/", port: 5173 }]);
  });
  it("reads a plain Next address", () => {
    expect(extractLocalServers("- Local: http://localhost:3000")).toEqual([{ url: "http://localhost:3000", port: 3000 }]);
  });
  it("turns 0.0.0.0 into localhost", () => {
    expect(extractLocalServers("Serving on http://0.0.0.0:8000/")).toEqual([{ url: "http://localhost:8000/", port: 8000 }]);
  });
  it("drops trailing punctuation", () => {
    expect(extractLocalServers("try http://127.0.0.1:8080/api.")).toEqual([{ url: "http://127.0.0.1:8080/api", port: 8080 }]);
  });
  it("ignores addresses without a port", () => {
    expect(extractLocalServers("see http://localhost/ and https://example.com:443/")).toEqual([]);
  });
});

describe("isPdfTarget", () => {
  it("matches pdf urls ignoring query and hash", () => {
    expect(isPdfTarget("https://x.com/a/doc.pdf?download=1#page=2")).toBe(true);
    expect(isPdfTarget("https://x.com/DOC.PDF")).toBe(true);
    expect(isPdfTarget("https://x.com/doc%2Epdf")).toBe(true);
  });
  it("rejects non-pdf urls", () => {
    expect(isPdfTarget("https://x.com/doc.html?f=a.pdf")).toBe(false);
    expect(isPdfTarget("https://x.com/")).toBe(false);
  });
  it("matches local paths", () => {
    expect(isPdfTarget("C:\docs\Report.PDF")).toBe(true);
    expect(isPdfTarget("/home/u/a.pdf")).toBe(true);
    expect(isPdfTarget("C:\docs\a.txt")).toBe(false);
  });
});

describe("pdf pages", () => {
  it("opens a pdf url as a pdf page and dedupes", () => {
    openUrlInPreview("https://x.com/pdf-a.pdf?v=1");
    openUrlInPreview("https://x.com/pdf-a.pdf?v=1");
    const pages = getBrowser().pages.filter((p) => p.kind === "pdf" && p.src === "https://x.com/pdf-a.pdf?v=1");
    expect(pages).toHaveLength(1);
    expect(getBrowser().activeId).toBe(pages[0].id);
  });
  it("opens a local pdf file in the viewer", () => {
    openFileInPreview("C:\docs\pdf-b.pdf");
    expect(getBrowser().pages.some((p) => p.kind === "pdf" && p.src === "C:\docs\pdf-b.pdf")).toBe(true);
  });
  it("converts a url page in place", () => {
    openUrlInPreview("https://x.com/convert-me");
    const before = getBrowser().pages;
    const index = before.findIndex((p) => p.kind === "url" && p.url === "https://x.com/convert-me");
    const id = before[index].id;
    convertPageToPdf(id, "https://x.com/convert-me");
    const after = getBrowser();
    expect(after.pages[index]).toEqual({ id, kind: "pdf", src: "https://x.com/convert-me" });
    expect(after.activeId).toBe(id);
    expect(after.pages).toHaveLength(before.length);
  });
});

describe("pages opened for a background tab", () => {
  beforeEach(() => {
    for (const p of [...getBrowser().pages]) closePage(p.id);
    setBrowserOpen(false);
    setBrowserFocusTab("tab-a");
  });

  it("wait for their own tab instead of opening over the one on screen", () => {
    openUrlInPreview("http://localhost:1", "tab-a");
    const shown = getBrowser().activeId;
    setBrowserOpen(false);
    openUrlInPreview("http://localhost:2", "tab-b");
    const { pages, activeId, open } = getBrowser();
    expect(pages).toHaveLength(2);
    expect(activeId).toBe(shown);
    expect(open).toBe(false);
    expect(takePendingPage("tab-a")).toBeNull();
    expect(takePendingPage("tab-b")).toBe(pages[1].id);
    expect(takePendingPage("tab-b")).toBeNull();
  });

  it("open normally without an origin tab or from the tab on screen", () => {
    openFileInPreview("/a/b.html");
    expect(getBrowser().open).toBe(true);
    setBrowserOpen(false);
    openFileInPreview("/a/c.html", "tab-a");
    expect(getBrowser().open).toBe(true);
  });

  it("drop a pending page that was closed meanwhile", () => {
    openUrlInPreview("http://localhost:3", "tab-b");
    closePage(getBrowser().pages[0].id);
    expect(takePendingPage("tab-b")).toBeNull();
  });
});

describe("whenTabFocused", () => {
  it("is null for the tab on screen and resolves when another one comes forward", async () => {
    setBrowserFocusTab("tab-a");
    expect(whenTabFocused("tab-a")).toBeNull();
    expect(whenTabFocused(undefined)).toBeNull();
    let done = false;
    const wait = whenTabFocused("tab-b")!.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    setBrowserFocusTab("tab-b");
    await wait;
    expect(done).toBe(true);
  });
});
