// Bridge to the Rust core (iroh connection) plus the app-wide store the
// screens read. Rust emits every server message and every connection state;
// this module folds the ones several screens share into one snapshot and
// lets individual screens subscribe to the raw stream for the rest.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setLanguage } from "./i18n";
import { createStore, safeStorage } from "./store";

export type AgentStatus = "busy" | "idle" | "waiting";

export interface Tab {
  ptyId: string;
  tabId: string;
  window: string;
  label: string;
  cwd: string;
  cols: number;
  rows: number;
  cli?: string;
  status?: AgentStatus;
  context?: { used: number; window: number; model?: string };
}

export interface UsageMetric {
  kind: string;
  label?: string;
  percent?: number;
  resets?: string;
  command?: string;
  period?: string;
  cost?: number;
  tokens?: number;
  sessions?: number;
}

export interface UsageItem {
  pluginId: string;
  label: string;
  profile?: string;
  metrics: UsageMetric[];
}

export interface Action {
  id: string;
  label: string;
  icon?: string;
}

export interface LsEntry {
  name: string;
  dir: boolean;
  size?: number;
}

export interface MirroredSettings {
  theme: "auto" | "light" | "dark";
  resolvedTheme: "light" | "dark";
  palette: string;
  terminalPalette: string | null;
  contrast: number;
  glassOpacity: number;
  language: string;
  resolvedLanguage: string;
  languages: { id: string; name: string }[];
  colors: Record<string, string>;
  terminalColors: Record<string, string>;
  palettes: { id: string; name: string; bg: string; accent: string; accent2: string }[];
  terminalFontSize: number;
  bannerEnabled: boolean;
  confirmLinkOpen: boolean;
  restoreSession: boolean;
  newTabPage: boolean;
  notify: { done: boolean; input: boolean; exited: boolean; limitReset: boolean };
  autoResume: { enabled: boolean; message: string };
}

export type ServerMsg =
  | { t: "ready"; deviceName: string; hostName: string }
  | { t: "error"; message: string; ptyId?: string; fatal: boolean }
  | { t: "tabs"; tabs: Tab[] }
  | { t: "snapshot"; ptyId: string; data: string; cols: number; rows: number }
  | { t: "output"; ptyId: string; data: string }
  | { t: "exit"; ptyId: string }
  | { t: "usage"; items: UsageItem[] }
  | { t: "actions"; actions: Action[] }
  | { t: "ls"; ptyId: string; path: string; entries: LsEntry[] }
  | { t: "file"; ptyId: string; path: string; text: string; truncated: boolean }
  | { t: "settings"; settings: MirroredSettings }
  | { t: "pong" };

export type ClientMsg =
  | { t: "list" }
  | { t: "open"; ptyId: string; cols?: number; rows?: number }
  | { t: "resize"; ptyId: string; cols: number; rows: number }
  | { t: "close"; ptyId: string }
  | { t: "input"; ptyId: string; data: string }
  | { t: "action"; id: string; ptyId?: string }
  | { t: "ls"; ptyId: string; path?: string }
  | { t: "read"; ptyId: string; path: string }
  | { t: "set"; key: string; value: unknown }
  | { t: "ping" };

export type ConnStatus = "loading" | "unpaired" | "connecting" | "online" | "offline";

export interface Snapshot {
  status: ConnStatus;
  hostName?: string;
  /** Last connection error, shown while offline or after a forced unpair. */
  error?: string;
  /** Reconnect progress, only while not online. */
  phase?: "waiting" | "dialing" | "handshake";
  /** Consecutive failures since the link was last online. */
  attempt?: number;
  /** Unix ms of the next attempt, only while waiting. */
  retryAt?: number;
  /** Has been online at least once in this run. */
  wasOnline: boolean;
  /** True while the pairing screen is mid-`pair`, so it stays on screen. */
  pairing: boolean;
  tabs: Tab[] | null;
  usage: UsageItem[];
  actions: Action[];
  /** The desktop's settings, mirrored; null until it sends them (older desktops never do). */
  settings: MirroredSettings | null;
  /** Last terminal the user opened: the Files screen starts there. */
  lastOpened: string | null;
  toast: { id: number; text: string } | null;
}

const SETTINGS_KEY = "flowcode.settings";

/** Used for any field a cached or incoming settings object lacks or gets wrong. */
export const DEFAULT_SETTINGS: MirroredSettings = {
  theme: "auto",
  resolvedTheme: "dark",
  palette: "",
  terminalPalette: null,
  contrast: 0.5,
  glassOpacity: 0.5,
  language: "system",
  resolvedLanguage: "en",
  languages: [],
  colors: {},
  terminalColors: {},
  palettes: [],
  terminalFontSize: 14,
  bannerEnabled: true,
  confirmLinkOpen: true,
  restoreSession: true,
  newTabPage: false,
  notify: { done: true, input: true, exited: false, limitReset: true },
  autoResume: { enabled: false, message: "" },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, d: string) => (typeof v === "string" ? v : d);
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
const num = (v: unknown, d: number, min = -Infinity, max = Infinity) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);

function strMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const k in v) if (typeof v[k] === "string") out[k] = v[k] as string;
  return out;
}

/** Merges a cached or incoming settings object over the defaults, dropping anything of the wrong shape. Null when it isn't an object at all. */
export function normalizeSettings(raw: unknown): MirroredSettings | null {
  if (!isObj(raw)) return null;
  const d = DEFAULT_SETTINGS;
  const notify = isObj(raw.notify) ? raw.notify : {};
  const resume = isObj(raw.autoResume) ? raw.autoResume : {};
  const list = <T,>(v: unknown, ok: (x: Record<string, unknown>) => T | null): T[] =>
    Array.isArray(v) ? v.flatMap((x) => (isObj(x) ? (ok(x) ?? []) : [])) : [];
  return {
    theme: oneOf(raw.theme, ["auto", "light", "dark"], d.theme),
    resolvedTheme: oneOf(raw.resolvedTheme, ["light", "dark"], d.resolvedTheme),
    palette: str(raw.palette, d.palette),
    terminalPalette: typeof raw.terminalPalette === "string" ? raw.terminalPalette : null,
    contrast: num(raw.contrast, d.contrast, 0, 1),
    glassOpacity: num(raw.glassOpacity, d.glassOpacity, 0, 1),
    language: str(raw.language, d.language),
    resolvedLanguage: str(raw.resolvedLanguage, d.resolvedLanguage),
    languages: list(raw.languages, (x) => (typeof x.id === "string" ? { id: x.id, name: str(x.name, x.id) } : null)),
    colors: strMap(raw.colors),
    terminalColors: strMap(raw.terminalColors),
    palettes: list(raw.palettes, (x) =>
      typeof x.id === "string" ? { id: x.id, name: str(x.name, x.id), bg: str(x.bg, "#000000"), accent: str(x.accent, "#888888"), accent2: str(x.accent2, "#888888") } : null,
    ),
    terminalFontSize: num(raw.terminalFontSize, d.terminalFontSize, 9, 28),
    bannerEnabled: bool(raw.bannerEnabled, d.bannerEnabled),
    confirmLinkOpen: bool(raw.confirmLinkOpen, d.confirmLinkOpen),
    restoreSession: bool(raw.restoreSession, d.restoreSession),
    newTabPage: bool(raw.newTabPage, d.newTabPage),
    notify: {
      done: bool(notify.done, d.notify.done),
      input: bool(notify.input, d.notify.input),
      exited: bool(notify.exited, d.notify.exited),
      limitReset: bool(notify.limitReset, d.notify.limitReset),
    },
    autoResume: { enabled: bool(resume.enabled, d.autoResume.enabled), message: str(resume.message, d.autoResume.message) },
  };
}

