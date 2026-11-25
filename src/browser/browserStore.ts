import { createStore } from "../lib/externalStore";
import { readBool, writeBool } from "../lib/storage";
import { isPdfTarget } from "../../shared/agentOpen";
import { addCall, removeCallByKey } from "../calls/callStore";
import { t } from "../i18n";
import { basename } from "../lib/path";
import type { BrowserTabPage, BrowserTabsSnapshot } from "../../shared/remote-types";
import { nativeView, type NativeErrorKind } from "./nativeView";
export { isPdfTarget, isPreviewableFile } from "../../shared/agentOpen";

const BROWSER_OPEN_KEY = "flowcode.browserOpen";

/** Who may drive a page: a chat or a terminal tab's agent. */
export interface ControlOwner {
  kind: "chat" | "terminal";
  id: string;
}

/** A page an agent drives (see control.ts). Only pages with this set are visible to the agent. */
export interface PageControl {
  owner: ControlOwner;
  /** The agent's cli name ("claude", "codex"...) when known. */
  agent?: string;
  /** The user touched the page: the agent waits until it is handed back. */
  paused: boolean;
  lastAction?: { summary: string; at: number };
  /** When the agent last used the page (ms epoch): the page picked when it names none. */
  lastUsed?: number;
}

/** Why a page failed to open: what the native view reported (see browser-view-error). */
export interface PageError {
  kind: NativeErrorKind;
  code: string;
  url: string;
  /** When it was reported (ms epoch). */
  at: number;
}

/** Marks a page that mirrors a tab of another PC's browser (see remoteHosts/remoteBrowserMirror). `key` is what the other PC showed
 * last, to tell its own change from ours. */
export interface MirrorTag {
  hostId: string;
  remoteId: string;
  key: string;
}

export type PreviewPage =
  | {
      id: string;
      kind: "url";
      /** Set when this page mirrors a tab of another PC. */
      mirror?: MirrorTag;
      /** Where the page really is (the native view reports it): what the address bar shows. */
      url: string;
      /** What was asked for (typed, an agent, a link): the native view navigates when it changes. */
      requestedUrl: string;
      back: string[];
      forward: string[];
      title?: string;
      /** Data URL of the site's favicon. */
      favicon?: string;
      /** The load failed: our own page stands in for the native view until it loads again. */
      error?: PageError;
      /** A new load started while `error` shows (the page's Retry button spins). */
      retrying?: boolean;
      /** The tab this page was opened for (an agent, a dev server), for the folder of a diagnosis. */
      fromTabId?: string;
      /** An agent drives this page (opened by it, or handed over). */
      control?: PageControl;
    }
  | { id: string; kind: "file"; path: string; mirror?: MirrorTag }
  /** `src` is an http(s) URL or an absolute local path. */
  | { id: string; kind: "pdf"; src: string; mirror?: MirrorTag };

/** A dev server a terminal printed an address for. */
interface DetectedServer {
  url: string;
  port: number;
  tabId: string;
  alive: boolean;
}

export interface BrowserState {
  open: boolean;
  pages: PreviewPage[];
  activeId: string | null;
  servers: DetectedServer[];
  /** The last page the phone asked to open (see openUrlFromRemote). */
  remoteOpened: { nonce: string; pageId: string } | null;
}

// Only `open` outlives the session: the pages point at servers and files that
// may be gone by the next launch.
const store = createStore<BrowserState>({ open: readBool(BROWSER_OPEN_KEY, false), pages: [], activeId: null, servers: [], remoteOpened: null });

export const useBrowser = store.use;
export const getBrowser = store.get;

/** The native view lives in the backend: tell it, never let a missing one (tests, no Tauri) break the store. */
function native(call: () => Promise<unknown>) {
  try {
    void call().catch(() => {});
  } catch {
    /* no Tauri bridge */
  }
}

let nextId = 0;
const newId = () => `page-${++nextId}`;

