import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCalls, resetCalls } from "../calls/callStore";
import {
  activatePage,
  addDetectedServer,
  askFromAway,
  clearPageError,
  closePage,
  closePages,
  restorePages,
  setPageControl,
  convertPageToPdf,
  dismissBlockedPage,
  extractLocalServers,
  getBrowser,
  goBack,
  goForward,
  isLocalUrl,
  isPdfTarget,
  isPreviewableFile,
  navigatePage,
  syncPageUrl,
  browserTabsSnapshot,
  openFileFromRemote,
  openUrlFromRemote,
  pageLoadFinished,
  pageLoadStarted,
  setPageError,
  normalizeLocalUrl,
  normalizeTypedUrl,
  openFileInPreview,
  openUrlInPreview,
  removeServersOfTab,
  setBrowserFocusTab,
  setBrowserOpen,
  setServerAlive,
  switchBrowserTab,
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
    syncPageUrl(id, "http://localhost:1/a");
    syncPageUrl(id, "http://localhost:1/b");
    goBack(id);
    goBack(id);
    let page = getBrowser().pages[0];
    expect(page.kind === "url" && page.url).toBe("http://localhost:1/");
    goForward(id);
    syncPageUrl(id, "http://localhost:1/c");
    page = getBrowser().pages[0];
    expect(page.kind === "url" && page.forward).toEqual([]);
    expect(page.kind === "url" && page.back).toEqual(["http://localhost:1/", "http://localhost:1/a"]);
  });

  it("navigatePage only asks: the address follows the view's report", () => {
    openUrlInPreview("http://localhost:1/");
    const id = getBrowser().activeId!;
    navigatePage(id, "http://localhost:1/a");
    let page = getBrowser().pages[0];
    expect(page.kind === "url" && [page.url, page.requestedUrl]).toEqual(["http://localhost:1/", "http://localhost:1/a"]);
    syncPageUrl(id, "http://localhost:1/a");
    page = getBrowser().pages[0];
    expect(page.kind === "url" && [page.url, page.requestedUrl, page.back]).toEqual(["http://localhost:1/a", "http://localhost:1/a", ["http://localhost:1/"]]);
    // back reported by the view (not the store) lands on the same stacks
    syncPageUrl(id, "http://localhost:1/");
    page = getBrowser().pages[0];
    expect(page.kind === "url" && [page.back, page.forward]).toEqual([[], ["http://localhost:1/a"]]);
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
    const wait = whenTabFocused("tab-b")!.promise.then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    setBrowserFocusTab("tab-b");
    await wait;
    expect(done).toBe(true);
  });
});

describe("calls for a background tab", () => {
  beforeEach(() => {
    resetCalls();
    setBrowserFocusTab("tab-a");
    setBrowserOpen(false);
  });

  it("a page opened for another tab raises a browser call that brings it here", () => {
    openUrlInPreview("http://localhost:7", "tab-b");
    const [call] = getCalls();
    expect(call).toMatchObject({ kind: "browser", tabId: "tab-b", detail: "http://localhost:7" });
    call.onOpenHere?.();
    const { pages, activeId, open } = getBrowser();
    expect(activeId).toBe(pages[pages.length - 1].id);
    expect(open).toBe(true);
    expect(takePendingPage("tab-b")).toBeNull();
    expect(getCalls()).toEqual([]);
  });

  it("asks from a bubble about a background tab and answers directly", async () => {
    expect(askFromAway("tab-a", { title: "t", detail: "d", allowLabel: "y", denyLabel: "n" })).toBeNull();
    const answer = askFromAway("tab-b", { title: "t", detail: "d", allowLabel: "y", denyLabel: "n" })!;
    const [call] = getCalls();
    expect(call.options?.map((o) => o.id)).toEqual(["allow", "deny"]);
    call.onOption?.("allow");
    await expect(answer).resolves.toBe(true);
    expect(getCalls()).toEqual([]);
  });

  it("gives the question back to the tab when the user goes there first", async () => {
    const answer = askFromAway("tab-b", { title: "t", detail: "d", allowLabel: "y", denyLabel: "n" })!;
    setBrowserFocusTab("tab-b");
    await expect(answer).resolves.toBeNull();
    expect(getCalls()).toEqual([]);
  });

  it("answered from the bubble, the wait is dropped: going to the tab later changes nothing", async () => {
    const answer = askFromAway("tab-b", { title: "t", detail: "d", allowLabel: "y", denyLabel: "n" })!;
    const [call] = getCalls();
    call.onOption?.("deny");
    await expect(answer).resolves.toBe(false);
    setBrowserFocusTab("tab-b");
    await Promise.resolve();
    expect(getCalls()).toEqual([]);
  });
});

