// Agent browser control, frontend side: the backend (src-tauri/src/browser_control.rs) executes tools on the
// native child webviews and asks this window, through `browser-control-request`, what each call may do. The
// policy itself is in controlPolicy.ts; here are the parts that touch the app: which chats / tabs this window
// owns, what the user granted them, the consent cards, pages, and the bridge.
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useEffect } from "react";
import { createStore } from "../lib/externalStore";
import { getBrowserSettings } from "./browserSettings";
import { onNativeLoad, onNativeNavigated } from "./nativeView";
import {
  controlledPagesOf,
  getBrowser,
  isLocalUrl,
  isPdfTarget,
  navigatePage,
  normalizeLocalUrl,
  normalizeTypedUrl,
  openAgentPage,
  patchPageControl,
  releasePagesOf,
  reservePageId,
  revealPage,
  setPageControl,
  type ControlOwner,
  type PageControl,
  type PreviewPage,
} from "./browserStore";
import { applyConsent, decideControl, hostOfUrl, noGrants, ownerKey, parseOwner, sameOwner, type ConsentChoice, type ControlAction, type ControlCard, type ControlGrants } from "./controlPolicy";

export type { ControlOwner } from "./browserStore";

/** Most pages the browser holds (the same bound browserStore uses for popups). */
const MAX_PAGES = 30;
/** The backend gives up on a consent after 120 s; the card goes a little before. */
const CONSENT_TIMEOUT_MS = 115_000;
/** How long a new tab may take to show up in the panel. */
const VIEW_WAIT_MS = 8_000;

// ---- the owners this window knows ----

export interface ControlOwnerInfo {
  owner: ControlOwner;
  /** What shows the consent card: a chat's id (a delegated child shows it in its orchestrator's chat) or a terminal's pty id. */
  hostId: string;
  /** The app tab the owner lives in: pages it opens wait for it. */
  tabId?: string;
  /** The agent's cli name. */
  agent?: string;
  /** A short name for the handover menu. */
  label: string;
}

const owners = new Map<string, ControlOwnerInfo>();
const grantsByOwner = new Map<string, ControlGrants>();
const ownersStore = createStore<ControlOwnerInfo[]>([]);
export const useControlOwners = ownersStore.use;

function publishOwners() {
  ownersStore.set([...owners.values()]);
}

/** This window shows `owner`'s chat / terminal. Returns what to call when it ends: grants, pages and pending cards go with it. */
export function registerControlOwner(info: ControlOwnerInfo): () => void {
  const key = ownerKey(info.owner);
  owners.set(key, info);
  publishOwners();
  return () => {
    if (owners.get(key) !== info) return;
    owners.delete(key);
    grantsByOwner.delete(key);
    dropConsentsOf(info.owner);
    for (const pageId of releasePagesOf(info.owner)) void invoke("browser_control_release", { pageId }).catch(() => {});
    publishOwners();
  };
}

/** The agent behind a terminal owner shows up with its first request. */
function noteAgent(info: ControlOwnerInfo, agent: string | undefined) {
  if (!agent || info.agent === agent) return;
  const next = { ...info, agent };
  owners.set(ownerKey(info.owner), next);
  publishOwners();
}

export const knownControlOwner = (owner: ControlOwner) => owners.get(ownerKey(owner)) ?? null;
export const grantsOf = (owner: ControlOwner) => grantsByOwner.get(ownerKey(owner)) ?? noGrants();
const setGrants = (owner: ControlOwner, grants: ControlGrants) => void grantsByOwner.set(ownerKey(owner), grants);

// ---- consent cards ----

export interface ControlConsent {
  id: string;
  owner: ControlOwner;
  hostId: string;
  agent?: string;
  card: ControlCard;
  /** localhost:5173/login, or the page's host for an eval / interact card. */
  target: string;
  /** The code of an eval card. */
  code?: string;
  /** Settles when the user answered (or the owner went away): `null` for the latter. */
  answer: (choice: ConsentChoice | null) => void;
  done: Promise<ConsentChoice | null>;
}

const consentStore = createStore<ControlConsent[]>([]);
export const useControlConsents = (hostId: string | null): ControlConsent[] => {
  const all = consentStore.use();
  return hostId ? all.filter((c) => c.hostId === hostId) : [];
};

let consentSeq = 0;

function askConsent(info: ControlOwnerInfo, card: ControlCard, target: string, code?: string): Promise<ConsentChoice | null> {
  // The same question already on screen (two calls racing): wait for that answer.
  const open = consentStore.get().find((c) => ownerKey(c.owner) === ownerKey(info.owner) && c.card === card && c.target === target);
  if (open) return open.done;
  let settle!: (choice: ConsentChoice | null) => void;
  const done = new Promise<ConsentChoice | null>((resolve) => (settle = resolve));
  const consent: ControlConsent = { id: `consent-${++consentSeq}`, owner: info.owner, hostId: info.hostId, agent: info.agent, card, target, code, answer: (c) => settle(c), done };
  consentStore.update((l) => [...l, consent]);
  const timer = setTimeout(() => settle(null), CONSENT_TIMEOUT_MS);
  void done.then(() => {
    clearTimeout(timer);
    consentStore.update((l) => l.filter((c) => c.id !== consent.id));
  });
  return done;
}