export function setBrowserOpen(open: boolean | ((prev: boolean) => boolean)) {
  const next = typeof open === "function" ? open(store.get().open) : open;
  writeBool(BROWSER_OPEN_KEY, next);
  store.update((s) => ({ ...s, open: next }));
}

// The tab on screen (App keeps it current). A page opened on behalf of another
// tab - an agent or a dev server running in the background - must not pop the
// Browser over the tab the user is working in: it is added but waits for its
// own tab, which shows it when the user goes back there.
let focusTabId: string | null = null;
const pendingByTab = new Map<string, string>();

const focusWaiters = new Map<string, (() => void)[]>();

export function setBrowserFocusTab(tabId: string | null) {
  focusTabId = tabId;
  if (!tabId) return;
  const waiters = focusWaiters.get(tabId);
  focusWaiters.delete(tabId);
  waiters?.forEach((resolve) => resolve());
}

/** Resolves once `tabId` is the tab on screen; null when it already is (or no
 * tab is known yet), so callers on the tab on screen don't wait a tick. `cancel` drops the wait (answered meanwhile). A tab closed meanwhile never resolves: its
 * page is moot (see forgetBrowserTab). */
export function whenTabFocused(tabId: string | undefined): { promise: Promise<void>; cancel: () => void } | null {
  if (!tabId || !focusTabId || tabId === focusTabId) return null;
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  const list = focusWaiters.get(tabId) ?? [];
  list.push(resolve);
  focusWaiters.set(tabId, list);
  const cancel = () => {
    const left = (focusWaiters.get(tabId) ?? []).filter((w) => w !== resolve);
    if (left.length) focusWaiters.set(tabId, left);
    else focusWaiters.delete(tabId);
  };
  return { promise, cancel };
}

let nextAsk = 0;

/** Asks, in a bubble under `tabId`'s tab, whether its agent may do something the app would otherwise ask about once
 * the user is in that tab. Resolves with the answer given in the bubble, or null when the user went to the tab first
 * (the caller then asks there as usual). Null at once when the tab is on screen. */
export function askFromAway(tabId: string | undefined, { title, detail, allowLabel, denyLabel }: { title: string; detail: string; allowLabel: string; denyLabel: string }): Promise<boolean | null> | null {
  const away = whenTabFocused(tabId);
  if (!tabId || !away) return null;
  return new Promise((resolve) => {
    const key = `ask-open:${tabId}:${++nextAsk}`;
    addCall({
      key,
      tabId,
      kind: "permission",
      title,
      detail,
      options: [
        { id: "allow", label: allowLabel, tone: "primary" },
        { id: "deny", label: denyLabel, tone: "danger" },
      ],
      onOption: (id) => {
        away.cancel();
        removeCallByKey(key);
        resolve(id === "allow");
      },
    });
    void away.promise.then(() => {
      removeCallByKey(key);
      resolve(null);
    });
  });
}

/** What a page is called in a bubble: its address, or the file's name. */
function pageLabel(page: PreviewPage): string {
  return page.kind === "url" ? page.url : page.kind === "file" ? basename(page.path) : basename(page.src);
}

/** The page a background tab opened while the user was elsewhere, once. */
export function takePendingPage(tabId: string): string | null {
  const id = pendingByTab.get(tabId) ?? null;
  pendingByTab.delete(tabId);
  return id && store.get().pages.some((p) => p.id === id) ? id : null;
}

// The page each tab last had in front: pages are shared, the one shown is the tab's own.
const activeByTab = new Map<string, string>();

/** The user moved from tab `from` to tab `to`: `from` keeps its page in front, `to` gets back the one it had
 * (if still open; a tab without one keeps whatever is in front). */
export function switchBrowserTab(from: string | null, to: string) {
  const { activeId, pages } = store.get();
  if (from && activeId) activeByTab.set(from, activeId);
  const saved = activeByTab.get(to);
  if (saved && saved !== activeId && pages.some((p) => p.id === saved)) store.update((s) => ({ ...s, activeId: saved }));
}

