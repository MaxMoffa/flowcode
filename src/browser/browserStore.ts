import { createStore } from "../lib/externalStore";
import { readBool, writeBool } from "../lib/storage";
import { isPdfTarget } from "../../shared/agentOpen";
import { addCall, removeCallByKey } from "../calls/callStore";
import { t } from "../i18n";
import type { BrowserTabPage, BrowserTabsSnapshot } from "../../shared/remote-types";
export { isPdfTarget, isPreviewableFile } from "../../shared/agentOpen";

const BROWSER_OPEN_KEY = "flowcode.browserOpen";

export type PreviewPage =
  | { id: string; kind: "url"; url: string; back: string[]; forward: string[] }
  | { id: string; kind: "file"; path: string }
  /** `src` is an http(s) URL or an absolute local path. */
  | { id: string; kind: "pdf"; src: string };

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
  return page.kind === "url" ? page.url : page.kind === "file" ? (page.path.split(/[\/]/).pop() ?? page.path) : (page.src.split(/[\/]/).pop() ?? page.src);
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
    return p.kind === "url" ? p.url === (target as { url: string }).url : p.kind === "file" ? p.path === (target as { path: string }).path : p.src === (target as { src: string }).src;
  });
  if (existing) return existing.id;
  const id = newId();
  const page: PreviewPage =
    target.kind === "url" ? { id, kind: "url", url: target.url, back: [], forward: [] } : target.kind === "file" ? { id, kind: "file", path: target.path } : { id, kind: "pdf", src: target.src };
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
    pages: state.pages.map((p): BrowserTabPage =>
      p.kind === "url" ? { id: p.id, kind: "url", url: p.url, canBack: p.back.length > 0, canForward: p.forward.length > 0 } : p.kind === "file" ? { id: p.id, kind: "file", path: p.path } : { id: p.id, kind: "pdf", src: p.src },
    ),
    activeId: state.activeId,
    servers: state.servers.map((s) => ({ url: s.url, port: s.port, alive: s.alive })),
    opened: state.remoteOpened,
  };
}

function openPdfInPreview(src: string, fromTabId?: string) {
  showPage(addOrFindPage({ kind: "pdf", src }), fromTabId);
}

/** A url page that turned out to serve a PDF becomes a viewer page, in place. */
export function convertPageToPdf(id: string, url: string) {
  store.update((s) => ({
    ...s,
    pages: s.pages.map((p) => (p.id === id && p.kind === "url" ? { id, kind: "pdf" as const, src: url } : p)),
  }));
}

/** `fromTabId`: the tab this is opened for, when not the user's own action on screen. */
export function openUrlInPreview(url: string, fromTabId?: string) {
  if (isPdfTarget(url)) return openPdfInPreview(url, fromTabId);
  showPage(addOrFindPage({ kind: "url", url }), fromTabId);
}

export function openFileInPreview(path: string, fromTabId?: string) {
  if (isPdfTarget(path)) return openPdfInPreview(path, fromTabId);
  showPage(addOrFindPage({ kind: "file", path }), fromTabId);
}

export function activatePage(id: string) {
  if (store.get().pages.some((p) => p.id === id)) store.update((s) => ({ ...s, activeId: id }));
}

export function closePage(id: string) {
  store.update((s) => {
    const index = s.pages.findIndex((p) => p.id === id);
    if (index < 0) return s;
    const pages = s.pages.filter((p) => p.id !== id);
    // The page in front hands over to the neighbour that slides into its place, else the last.
    const activeId = s.activeId === id ? (pages[Math.min(index, pages.length - 1)]?.id ?? null) : s.activeId;
    return { ...s, pages, activeId };
  });
}

function updateUrlPage(id: string, fn: (page: Extract<PreviewPage, { kind: "url" }>) => PreviewPage) {
  store.update((s) => ({
    ...s,
    pages: s.pages.map((p) => (p.id === id && p.kind === "url" ? fn(p) : p)),
  }));
}

export function navigatePage(id: string, url: string) {
  updateUrlPage(id, (p) => (p.url === url ? p : { ...p, url, back: [...p.back, p.url], forward: [] }));
}

export function goBack(id: string) {
  updateUrlPage(id, (p) => {
    const prev = p.back[p.back.length - 1];
    return prev === undefined ? p : { ...p, url: prev, back: p.back.slice(0, -1), forward: [p.url, ...p.forward] };
  });
}

export function goForward(id: string) {
  updateUrlPage(id, (p) => {
    const next = p.forward[0];
    return next === undefined ? p : { ...p, url: next, back: [...p.back, p.url], forward: p.forward.slice(1) };
  });
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
    host === "127.0.0.1" ||
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