function dropConsentsOf(owner: ControlOwner) {
  consentStore.get().filter((c) => sameOwner(c.owner, owner)).forEach((c) => c.answer(null));
}

// ---- resolving a request ----

interface ResolveRequest {
  reqId: string;
  tool?: string;
  owner: ControlOwner;
  agent?: string;
  page?: string;
  url?: string;
  action: ControlAction;
  newTab?: boolean;
  /** The code of a `browser_eval`, for its card (the backend may omit it). */
  code?: string;
}

export type ResolveReply = { ok: true; value: unknown } | { ok: false; value: string };

const NO_TAB = "no browser tab: call browser_navigate with a url first";

const windowLabel = () => getCurrentWebviewWindow().label;

/** Resolves true once the native view of `pageId` reports it navigates (so the backend can find it), false after `ms`. Listen before opening the page: the first events can come at once. */
function viewAppears(pageId: string, ms: number): { promise: Promise<boolean>; cancel: () => void } {
  let finish!: (v: boolean) => void;
  const promise = new Promise<boolean>((resolve) => (finish = resolve));
  const offs: (() => void)[] = [];
  const done = (v: boolean) => {
    clearTimeout(timer);
    offs.forEach((off) => off());
    finish(v);
  };
  const timer = setTimeout(() => done(false), ms);
  offs.push(onNativeLoad((e) => e.pageId === pageId && done(true)), onNativeNavigated((e) => e.pageId === pageId && done(true)));
  return { promise, cancel: () => done(false) };
}

const pageUrl = (p: PreviewPage) => (p.kind === "url" ? p.url || p.requestedUrl : null);

/** Which of the owner's pages a call without `page` means: the one it used last, else the one in front, else the newest. */
export function pickControlledPage(pages: ReturnType<typeof controlledPagesOf>, activeId: string | null) {
  if (pages.length === 0) return null;
  const used = [...pages].filter((p) => p.control?.lastUsed).sort((a, b) => (b.control?.lastUsed ?? 0) - (a.control?.lastUsed ?? 0));
  return used[0] ?? pages.find((p) => p.id === activeId) ?? pages[pages.length - 1];
}