/** A tab closed: nothing waits for it any more. */
export function forgetBrowserTab(tabId: string) {
  focusWaiters.delete(tabId);
  pendingByTab.delete(tabId);
  activeByTab.delete(tabId);
}

/** Brings page `id` in front and opens the Browser - unless `fromTabId` is a
 * tab other than the one on screen, in which case it waits for that tab. */
function showPage(id: string, fromTabId?: string) {
  if (fromTabId && focusTabId && fromTabId !== focusTabId) {
    pendingByTab.set(fromTabId, id);
    // Tell the user where it is, and let them bring it here instead of going to that tab.
    const page = store.get().pages.find((p) => p.id === id);
    const key = `browser:${fromTabId}`;
    if (page) {
      addCall({
        key,
        tabId: fromTabId,
        kind: "browser",
        title: t("calls.title.browser"),
        detail: pageLabel(page),
        onOpenHere: () => {
          if (pendingByTab.get(fromTabId) === id) pendingByTab.delete(fromTabId);
          removeCallByKey(key);
          activatePage(id);
          setBrowserOpen(true);
        },
      });
    }
    return;
  }
  store.update((s) => ({ ...s, activeId: id }));
  setBrowserOpen(true);
}

/** The page for this target, reusing an existing one (same url / path / pdf src) or adding it. */
function addOrFindPage(target: { kind: "url"; url: string } | { kind: "file"; path: string } | { kind: "pdf"; src: string }): string {
  const existing = store.get().pages.find((p) => {
    if (p.kind !== target.kind) return false;
    return p.kind === "url" ? p.url === (target as { url: string }).url || p.requestedUrl === (target as { url: string }).url : p.kind === "file" ? p.path === (target as { path: string }).path : p.src === (target as { src: string }).src;
  });
  if (existing) return existing.id;
  const id = newId();
  const page: PreviewPage =
    target.kind === "url" ? { id, kind: "url", url: target.url, requestedUrl: target.url, back: [], forward: [] } : target.kind === "file" ? { id, kind: "file", path: target.path } : { id, kind: "pdf", src: target.src };
  store.update((s) => ({ ...s, pages: [...s.pages, page] }));
  return id;
}

/** The page a target opens as: a PDF target becomes a viewer page whatever the kind asked. */
function addOrFindTarget(kind: "url" | "file", value: string): string {
  if (isPdfTarget(value)) return addOrFindPage({ kind: "pdf", src: value });
  return addOrFindPage(kind === "url" ? { kind: "url", url: value } : { kind: "file", path: value });
}

/** A page the phone asked for: added (or found) without opening the Browser or taking the desktop's active page.
 * Exception: with no page before, the new one becomes active so the panel isn't empty when opened later. */
function openFromRemote(kind: "url" | "file", value: string, nonce: string) {
  const hadPages = store.get().pages.length > 0;
  const pageId = addOrFindTarget(kind, value);
  store.update((s) => ({ ...s, activeId: hadPages ? s.activeId : pageId, remoteOpened: { nonce, pageId } }));
}

export function openUrlFromRemote(url: string, nonce: string) {
  openFromRemote("url", url, nonce);
}

export function openFileFromRemote(path: string, nonce: string) {
  openFromRemote("file", path, nonce);
}

/** The tabs as the phone mirrors them. */
export function browserTabsSnapshot(state: BrowserState): BrowserTabsSnapshot {
  return {
    pages: state.pages.filter((p) => !p.mirror).map((p): BrowserTabPage =>
      p.kind === "url" ? { id: p.id, kind: "url", url: p.url, canBack: p.back.length > 0, canForward: p.forward.length > 0 } : p.kind === "file" ? { id: p.id, kind: "file", path: p.path } : { id: p.id, kind: "pdf", src: p.src },
    ),
    activeId: state.pages.find((p) => p.id === state.activeId)?.mirror ? null : state.activeId,
    servers: state.servers.map((s) => ({ url: s.url, port: s.port, alive: s.alive })),
    opened: state.remoteOpened,
  };
}