// Cached so the desktop's colors are on screen from the first frame.
function loadSettings(): MirroredSettings | null {
  const raw = safeStorage.get(SETTINGS_KEY);
  if (!raw) return null;
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSettings(s: MirroredSettings | null) {
  if (s) safeStorage.set(SETTINGS_KEY, JSON.stringify(s));
  else safeStorage.remove(SETTINGS_KEY);
}

/** Forgets the cached settings (the error boundary's "Reimposta"). */
export function resetSettingsCache() {
  saveSettings(null);
  pending.clear();
  store.set({ settings: null });
}

const store = createStore<Snapshot>({ status: "loading", wasOnline: false, pairing: false, tabs: null, usage: [], actions: [], settings: loadSettings(), lastOpened: null, toast: null });
const msgListeners = new Set<(m: ServerMsg) => void>();
const set = store.set;

// The phone follows the desktop's language. Registered before any component
// subscribes, so the catalog is switched before the re-render that reads it.
const followLanguage = () => setLanguage(store.get().settings?.resolvedLanguage);
followLanguage();
store.subscribe(followLanguage);

export const useRemote = store.use;

/** Raw server messages, for screens that care about replies (ls, file, output...). */
export function onMessage(l: (m: ServerMsg) => void): () => void {
  msgListeners.add(l);
  return () => void msgListeners.delete(l);
}

let toastId = 0;
export function showToast(text: string) {
  const id = ++toastId;
  set({ toast: { id, text } });
  setTimeout(() => {
    if (store.get().toast?.id === id) set({ toast: null });
  }, 2400);
}

export function setLastOpened(ptyId: string) {
  set({ lastOpened: ptyId });
}

export function setPairingBusy(pairing: boolean) {
  set({ pairing });
}

function handleMsg(m: ServerMsg) {
  switch (m.t) {
    case "tabs":
      set({ tabs: m.tabs });
      break;
    case "usage":
      set({ usage: m.items });
      break;
    case "actions":
      set({ actions: m.actions });
      break;
    case "settings": {
      const incoming = normalizeSettings(m.settings);
      if (!incoming) break;
      const settings = applyPending(incoming);
      saveSettings(settings);
      set({ settings });
      break;
    }
    case "error":
      // Fatal ones also arrive as a state change; only requests that failed
      // deserve a toast.
      if (!m.fatal) showToast(m.message);
      break;
  }
  msgListeners.forEach((l) => l(m));
}

interface StateEvent {
  status: Exclude<ConnStatus, "loading">;
  hostName?: string;
  error?: string;
  phase?: "waiting" | "dialing" | "handshake";
  attempt?: number;
  retryAt?: number;
}

let started = false;
/** Wires the events once and kicks off the connection if a pairing exists. */
export async function start(): Promise<void> {
  if (started) return;
  started = true;
  await listen<ServerMsg>("remote://msg", (e) => handleMsg(e.payload));
  await listen<StateEvent>("remote://state", (e) => {
    const { status, hostName, error, phase, attempt, retryAt } = e.payload;
    // Cached data belongs to the old pairing/connection; a reconnect refreshes it.
    if (status === "unpaired") saveSettings(null);
    set({ status, hostName, error, phase, attempt, retryAt, ...(status === "online" ? { wasOnline: true } : {}), ...(status === "unpaired" ? { tabs: null, usage: [], actions: [], settings: null, lastOpened: null } : {}) });
  });
  const state = await invoke<{ paired: boolean; hostName?: string }>("pairing_state");
  if (state.paired) {
    set({ status: "connecting", hostName: state.hostName });
    await invoke("connect");
  } else {
    set({ status: "unpaired" });
  }
}

export const platform = (): Promise<"mobile" | "desktop"> => invoke("platform");
export const takePendingLink = (): Promise<string | null> => invoke("take_pending_link");
export const pair = (ticket: string, deviceName: string): Promise<void> => invoke("pair", { ticket, deviceName });
/** Who a pairing ticket points at; null when the core can't tell (older build). */
export const inspectTicket = (ticket: string): Promise<{ hostName: string; fingerprint: string } | null> =>
  invoke<{ hostName: string; fingerprint: string }>("inspect_ticket", { ticket }).catch(() => null);
/** This phone's short key fingerprint, shown on both screens when pairing. */
export const myFingerprint = (): Promise<string | null> => invoke<string>("my_fingerprint").catch(() => null);
/** Tells the core the app is back in the foreground, so it can redial without waiting for a backoff. */
export const appResumed = (): Promise<void> => invoke<void>("app_resumed").catch(() => {});
export const retryNow = (): Promise<void> => invoke("retry_now");
export const unpair = (): Promise<void> => invoke("unpair");

export function send(msg: ClientMsg) {
  // "not connected" is routine while reconnecting; the UI already shows the reconnect sheet.
  invoke("send", { msg }).catch(() => {});
}

/** Local changes the desktop hasn't echoed back yet, by setting key. */
const pending = new Map<string, { value: unknown; at: number }>();
const PENDING_MS = 2000;

function withPath(settings: MirroredSettings, key: string, value: unknown): MirroredSettings {
  const next: Record<string, unknown> = { ...settings };
  const [head, tail] = key.split(".");
  if (tail) next[head] = { ...(settings as unknown as Record<string, Record<string, unknown>>)[head], [tail]: value };
  else next[head] = value;
  return next as unknown as MirroredSettings;
}

function valueAt(settings: MirroredSettings, key: string): unknown {
  const [head, tail] = key.split(".");
  const v = (settings as unknown as Record<string, unknown>)[head];
  return tail ? (v as Record<string, unknown> | undefined)?.[tail] : v;
}

/** Echoes of an older value must not undo a tap the desktop hasn't caught up with. */
function applyPending(incoming: MirroredSettings): MirroredSettings {
  let out = incoming;
  const now = Date.now();
  for (const [key, p] of pending) {
    if (now - p.at > PENDING_MS || valueAt(incoming, key) === p.value) pending.delete(key);
    else out = withPath(out, key, p.value);
  }
  return out;
}

/** Sends a setting to the desktop and patches the local copy so the UI answers at once. */
export function setSetting(key: string, value: unknown) {
  send({ t: "set", key, value });
  const cur = store.get().settings;
  if (!cur) return;
  pending.set(key, { value, at: Date.now() });
  const settings = withPath(cur, key, value);
  saveSettings(settings);
  set({ settings });
}

export function onDeepLink(l: (url: string) => void): Promise<() => void> {
  return listen<string>("remote://deeplink", (e) => l(e.payload));
}
