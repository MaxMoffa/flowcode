// Bridge to the Rust core (iroh connection) plus the app-wide store the
// screens read. Rust emits every server message and every connection state;
// this module folds the ones several screens share into one snapshot and
// lets individual screens subscribe to the raw stream for the rest.
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

// Cached so the desktop's colors are on screen from the first frame.
function loadSettings(): MirroredSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as MirroredSettings) : null;
  } catch {
    return null;
  }
}

function saveSettings(s: MirroredSettings | null) {
  try {
    if (s) localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    else localStorage.removeItem(SETTINGS_KEY);
  } catch {
    // Storage can be unavailable; the cache is only an optimization.
  }
}

let snap: Snapshot = { status: "loading", wasOnline: false, pairing: false, tabs: null, usage: [], actions: [], settings: loadSettings(), lastOpened: null, toast: null };
const storeListeners = new Set<() => void>();
const msgListeners = new Set<(m: ServerMsg) => void>();

function set(patch: Partial<Snapshot>) {
  snap = { ...snap, ...patch };
  storeListeners.forEach((l) => l());
}

export function useRemote(): Snapshot {
  return useSyncExternalStore(
    (l) => {
      storeListeners.add(l);
      return () => void storeListeners.delete(l);
    },
    () => snap,
  );
}

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
    if (snap.toast?.id === id) set({ toast: null });
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
    case "settings":
      saveSettings(m.settings);
      set({ settings: m.settings });
      break;
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
export const retryNow = (): Promise<void> => invoke("retry_now");
export const unpair = (): Promise<void> => invoke("unpair");

export function send(msg: ClientMsg) {
  // "not connected" is routine while reconnecting; the UI already shows the reconnect sheet.
  invoke("send", { msg }).catch(() => {});
}

/** Sends a setting to the desktop and patches the local copy so the UI answers at once. */
export function setSetting(key: string, value: unknown) {
  send({ t: "set", key, value });
  const cur = snap.settings;
  if (!cur) return;
  const next: Record<string, unknown> = { ...cur };
  const [head, tail] = key.split(".");
  if (tail) next[head] = { ...(cur as unknown as Record<string, Record<string, unknown>>)[head], [tail]: value };
  else next[head] = value;
  const settings = next as unknown as MirroredSettings;
  saveSettings(settings);
  set({ settings });
}

export function onDeepLink(l: (url: string) => void): Promise<() => void> {
  return listen<string>("remote://deeplink", (e) => l(e.payload));
}