/** Answers one `resolve` request, or null when the owner is not in this window. */
export async function resolveControlRequest(req: ResolveRequest): Promise<ResolveReply | null> {
  const info = knownControlOwner(req.owner);
  if (!info) return null;
  noteAgent(info, req.agent);
  const agent = req.agent ?? info.agent;
  const settings = getBrowserSettings();
  const state = () => getBrowser();
  const mine = () => controlledPagesOf(state().pages, req.owner);

  const wanted = req.page ? state().pages.find((p) => p.id === req.page) : null;
  const target = wanted ?? (req.tool === "browser_tabs" ? null : pickControlledPage(mine(), state().activeId));
  const owned = !req.page || (!!wanted && wanted.kind === "url" && !!wanted.control && sameOwner(wanted.control.owner, req.owner));

  let newUrl: string | null = null;
  if (req.action === "open" && req.url) {
    const typed = normalizeTypedUrl(req.url);
    if (!typed) return { ok: false, value: `"${req.url}" is not an http(s) address` };
    newUrl = isLocalUrl(typed) ? normalizeLocalUrl(typed) : typed;
    if (isPdfTarget(newUrl)) return { ok: false, value: "that address is a PDF: Flowcode shows it in its own viewer, which can't be controlled" };
  }
  const needsPage = req.tool !== "browser_tabs" && !(req.action === "open" && newUrl);
  if (needsPage && !target) return { ok: false, value: NO_TAB };
  const targetUrl = req.action === "open" && newUrl ? newUrl : target ? pageUrl(target) : null;

  let approvedOnce = false;
  for (let round = 0; round < 4 && !approvedOnce; round++) {
    const grants = grantsOf(req.owner);
    const verdict = decideControl({
      settings,
      grants,
      action: req.action,
      url: targetUrl,
      owned,
      paused: target?.kind === "url" ? !!target.control?.paused : false,
    });
    if (verdict.decision === "deny") return { ok: false, value: verdict.reason };
    if (verdict.decision === "allow") break;
    const host = hostOfUrl(targetUrl);
    const choice = await askConsent({ ...info, agent }, verdict.card, verdict.card === "access" ? (targetUrl ? targetUrl.replace(/^https?:\/\//, "") : "") : host, req.code);
    if (choice === null) return { ok: false, value: "the user did not answer the permission request in time; ask again later or tell the user" };
    const applied = applyConsent(grants, verdict.card, choice, host);
    setGrants(req.owner, applied.grants);
    if (!applied.allowed) return { ok: false, value: verdict.card === "access" ? "the user denied browser access for this session" : "the user declined this action" };
    if (choice === "once") approvedOnce = true;
  }

  const now = Date.now();
  if (req.tool === "browser_tabs") {
    return { ok: true, value: { pages: mine().map((p) => ({ id: p.id, url: p.url, title: p.title ?? "", active: p.id === state().activeId })) } };
  }

  let pageId: string;
  let pageAddress: string;
  if (req.action === "open" && newUrl) {
    const control: PageControl = { owner: req.owner, agent, paused: false, lastUsed: now };
    if (target && !req.newTab && owned) {
      pageId = target.id;
      navigatePage(pageId, newUrl);
      patchPageControl(pageId, { lastUsed: now });
      revealPage(pageId, info.tabId);
    } else {
      if (state().pages.length >= MAX_PAGES) return { ok: false, value: "too many tabs are open: ask the user to close some" };
      // The backend finds the native view right after our answer: it exists once the panel shows the page and it starts loading.
      const nextId = reservePageId();
      const appears = viewAppears(nextId, VIEW_WAIT_MS);
      pageId = openAgentPage(newUrl, control, info.tabId, nextId);
      if (!(await appears.promise)) return { ok: false, value: `the tab was opened (id ${pageId}) but Flowcode could not show it: the user may be in another tab. Try browser_navigate again in a moment.` };
    }
    pageAddress = newUrl;
  } else if (target?.kind === "url") {
    pageId = target.id;
    pageAddress = target.url;
    patchPageControl(pageId, { lastUsed: now });
    if (req.action === "interact" || req.action === "open") revealPage(pageId, info.tabId);
  } else return { ok: false, value: NO_TAB };
  return { ok: true, value: { pageId, url: pageAddress, highlight: settings.highlightActions } };
}

/** The user hands one of their pages to an agent from the page's menu: no card, they chose. */
export function handOverPage(pageId: string, info: ControlOwnerInfo) {
  const grants = grantsOf(info.owner);
  if (grants.access === "none" || grants.access === "denied") setGrants(info.owner, { ...grants, access: "full" });
  setPageControl(pageId, { owner: info.owner, agent: info.agent, paused: false });
}

/** A page opened by an agent's own `open_in_browser`: the agent may control it (its first action still goes through the consent). */
export function claimOpenedPage(pageId: string, existedBefore: boolean, owner: ControlOwner | undefined, agent?: string) {
  if (!owner || existedBefore) return;
  const page = getBrowser().pages.find((p) => p.id === pageId);
  if (page?.kind !== "url" || page.control) return;
  setPageControl(pageId, { owner, agent: agent ?? knownControlOwner(owner)?.agent, paused: false });
}

/** The user took the page back (Interrompi / Togli all'agente). */
export function releasePage(pageId: string) {
  setPageControl(pageId, null);
  void invoke("browser_control_release", { pageId }).catch(() => {});
}

/** The user hands a paused page back to its agent. */
export function resumePage(pageId: string) {
  patchPageControl(pageId, { paused: false });
}

/** Tells the backend to watch a page for the user's own input while an agent drives it and it is on screen. */
export function watchControlledPage(pageId: string, on: boolean) {
  void invoke("browser_control_watch", { window: windowLabel(), pageId, on }).catch(() => {});
}

// ---- the bridge ----

interface ActivityEvent {
  pageId: string;
  summary?: string;
  tool?: string;
  at?: number;
}

function listen<T>(event: string, cb: (p: T) => void): () => void {
  const un = getCurrentWebviewWindow().listen<T>(event, (e) => cb(e.payload));
  return () => void un.then((f) => f());
}

/** Always on (App): answers the backend's requests for this window's chats and terminals and keeps the pages' control state current. */
export function useBrowserControlBridge() {
  useEffect(() => {
    const offs = [
      listen<Record<string, unknown>>("browser-control-request", (raw) => {
        const reqId = typeof raw.reqId === "string" ? raw.reqId : null;
        const owner = parseOwner(raw.owner);
        if (!reqId || !owner || raw.kind !== "resolve" || !knownControlOwner(owner)) return;
        const action = raw.action === "interact" || raw.action === "eval" || raw.action === "open" ? raw.action : "read";
        const req: ResolveRequest = {
          reqId,
          owner,
          action,
          tool: typeof raw.tool === "string" ? raw.tool : undefined,
          agent: typeof raw.agent === "string" ? raw.agent : undefined,
          page: typeof raw.page === "string" && raw.page ? raw.page : undefined,
          url: typeof raw.url === "string" && raw.url ? raw.url : undefined,
          newTab: raw.newTab === true,
          code: typeof raw.code === "string" ? raw.code : typeof raw.js === "string" ? raw.js : undefined,
        };
        void resolveControlRequest(req)
          .catch((e): ResolveReply => ({ ok: false, value: String(e) }))
          .then((reply) => {
            if (reply) void invoke("browser_control_reply", { reqId, ok: reply.ok, value: reply.value }).catch(() => {});
          });
      }),
      listen<ActivityEvent>("browser-control-activity", (e) => {
        if (!e.pageId) return;
        const summary = e.summary || e.tool || "";
        if (summary) patchPageControl(e.pageId, { lastAction: { summary, at: e.at ?? Date.now() } });
      }),
      listen<{ pageId: string }>("browser-control-user", (e) => {
        if (getBrowserSettings().pauseOnUser) patchPageControl(e.pageId, { paused: true });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);
}