function openPdfInPreview(src: string, fromTabId?: string): string {
  const id = addOrFindPage({ kind: "pdf", src });
  showPage(id, fromTabId);
  return id;
}

/** A url page that turned out to serve a PDF becomes a viewer page, in place. */
export function convertPageToPdf(id: string, url: string) {
  native(() => nativeView.close(id));
  store.update((s) => ({
    ...s,
    pages: s.pages.map((p) => (p.id === id && p.kind === "url" ? { id, kind: "pdf" as const, src: url } : p)),
  }));
}

/** `fromTabId`: the tab this is opened for, when not the user's own action on screen. Returns the page's id. */
export function openUrlInPreview(url: string, fromTabId?: string): string {
  if (isPdfTarget(url)) return openPdfInPreview(url, fromTabId);
  const id = addOrFindPage({ kind: "url", url });
  // Opening again a page that failed tries it again: otherwise the old error page came back and nothing
  // ever reached the server (a link clicked, an agent's open_in_browser, all landed on the same failure).
  retryFailedPage(id);
  if (fromTabId) updateUrlPage(id, (p) => (p.fromTabId ? p : { ...p, fromTabId }));
  showPage(id, fromTabId);
  return id;
}

/** An id for a page about to be added, to listen for its native view before it exists. */
export const reservePageId = newId;

/** A new url page an agent opens and drives: never an existing one (that may be the user's own). */
export function openAgentPage(url: string, control: PageControl, fromTabId?: string, id: string = newId()): string {
  const page: PreviewPage = { id, kind: "url", url, requestedUrl: url, back: [], forward: [], fromTabId, control };
  store.update((s) => ({ ...s, pages: [...s.pages, page] }));
  showPage(id, fromTabId);
  return id;
}

/** Brings a page in front (and opens the Browser), or waits for `fromTabId`'s tab like any page opened for it. */
export function revealPage(id: string, fromTabId?: string) {
  if (store.get().pages.some((p) => p.id === id)) showPage(id, fromTabId);
}

/** Hands a page to an agent (`control`), or takes it back (null). */
export function setPageControl(id: string, control: PageControl | null) {
  updateUrlPage(id, (p) => {
    if (control) return { ...p, control };
    if (!p.control) return p;
    const { control: _gone, ...rest } = p;
    return rest;
  });
}

/** Changes part of a controlled page's control (no effect when it has none). */
export function patchPageControl(id: string, patch: Partial<PageControl>) {
  updateUrlPage(id, (p) => (p.control ? { ...p, control: { ...p.control, ...patch } } : p));
}

/** The url pages `owner` drives. */
export function controlledPagesOf(pages: PreviewPage[], owner: ControlOwner): Extract<PreviewPage, { kind: "url" }>[] {
  return pages.filter((p): p is Extract<PreviewPage, { kind: "url" }> => p.kind === "url" && !!p.control && p.control.owner.kind === owner.kind && p.control.owner.id === owner.id);
}

/** The owner's chat or tab ended: its pages are the user's again. Returns their ids. */
export function releasePagesOf(owner: ControlOwner): string[] {
  const ids = controlledPagesOf(store.get().pages, owner).map((p) => p.id);
  ids.forEach((id) => setPageControl(id, null));
  return ids;
}

/** Most pages the browser holds; popups past it are ignored. */
const MAX_PAGES = 30;
/** A page may open this many popups per window of time. */
const POPUP_BURST = 3;
const POPUP_WINDOW_MS = 2000;
const popupTimes = new Map<string, number[]>();

/** A new page a web page asked for (`window.open`). False when ignored: more than 3 popups from the
 * same page within 2 s, or the browser already holds 30 pages. */
