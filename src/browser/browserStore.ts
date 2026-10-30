import { createStore } from "../lib/externalStore";
import { readBool, writeBool } from "../lib/storage";

const BROWSER_OPEN_KEY = "flowcode.browserOpen";

export type PreviewPage =
  | { id: string; kind: "url"; url: string; back: string[]; forward: string[] }
  | { id: string; kind: "file"; path: string };

/** A dev server a terminal printed an address for. */
export interface DetectedServer {
  url: string;
  port: number;
  tabId: string;
  alive: boolean;
}

interface BrowserState {
  open: boolean;
  pages: PreviewPage[];
  activeId: string | null;
  servers: DetectedServer[];
}

// Only `open` outlives the session: the pages point at servers and files that
// may be gone by the next launch.
const store = createStore<BrowserState>({ open: readBool(BROWSER_OPEN_KEY, false), pages: [], activeId: null, servers: [] });

export const useBrowser = store.use;
export const getBrowser = store.get;

let nextId = 0;
const newId = () => `page-${++nextId}`;

export function setBrowserOpen(open: boolean | ((prev: boolean) => boolean)) {
  const next = typeof open === "function" ? open(store.get().open) : open;
  writeBool(BROWSER_OPEN_KEY, next);
  store.update((s) => ({ ...s, open: next }));
}

export function toggleBrowser() {
  setBrowserOpen((o) => !o);
}

export function openUrlInPreview(url: string) {
  const existing = store.get().pages.find((p) => p.kind === "url" && p.url === url);
  const id = existing?.id ?? newId();
  store.update((s) => ({
    ...s,
    pages: existing ? s.pages : [...s.pages, { id, kind: "url", url, back: [], forward: [] }],
    activeId: id,
  }));
  setBrowserOpen(true);
}

export function openFileInPreview(path: string) {
  const existing = store.get().pages.find((p) => p.kind === "file" && p.path === path);
  const id = existing?.id ?? newId();
  store.update((s) => ({
    ...s,
    pages: existing ? s.pages : [...s.pages, { id, kind: "file", path }],
    activeId: id,
  }));
  setBrowserOpen(true);
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

const PREVIEWABLE = new Set(["html", "htm", "svg", "pdf", "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm"]);

export function isPreviewableFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || /[\\/]/.test(path.slice(dot))) return false;
  return PREVIEWABLE.has(path.slice(dot + 1).toLowerCase());
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