describe("pages opened from the phone", () => {
  beforeEach(() => {
    for (const p of [...getBrowser().pages]) closePage(p.id);
    setBrowserOpen(false);
    setBrowserFocusTab(null);
  });

  it("add a page without opening the panel or taking the active page", () => {
    openUrlInPreview("http://localhost:1");
    setBrowserOpen(false);
    const active = getBrowser().activeId;
    openUrlFromRemote("http://localhost:2", "n1");
    expect(getBrowser().pages).toHaveLength(2);
    expect(getBrowser().open).toBe(false);
    expect(getBrowser().activeId).toBe(active);
    expect(getBrowser().remoteOpened).toEqual({ nonce: "n1", pageId: getBrowser().pages[1].id });
  });
  it("dedupe and turn pdf targets into pdf pages", () => {
    openUrlInPreview("http://localhost:1");
    openUrlFromRemote("http://localhost:1", "n2");
    expect(getBrowser().pages).toHaveLength(1);
    expect(getBrowser().remoteOpened).toEqual({ nonce: "n2", pageId: getBrowser().pages[0].id });
    openFileFromRemote("C:/docs/a.pdf", "n3");
    openFileFromRemote("C:/docs/a.pdf", "n4");
    expect(getBrowser().pages.filter((p) => p.kind === "pdf")).toHaveLength(1);
    openFileFromRemote("C:/docs/a.html", "n5");
    expect(getBrowser().pages[getBrowser().pages.length - 1]).toMatchObject({ kind: "file", path: "C:/docs/a.html" });
  });
  it("make the page active when there was none", () => {
    openUrlFromRemote("http://localhost:9", "n6");
    expect(getBrowser().activeId).toBe(getBrowser().pages[0].id);
    expect(getBrowser().open).toBe(false);
  });
});

describe("browserTabsSnapshot", () => {
  beforeEach(() => {
    for (const p of [...getBrowser().pages]) closePage(p.id);
    for (const s of [...getBrowser().servers]) removeServersOfTab(s.tabId);
  });

  it("maps pages, servers, active and opened", () => {
    openUrlInPreview("http://localhost:1");
    const id = getBrowser().pages[0].id;
    syncPageUrl(id, "http://localhost:2");
    openFileInPreview("C:/a.html");
    openUrlInPreview("https://x.com/s.pdf");
    addDetectedServer("http://localhost:3000", 3000, "tab-z");
    openUrlFromRemote("http://localhost:2", "nn");
    const snap = browserTabsSnapshot(getBrowser());
    const [u, f, p] = getBrowser().pages;
    expect(snap.pages).toEqual([
      { id: u.id, kind: "url", url: "http://localhost:2", canBack: true, canForward: false },
      { id: f.id, kind: "file", path: "C:/a.html" },
      { id: p.id, kind: "pdf", src: "https://x.com/s.pdf" },
    ]);
    expect(snap.servers).toEqual([{ url: "http://localhost:3000", port: 3000, alive: true }]);
    expect(snap.activeId).toBe(p.id);
    expect(snap.opened).toEqual({ nonce: "nn", pageId: u.id });
  });
});

describe("page in front per tab", () => {
  beforeEach(() => {
    for (const p of [...getBrowser().pages]) closePage(p.id);
    setBrowserFocusTab(null);
  });

  it("each tab gets back the page it had in front", () => {
    openUrlInPreview("http://localhost:11");
    const first = getBrowser().activeId!;
    switchBrowserTab("tab-a", "tab-b");
    expect(getBrowser().activeId).toBe(first);
    openUrlInPreview("http://localhost:12");
    const second = getBrowser().activeId!;
    switchBrowserTab("tab-b", "tab-a");
    expect(getBrowser().activeId).toBe(first);
    switchBrowserTab("tab-a", "tab-b");
    expect(getBrowser().activeId).toBe(second);
  });

  it("a closed page is not brought back", () => {
    openUrlInPreview("http://localhost:13");
    const first = getBrowser().activeId!;
    switchBrowserTab("tab-a", "tab-b");
    openUrlInPreview("http://localhost:14");
    const second = getBrowser().activeId!;
    closePage(first);
    switchBrowserTab("tab-b", "tab-a");
    expect(getBrowser().activeId).toBe(second);
  });
});