export function openPopupFromPage(sourcePageId: string, url: string, now = Date.now()): boolean {
  const recent = (popupTimes.get(sourcePageId) ?? []).filter((at) => now - at < POPUP_WINDOW_MS);
  if (recent.length >= POPUP_BURST) {
    popupTimes.set(sourcePageId, recent);
    return false;
  }
  if (store.get().pages.length >= MAX_PAGES) return false;
  popupTimes.set(sourcePageId, [...recent, now]);
  openUrlInPreview(url);
  return true;
}

export function openFileInPreview(path: string, fromTabId?: string) {
  if (isPdfTarget(path)) return openPdfInPreview(path, fromTabId);
  showPage(addOrFindPage({ kind: "file", path }), fromTabId);
}

export function activatePage(id: string) {
  if (store.get().pages.some((p) => p.id === id)) store.update((s) => ({ ...s, activeId: id }));
}

// ---- tabs mirrored from another PC ----
/** What the user does to a mirrored page that the other PC must hear (set by remoteHosts, which owns the links). */
interface MirrorHooks {
  close: (tag: MirrorTag) => void;
  navigate: (tag: MirrorTag, url: string) => void;
}
let mirrorHooks: MirrorHooks | null = null;
export function setMirrorHooks(hooks: MirrorHooks | null) {
  mirrorHooks = hooks;
}

export type MirrorTarget = { kind: "url"; url: string } | { kind: "file"; path: string } | { kind: "pdf"; src: string };

/** Adds the mirror of a remote tab, or updates it when the other PC changed what it shows (a url page navigates, another kind is replaced). Our own changes (key unchanged) are left alone. Returns the page id. */
export function upsertMirroredPage(tag: MirrorTag, target: MirrorTarget, activate = false): string {
  const same = (p: PreviewPage) => p.mirror?.hostId === tag.hostId && p.mirror.remoteId === tag.remoteId;
  const existing = store.get().pages.find(same);
  if (existing?.mirror?.key === tag.key) return existing.id;
  if (existing?.kind === "url" && target.kind === "url") {
    updateUrlPage(existing.id, (p) => ({ ...p, requestedUrl: target.url, mirror: tag }));
    return existing.id;
  }
  const id = existing?.id ?? newId();
  if (existing?.kind === "url") native(() => nativeView.close(id));
  const page: PreviewPage =
    target.kind === "url"
      ? { id, kind: "url", url: target.url, requestedUrl: target.url, back: [], forward: [], mirror: tag }
      : target.kind === "file"
        ? { id, kind: "file", path: target.path, mirror: tag }
        : { id, kind: "pdf", src: target.src, mirror: tag };
  store.update((s) => ({
    ...s,
    pages: existing ? s.pages.map((p) => (p.id === id ? page : p)) : [...s.pages, page],
    activeId: activate || !s.activeId ? id : s.activeId,
  }));
  return id;
}

/** Removes the mirrored pages of `hostId` whose remote tab is not in `keep` (all of them without it): the other PC closed them, or left the front. Never tells the other PC. */
export function dropMirroredPages(hostId: string, keep?: ReadonlySet<string>) {
  const gone = store.get().pages.filter((p) => p.mirror?.hostId === hostId && !keep?.has(p.mirror.remoteId));
  if (gone.length === 0) return;
  const ids = new Set(gone.map((p) => p.id));
  for (const p of gone) {
    native(() => nativeView.close(p.id));
    forgetErrorTiming(p.id);
  }
  store.update((s) => {
    const pages = s.pages.filter((p) => !ids.has(p.id));
    let activeId = s.activeId;
    if (activeId && ids.has(activeId)) {
      const at = s.pages.findIndex((p) => p.id === activeId);
      activeId = s.pages.slice(at + 1).find((p) => !ids.has(p.id))?.id ?? pages[pages.length - 1]?.id ?? null;
    }
    return { ...s, pages, activeId };
  });
}

