// The in-app browser on the desktop's tabs: which tab this phone shows (never sent), and the
// requests that open, navigate or close shared tabs. See docs/design/mobile-browser-tabs-plan.md.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BrowserOp, BrowserTabPage } from "../../shared/remote-types";
import { deskPageToPage, pageToOp, type Page } from "./browserUrl";
import { sendBrowserOp, useBrowserTabs, useSupports } from "./remote";

/** What a page open on screen can be: an iframe page, or a placeholder (no iframe). */
export type Shown = ReturnType<typeof deskPageToPage>;

/** How long a requested tab is waited for before the local page simply stays. */
const OPEN_WAIT_MS = 3000;

export interface BrowserTabsSync {
  /** Whether the desktop shares its tabs; otherwise the browser keeps its own history. */
  synced: boolean;
  tabs: BrowserTabPage[];
  servers: { url: string; port: number; alive: boolean }[];
  /** The desktop's own active tab (the list marks it "PC"). */
  pcActiveId: string | null;
  /** The tab this phone has selected (while `isLocal`, a page of its own is on screen instead). */
  activeId: string | null;
  activeTab: BrowserTabPage | undefined;
  shown: Shown | undefined;
  /** A page requested from here is on screen before its tab exists, or an address typed in a tab is loading. */
  isLocal: boolean;
  select: (id: string) => void;
  /** Opens a page as a shared tab, showing it right away. */
  visit: (page: Page) => void;
  /** Loads an address in the active url tab. */
  navigate: (id: string, page: Page & { kind: "port" }) => void;
  close: (id: string) => void;
  /** Closes several tabs (one `close` each, so older desktops work); returns the closed pages in list order, for `reopen`. */
  closeMany: (ids: string[]) => BrowserTabPage[];
  /**
   * Opens closed pages again without switching what this phone shows (no `waiting`, no `local`).
   * They come back at the end of the desktop's list, and without their history. Files and local PDFs
   * can't be restored (see `reopenOp`); returns how many were.
   */
  reopen: (pages: BrowserTabPage[]) => number;
  step: (id: string, dir: "back" | "forward") => void;
}

let nonceCount = 0;
const newNonce = () => `${Date.now().toString(36)}${(nonceCount++).toString(36)}`;

/**
 * The request that brings a closed tab back. Only addresses can be restored: the `openFile` op
 * needs a chat/terminal root and a path relative to it, which a closed file or local PDF no longer has.
 */
export function reopenOp(p: BrowserTabPage, nonce: string): BrowserOp | null {
  if (p.kind === "url") return { op: "openUrl", url: p.url, nonce };
  if (p.kind === "pdf" && /^https?:\/\//i.test(p.src)) return { op: "openUrl", url: p.src, nonce };
  return null;
}

export function useBrowserTabsSync(): BrowserTabsSync {
  const cap = useSupports("browserTabs");
  const snapshot = useBrowserTabs();
  const synced = cap && snapshot !== null;
  const tabs = useMemo(() => snapshot?.pages ?? [], [snapshot]);

  const [chosen, setChosen] = useState<string | null>(null);
  // A page shown straight from the phone's own address while the desktop's tab is on its way.
  const [local, setLocal] = useState<{ page: Page; navigatingFrom?: string } | null>(null);
  const waiting = useRef<{ nonce: string; until: number } | null>(null);
  const previousIds = useRef<string[]>([]);

  const exists = (id: string | null) => id !== null && tabs.some((p) => p.id === id);
  const activeId = exists(chosen) ? chosen : exists(snapshot?.activeId ?? null) ? snapshot!.activeId : (tabs[0]?.id ?? null);
  const activeTab = tabs.find((p) => p.id === activeId);

  // The tab this phone chose was closed: the neighbour takes its place.
  useEffect(() => {
    const ids = tabs.map((p) => p.id);
    const before = previousIds.current;
    previousIds.current = ids;
    if (chosen === null || ids.includes(chosen)) return;
    const at = before.indexOf(chosen);
    setChosen(at < 0 ? null : (ids[Math.min(at, ids.length - 1)] ?? null));
  }, [tabs, chosen]);

  // The desktop answered an open this phone asked for: show that tab.
  useEffect(() => {
    const opened = snapshot?.opened;
    const w = waiting.current;
    if (!opened || !w || opened.nonce !== w.nonce || Date.now() > w.until || !exists(opened.pageId)) return;
    waiting.current = null;
    setChosen(opened.pageId);
    setLocal(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  // The desktop's tab moved to the address typed here: the local copy is no longer needed.
  const activeUrl = activeTab?.kind === "url" ? activeTab.url : null;
  useEffect(() => {
    if (local?.navigatingFrom !== undefined && activeUrl !== null && activeUrl !== local.navigatingFrom) setLocal(null);
  }, [activeUrl, local]);

  const select = useCallback((id: string) => {
    waiting.current = null;
    setLocal(null);
    setChosen(id);
  }, []);

  const visit = useCallback((page: Page) => {
    if (page.kind === "deskFile") {
      select(page.pageId);
      return;
    }
    const nonce = newNonce();
    const op = pageToOp(page, nonce);
    setLocal({ page });
    if (!op) return;
    waiting.current = { nonce, until: Date.now() + OPEN_WAIT_MS };
    sendBrowserOp(op);
  }, [select]);

  const navigate = useCallback((id: string, page: Page & { kind: "port" }) => {
    setLocal({ page, navigatingFrom: activeUrl ?? "" });
    sendBrowserOp({ op: "navigate", id, url: `http://localhost:${page.port}${page.path}` });
  }, [activeUrl]);

  const shown: Shown | undefined = useMemo(() => (local ? local.page : activeTab ? deskPageToPage(activeTab) : undefined), [local, activeTab]);

  return {
    synced,
    tabs,
    servers: snapshot?.servers ?? [],
    pcActiveId: snapshot?.activeId ?? null,
    activeId,
    activeTab,
    shown,
    isLocal: local !== null,
    select,
    visit,
    navigate,
    close: (id) => sendBrowserOp({ op: "close", id }),
    closeMany: (ids) => {
      const set = new Set(ids);
      const closed = tabs.filter((p) => set.has(p.id));
      for (const p of closed) sendBrowserOp({ op: "close", id: p.id });
      return closed;
    },
    reopen: (pages) => {
      let n = 0;
      for (const p of pages) {
        const op = reopenOp(p, newNonce());
        if (!op) continue;
        sendBrowserOp(op);
        n++;
      }
      return n;
    },
    step: (id, dir) => sendBrowserOp({ op: dir, id }),
  };
}