describe("load errors", () => {
  const urlPage = () => {
    const page = getBrowser().pages[0];
    if (page?.kind !== "url") throw new Error("no url page");
    return page;
  };
  const refused = { kind: "refused" as const, code: "CONNECTION_REFUSED", url: "http://localhost:5173/" };

  beforeEach(() => {
    vi.useFakeTimers();
    for (const p of [...getBrowser().pages]) closePage(p.id);
    openUrlInPreview("http://localhost:5173/");
  });
  afterEach(() => vi.useRealTimers());

  it("keeps an error until a load finishes with no new error", () => {
    const id = urlPage().id;
    setPageError(id, refused);
    expect(urlPage().error?.code).toBe("CONNECTION_REFUSED");
    pageLoadFinished(id);
    vi.advanceTimersByTime(299);
    expect(urlPage().error).toBeDefined();
    vi.advanceTimersByTime(2);
    expect(urlPage().error).toBeUndefined();
  });

  it("an error arriving right after finished wins", () => {
    const id = urlPage().id;
    pageLoadFinished(id);
    vi.advanceTimersByTime(50);
    setPageError(id, refused);
    vi.advanceTimersByTime(1000);
    expect(urlPage().error?.kind).toBe("refused");
    expect(urlPage().retrying).toBe(false);
  });

  it("a started load keeps the error and marks it retrying, the next error stops that", () => {
    const id = urlPage().id;
    setPageError(id, refused);
    pageLoadStarted(id);
    expect(urlPage().error).toBeDefined();
    expect(urlPage().retrying).toBe(true);
    pageLoadFinished(id);
    setPageError(id, { ...refused, kind: "timeout", code: "TIMEOUT" });
    vi.advanceTimersByTime(1000);
    expect(urlPage().error?.kind).toBe("timeout");
    expect(urlPage().retrying).toBe(false);
  });

  it("a started load on a page without error changes nothing", () => {
    const before = urlPage();
    pageLoadStarted(before.id);
    expect(urlPage()).toBe(before);
  });

  it("a later finished replaces the pending one", () => {
    const id = urlPage().id;
    setPageError(id, refused);
    pageLoadFinished(id);
    vi.advanceTimersByTime(200);
    pageLoadFinished(id);
    vi.advanceTimersByTime(200);
    expect(urlPage().error).toBeDefined();
    vi.advanceTimersByTime(101);
    expect(urlPage().error).toBeUndefined();
  });

  it("clearPageError drops both the error and the retry mark", () => {
    const id = urlPage().id;
    setPageError(id, refused);
    pageLoadStarted(id);
    clearPageError(id);
    expect(urlPage().error).toBeUndefined();
    expect(urlPage().retrying).toBeUndefined();
  });

  it("back from a blocked address closes the page that opened on it, else returns to where it is", () => {
    const id = urlPage().id;
    setPageError(id, { kind: "blocked", code: "BLOCKED_LOCAL_ORIGIN", url: "http://localhost:5173/" });
    dismissBlockedPage(id);
    expect(getBrowser().pages).toHaveLength(0);

    openUrlInPreview("http://example.com/");
    const second = urlPage().id;
    navigatePage(second, "http://127.0.0.1:1420/");
    setPageError(second, { kind: "blocked", code: "BLOCKED_LOCAL_ORIGIN", url: "http://127.0.0.1:1420/" });
    dismissBlockedPage(second);
    expect(urlPage().error).toBeUndefined();
    expect(urlPage().requestedUrl).toBe("http://example.com/");
  });
});

describe("pages opened for a tab", () => {
  it("remember the tab, for the folder of a diagnosis", () => {
    for (const p of [...getBrowser().pages]) closePage(p.id);
    openUrlInPreview("http://localhost:7001/", "tab-z");
    const page = getBrowser().pages[0];
    expect(page?.kind === "url" && page.fromTabId).toBe("tab-z");
  });
});

describe("closePages / restorePages", () => {
  beforeEach(() => {
    for (const p of [...getBrowser().pages]) closePage(p.id);
  });

  function openFour() {
    for (const n of [1, 2, 3, 4]) openUrlInPreview(`http://localhost:${n}`);
    return getBrowser().pages.map((p) => p.id);
  }

  it("returns null for unknown ids", () => {
    openFour();
    expect(closePages(["nope"])).toBeNull();
    expect(getBrowser().pages).toHaveLength(4);
  });

  it("picks the first survivor at or after the active page, else the last", () => {
    const ids = openFour();
    activatePage(ids[1]);
    closePages([ids[1], ids[2]]);
    expect(getBrowser().activeId).toBe(ids[3]);
    activatePage(ids[3]);
    closePages([ids[3]]);
    expect(getBrowser().activeId).toBe(ids[0]);
    closePages([ids[0]]);
    expect(getBrowser().activeId).toBeNull();
  });

  it("restores order and active page, dropping control and history", () => {
    const ids = openFour();
    activatePage(ids[1]);
    setPageControl(ids[2], { owner: { kind: "chat", id: "c1" }, paused: false });
    syncPageUrl(ids[1], "http://localhost:22");
    const closed = closePages([ids[1], ids[2]])!;
    expect(closed.pages.map((e) => e.index)).toEqual([1, 2]);
    restorePages(closed);
    const pages = getBrowser().pages;
    expect(pages.map((p) => p.id)).toEqual(ids);
    expect(getBrowser().activeId).toBe(ids[1]);
    for (const p of pages.slice(1, 3)) {
      if (p.kind !== "url") throw new Error("url expected");
      expect(p.control).toBeUndefined();
      expect(p.back).toEqual([]);
      expect(p.forward).toEqual([]);
      expect(p.requestedUrl).toBe(p.url);
    }
  });

  it("skips pages already open", () => {
    const ids = openFour();
    const closed = closePages([ids[0]])!;
    openUrlInPreview("http://localhost:1");
    const before = getBrowser().pages.length;
    restorePages(closed);
    expect(getBrowser().pages).toHaveLength(before);
  });
});