export function closePage(id: string) {
  const mirror = store.get().pages.find((p) => p.id === id)?.mirror;
  if (mirror) mirrorHooks?.close(mirror);
  native(() => nativeView.close(id));
  forgetErrorTiming(id);
  popupTimes.delete(id);
  store.update((s) => {
    const index = s.pages.findIndex((p) => p.id === id);
    if (index < 0) return s;
    const pages = s.pages.filter((p) => p.id !== id);
    // The page in front hands over to the neighbour that slides into its place, else the last.
    const activeId = s.activeId === id ? (pages[Math.min(index, pages.length - 1)]?.id ?? null) : s.activeId;
    return { ...s, pages, activeId };
  });
}

export interface ClosedPages {
  pages: { page: PreviewPage; index: number }[];
  activeId: string | null;
}

/** Closes several pages at once. Returns what was closed (for restorePages), or null when nothing was. */
export function closePages(ids: string[]): ClosedPages | null {
  const wanted = new Set(ids);
  const before = store.get();
  const removed = before.pages.map((page, index) => ({ page, index })).filter((e) => wanted.has(e.page.id));
  if (removed.length === 0) return null;
  for (const { page } of removed) {
    if (page.mirror) mirrorHooks?.close(page.mirror);
    native(() => nativeView.close(page.id));
    forgetErrorTiming(page.id);
    popupTimes.delete(page.id);
  }
  store.update((s) => {
    const pages = s.pages.filter((p) => !wanted.has(p.id));
    let activeId = s.activeId;
    if (activeId && wanted.has(activeId)) {
      const oldIndex = s.pages.findIndex((p) => p.id === activeId);
      const next = s.pages.slice(oldIndex + 1).find((p) => !wanted.has(p.id));
      activeId = next?.id ?? pages[pages.length - 1]?.id ?? null;
    }
    return { ...s, pages, activeId };
  });
  return { pages: removed, activeId: before.activeId };
}

function isAlreadyOpen(pages: PreviewPage[], page: PreviewPage): boolean {
  return pages.some((p) => {
    if (p.id === page.id) return true;
    if (p.kind !== page.kind) return false;
    if (p.kind === "url" && page.kind === "url") return p.url === page.url || p.requestedUrl === page.url || p.url === page.requestedUrl;
    if (p.kind === "file" && page.kind === "file") return p.path === page.path;
    if (p.kind === "pdf" && page.kind === "pdf") return p.src === page.src;
    return false;
  });
}

/** Undo of closePages: reopens the addresses (history, agent control and errors are lost). */
export function restorePages(closed: ClosedPages) {
  store.update((s) => {
    const pages = [...s.pages];
    const restored: string[] = [];
    const sorted = [...closed.pages].sort((a, b) => a.index - b.index);
    for (const { page, index } of sorted) {
      // The other PC closed a mirrored page with it: nothing to bring back here.
      if (page.mirror || isAlreadyOpen(pages, page)) continue;
      const fresh: PreviewPage =
        page.kind === "url"
          ? {
              id: page.id,
              kind: "url",
              url: page.url,
              requestedUrl: page.url,
              back: [],
              forward: [],
              title: page.title,
              favicon: page.favicon,
              fromTabId: page.fromTabId,
            }
          : page;
      pages.splice(Math.min(index, pages.length), 0, fresh);
      restored.push(fresh.id);
    }
    if (restored.length === 0) return s;
    let activeId = s.activeId;
    if (closed.activeId && pages.some((p) => p.id === closed.activeId)) activeId = closed.activeId;
    else if (!activeId || !pages.some((p) => p.id === activeId)) activeId = restored[0];
    return { ...s, pages, activeId };
  });
}

function updateUrlPage(id: string, fn: (page: Extract<PreviewPage, { kind: "url" }>) => PreviewPage) {
  store.update((s) => ({
    ...s,
    pages: s.pages.map((p) => (p.id === id && p.kind === "url" ? fn(p) : p)),
  }));
}

/** Asks the page to go to `url`. The address bar follows once the view reports it (syncPageUrl). */
export function navigatePage(id: string, url: string) {
  const mirror = store.get().pages.find((p) => p.id === id)?.mirror;
  // A mirrored page goes where the other PC sends it; its answer moves this view.
  if (mirror && mirrorHooks) return mirrorHooks.navigate(mirror, url);
  updateUrlPage(id, (p) => (p.url === url || p.requestedUrl === url ? p : { ...p, requestedUrl: url }));
}

/** The native view reports where the page is. Updates the displayed address only (never navigates)
 * and keeps the history stacks: an address equal to the previous / next entry is back / forward. */
export function syncPageUrl(id: string, url: string) {
  updateUrlPage(id, (p) => {
    if (p.url === url) return p;
    const base = { ...p, url, requestedUrl: url, title: undefined };
    if (p.back[p.back.length - 1] === url) return { ...base, back: p.back.slice(0, -1), forward: [p.url, ...p.forward] };
    if (p.forward[0] === url) return { ...base, back: [...p.back, p.url], forward: p.forward.slice(1) };
    return { ...base, back: [...p.back, p.url], forward: [] };
  });
}

// ---- load errors ----
// `browser-view-load finished` can arrive before `browser-view-error` for the same navigation (one engine event
// feeds both), so a finished load only clears the error when none came in the CLEAR_ERROR_MS after it.
const CLEAR_ERROR_MS = 300;
let timingSeq = 0;
const errorSeq = new Map<string, number>();
const finishToken = new Map<string, number>();

function forgetErrorTiming(id: string) {
  errorSeq.delete(id);
  finishToken.delete(id);
}

/** The view reported a failure: our page shows, the retry spinner stops. */
export function setPageError(id: string, error: { kind: NativeErrorKind; code: string; url: string }) {
  errorSeq.set(id, ++timingSeq);
  updateUrlPage(id, (p) => ({ ...p, error: { ...error, at: Date.now() }, retrying: false }));
}

/** "Back" on the blocked page: the address was never loaded, so the page returns to where it really is
 * (or closes when it was opened on the blocked address). */
export function dismissBlockedPage(id: string) {
  const page = store.get().pages.find((p) => p.id === id);
  if (page?.kind !== "url") return;
  if (page.error && page.url === page.error.url) {
    closePage(id);
    return;
  }
  updateUrlPage(id, (p) => ({ ...p, requestedUrl: p.url, error: undefined, retrying: undefined }));
}

export function clearPageError(id: string) {
  updateUrlPage(id, (p) => (p.error || p.retrying ? { ...p, error: undefined, retrying: undefined } : p));
}

/** A url page showing a load error loads again: its view reloads, or (no view, e.g. it failed before one
 * existed) the error goes so the panel creates the view and navigates. */
export function retryFailedPage(id: string) {
  const page = store.get().pages.find((p) => p.id === id);
  if (page?.kind !== "url" || !page.error) return;
  updateUrlPage(id, (p) => ({ ...p, retrying: true }));
  nativeView.reload(id).catch(() => clearPageError(id));
}

/** A load started: an error page stays (it is not hidden until the load works) and shows it is trying again. */
export function pageLoadStarted(id: string) {
  updateUrlPage(id, (p) => (p.error && !p.retrying ? { ...p, retrying: true } : p));
}

/** A load finished: the error page goes unless an error is reported right after. */
export function pageLoadFinished(id: string) {
  const token = ++timingSeq;
  finishToken.set(id, token);
  setTimeout(() => {
    if (finishToken.get(id) !== token) return;
    if ((errorSeq.get(id) ?? 0) > token) return;
    clearPageError(id);
  }, CLEAR_ERROR_MS);
}

export function setPageTitle(id: string, title: string) {
  const value = title.trim() || undefined;
  updateUrlPage(id, (p) => (p.title === value ? p : { ...p, title: value }));
}

export function setPageFavicon(id: string, favicon: string | null) {
  updateUrlPage(id, (p) => ((p.favicon ?? null) === favicon ? p : { ...p, favicon: favicon ?? undefined }));
}

// requestedUrl follows the move too: the view is already there, so it must not navigate.
export function goBack(id: string) {
  const page = store.get().pages.find((p) => p.id === id);
  if (page?.kind !== "url" || page.back.length === 0) return;
  updateUrlPage(id, (p) => {
    const prev = p.back[p.back.length - 1];
    return prev === undefined ? p : { ...p, url: prev, requestedUrl: prev, back: p.back.slice(0, -1), forward: [p.url, ...p.forward] };
  });
  native(() => nativeView.back(id));
}

export function goForward(id: string) {
  const page = store.get().pages.find((p) => p.id === id);
  if (page?.kind !== "url" || page.forward.length === 0) return;
  updateUrlPage(id, (p) => {
    const next = p.forward[0];
    return next === undefined ? p : { ...p, url: next, requestedUrl: next, back: [...p.back, p.url], forward: p.forward.slice(1) };
  });
  native(() => nativeView.forward(id));
}

/** True when the server is new: one dev server printed by several tabs, or
 * twice by the same one, is a single entry. */
export function addDetectedServer(url: string, port: number, tabId: string): boolean {
  if (store.get().servers.some((s) => s.port === port)) return false;
  store.update((s) => ({ ...s, servers: [...s.servers, { url, port, tabId, alive: true }] }));
  return true;
}

export function removeServersOfTab(tabId: string) {
  if (!store.get().servers.some((s) => s.tabId === tabId)) return;
  store.update((s) => ({ ...s, servers: s.servers.filter((x) => x.tabId !== tabId) }));
}

export function setServerAlive(port: number, alive: boolean) {
  const server = store.get().servers.find((s) => s.port === port);
  if (!server || server.alive === alive) return;
  store.update((s) => ({ ...s, servers: s.servers.map((x) => (x.port === port ? { ...x, alive } : x)) }));
}

// ---- pure helpers ----

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** localhost, loopback and the unspecified address a server prints when it listens on all interfaces. */
export function isLocalUrl(url: string): boolean {
  const host = hostOf(url);
  if (host === null) return false;
  return (
    host === "localhost" ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "[::]" ||
    host.endsWith(".localhost")
  );
}

/** 0.0.0.0 and [::] mean "every interface" for a server but can't be browsed to: localhost can. */
export function normalizeLocalUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "0.0.0.0" || u.hostname === "[::]") {
      u.hostname = "localhost";
      return u.toString();
    }
  } catch {
    /* not a URL: leave it */
  }
  return url;
}

/** What the user typed in the address bar as a loadable URL, or null when it
 * isn't one. A bare host gets https, except local addresses (http). */
export function normalizeTypedUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  let candidate = trimmed;
  // "localhost:3000" parses as scheme "localhost:", so only "://" counts as a scheme.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const portOnly = /^:\d+([/?#]|$)/.test(trimmed);
    const local = portOnly || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[^/:?#]*\.localhost)(:\d+)?([/?#]|$)/i.test(trimmed);
    candidate = (local ? "http://" : "https://") + (portOnly ? "localhost" : "") + trimmed;
  }
  try {
    const u = new URL(candidate);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// CSI sequences (colours, cursor moves) and OSC ones (titles, hyperlinks).
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// The port is required: a bare "http://localhost" in a log isn't a server announcing itself.
const LOCAL_SERVER_RE = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\/?[^\s]*/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/** The local server addresses in a piece of terminal output (colour codes included). */
export function extractLocalServers(text: string): { url: string; port: number }[] {
  const found: { url: string; port: number }[] = [];
  for (const match of stripAnsi(text).matchAll(LOCAL_SERVER_RE)) {
    const port = Number(match[1]);
    if (port > 65535) continue;
    // Sentence punctuation and closing brackets stick to the address in logs.
    const url = normalizeLocalUrl(match[0].replace(/[.,;:!?)\]}'"]+$/, ""));
    found.push({ url, port });
  }
  return found;
}
