// Bridge to the Rust core (iroh connection) plus the app-wide store the
// screens read. Rust emits every server message and every connection state;
// this module folds the ones several screens share into one snapshot and
// lets individual screens subscribe to the raw stream for the rest.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { setLanguage, t } from "./i18n";
import { createStore, safeStorage } from "./store";
import { hostInfoFrom, supports, type HostInfo } from "./compatCheck";
import { normalizeLoggedIn, normalizeProfiles, normalizeSettings } from "./settingsModel";

import type { Action, ClientMsg, RemoteCap, MirroredSettings, ProfileAction, ProfileCli, ProfileInfo, ServerMsg, SettingKey, Tab, UsageItem } from "../../shared/remote-types";

// The wire types live in shared/ (also used by the desktop); screens keep importing them from here.
export type { Action, AgentStatus, ClientMsg, LsEntry, MirroredSettings, ProfileAction, ProfileCli, ProfileInfo, ServerMsg, SettingKey, Tab, UsageItem, UsageMetric } from "../../shared/remote-types";

export type ConnStatus = "loading" | "unpaired" | "connecting" | "online" | "offline";

interface Snapshot {
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
  /** A pairing was just made and the link hasn't come online yet: no "connection lost" sheet for that. */
  firstConnect: boolean;
  tabs: Tab[] | null;
  usage: UsageItem[];
  actions: Action[];
  /** The desktop's settings, mirrored; null until it sends them (older desktops never do). */
  settings: MirroredSettings | null;
  /** The desktop's account profiles besides the default; null until it sends them (older desktops never do). */
  profiles: ProfileInfo[] | null;
  /** The default profile's sign-ins; null when the desktop doesn't say (older desktops). */
  defaultLoggedIn: Record<ProfileCli, boolean> | null;
  /** What the connected desktop said about itself in `ready`; null before the first one. */
  host: HostInfo | null;
  /** The "older desktop" banner was closed for this connection. */
  compatDismissed: boolean;
  /** Last terminal the user opened: the Files screen starts there. */
  lastOpened: string | null;
  /** The tab a tapped notification was about, until the app has opened it. */
  openTab: string | null;
  toast: { id: number; text: string } | null;
}

const SETTINGS_KEY = "flowcode.settings";


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

/** What was last written to the cache, so an identical echo from the desktop costs no write. */
let lastSaved: string | null = null;

function saveSettings(s: MirroredSettings | null) {
  if (!s) {
    lastSaved = null;
    safeStorage.remove(SETTINGS_KEY);
    return;
  }
  const json = JSON.stringify(s);
  if (json === lastSaved) return;
  lastSaved = json;
  safeStorage.set(SETTINGS_KEY, json);
}

/** Forgets the cached settings (the error boundary's "Reimposta"). */
export function resetSettingsCache() {
  saveSettings(null);
  pending.clear();
  store.set({ settings: null });
}

const store = createStore<Snapshot>({ status: "loading", wasOnline: false, pairing: false, firstConnect: false, tabs: null, usage: [], actions: [], settings: loadSettings(), profiles: null, defaultLoggedIn: null, host: null, compatDismissed: false, lastOpened: null, openTab: null, toast: null });
const msgListeners = new Set<(m: ServerMsg) => void>();
const set = store.set;

// The phone follows the desktop's language. Registered before any component
// subscribes, so the catalog is switched before the re-render that reads it.
const followLanguage = () => setLanguage(store.get().settings?.resolvedLanguage);
followLanguage();
store.subscribe(followLanguage);

export const useRemote = store.use;
/** Like `useRemote`, but only re-renders when the selected slice changes. */
export const useRemoteSelector = store.useSelector;

/** Whether the connected desktop supports a feature (true while it is not known yet). */
export const useSupports = (cap: RemoteCap): boolean => store.useSelector((s) => supports(s.host, cap));

export const dismissCompat = () => set({ compatDismissed: true });

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

/** A pairing was just created: hold back the reconnect sheet until the link is online once. */
export function markFirstConnect(on: boolean) {
  set({ firstConnect: on });
}

function handleMsg(m: ServerMsg) {
  switch (m.t) {
    case "ready": {
      // A different desktop (or an update) deserves the banner again; a plain reconnect to the same one does not.
      const host = hostInfoFrom(m);
      const prev = store.get().host;
      const same = !!prev && prev.appVersion === host.appVersion && prev.proto === host.proto && prev.caps.join(",") === host.caps.join(",");
      set(same ? { host } : { host, compatDismissed: false });
      break;
    }
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
    case "profiles":
      set({ profiles: normalizeProfiles(m.profiles), defaultLoggedIn: normalizeLoggedIn(m.defaultLoggedIn) });
      break;
    case "notify":
      // Out of sight, the core shows it as an Android notification instead.
      if (!document.hidden) showToast(m.body ? `${m.title}: ${m.body}` : m.title);
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
  try {
    await wire();
  } catch (e) {
    // Let a retry wire the events again instead of leaving the app never connecting.
    unlisteners.forEach((un) => un());
    unlisteners = [];
    started = false;
    throw e;
  }
}

/** The listeners `wire` registered, dropped if it fails halfway so a retry doesn't double them. */
let unlisteners: (() => void)[] = [];

async function wire(): Promise<void> {
  unlisteners.push(await listen<ServerMsg>("remote://msg", (e) => handleMsg(e.payload)));
  unlisteners.push(await listen<StateEvent>("remote://state", (e) => {
    const { status, hostName, error, phase, attempt, retryAt } = e.payload;
    // Cached data belongs to the old pairing/connection; a reconnect refreshes it.
    if (status === "unpaired") saveSettings(null);
    set({ status, hostName, error, phase, attempt, retryAt, ...(status === "online" ? { wasOnline: true, firstConnect: false } : {}), ...(status === "offline" ? { firstConnect: false } : {}), ...(status === "unpaired" ? { wasOnline: false, firstConnect: false, pairing: false, tabs: null, usage: [], actions: [], settings: null, profiles: null, defaultLoggedIn: null, host: null, compatDismissed: false, lastOpened: null, openTab: null } : {}) });
  }));
  // Another desktop became the active one: what is shown belongs to the old one.
  unlisteners.push(await listen("remote://computer", () => {
    saveSettings(null);
    pending.clear();
    set({ wasOnline: false, firstConnect: true, tabs: null, usage: [], actions: [], settings: null, profiles: null, defaultLoggedIn: null, host: null, compatDismissed: false, lastOpened: null, openTab: null });
  }));
  // The active desktop refused this phone for good; the core already moved to another saved one.
  unlisteners.push(await listen<{ host: string; message: string }>("remote://revoked", (e) => showToast(t("computerRevoked", { host: e.payload.host, message: e.payload.message }))));
  void checkNotificationTap();
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
export const appResumed = (): Promise<void> => {
  void checkNotificationTap();
  return invoke<void>("app_resumed").catch(() => {});
};
/** Drops the link after a while in the background (a no-op when the background mode is on). */
export const suspendLink = (): Promise<void> => invoke<void>("suspend_link").catch(() => {});
/** Tells the core the app went out of sight: with the background mode on, the PC is asked to send notifications only. */
export const appHidden = (): Promise<void> => invoke<void>("app_hidden").catch(() => {});

const OPEN_TAB_MS = 10_000;
const PERMISSION_TIMEOUT_MS = 60_000;

/** Picks up the tab of the notification that opened the app, if any; `App` opens it once the tab list has it. */
async function checkNotificationTap() {
  const tabId = await invoke<string | null>("take_pending_tab").catch(() => null);
  if (!tabId) return;
  set({ openTab: tabId });
  setTimeout(() => {
    if (store.get().openTab === tabId) set({ openTab: null });
  }, OPEN_TAB_MS);
}

export const clearOpenTab = () => set({ openTab: null });

export interface BackgroundSettings {
  enabled: boolean;
  /** Minutes in the background before the connection is dropped; 0 = never. */
  capMinutes: number;
}

export const DEFAULT_BACKGROUND: BackgroundSettings = { enabled: false, capMinutes: 120 };

export const backgroundSettings = (): Promise<BackgroundSettings> => invoke<BackgroundSettings>("background_settings").then((s) => s ?? DEFAULT_BACKGROUND).catch(() => DEFAULT_BACKGROUND);
export const setBackgroundSettings = (enabled: boolean, capMinutes: number): Promise<void> => invoke<void>("set_background_settings", { enabled, capMinutes });
/** The wording of the permanent notification shown while the app is in the background. */
export const setBackgroundTexts = (title: string, text: string): Promise<void> => invoke<void>("background_texts", { title, text }).catch(() => {});
export const notificationPermission = (): Promise<boolean> => invoke<boolean>("notification_permission").catch(() => false);
/** Asks Android for the notification permission; resolves once the user has answered. */
export const requestNotificationPermission = (): Promise<boolean> =>
  Promise.race([
    invoke<boolean>("request_notification_permission").catch(() => false),
    // The system dialog can be abandoned (activity destroyed): don't wait on it forever.
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PERMISSION_TIMEOUT_MS)),
  ]);
export const retryNow = (): Promise<void> => invoke("retry_now");
/** Stops a pairing that is waiting for the desktop's confirmation. */
export const cancelPair = (): Promise<void> => invoke<void>("cancel_pair").catch(() => {});
export const unpair = (): Promise<void> => invoke("unpair");
/** The core's last connection events (dial, handshake, backoff, close reasons), oldest first. */
export const connectionLog = (): Promise<{ at: number; text: string }[]> => invoke<{ at: number; text: string }[]>("connection_log").catch(() => []);

/** A desktop this phone is paired with. */
export interface Computer {
  id: string;
  hostName: string;
  active: boolean;
}
/** Every paired desktop, the one in use first; rejects with the core's message when they can't be read. */
export const listComputers = (): Promise<Computer[]> => invoke<Computer[]>("computers");
/** Makes another paired desktop the active one; the connection restarts on it. */
export const switchComputer = (id: string): Promise<void> => invoke("switch_computer", { id });
/** Removes a saved, non-active computer from this phone (the desktop keeps listing the phone until revoked there). */
export const forgetComputer = (id: string): Promise<void> => invoke("forget_computer", { id });

export function send(msg: ClientMsg) {
  // "not connected" is routine while reconnecting; the UI already shows the reconnect sheet.
  invoke("send", { msg }).catch(() => {});
}

/** Local changes the desktop hasn't echoed back yet, by setting key. */
const pending = new Map<SettingKey, { value: unknown; at: number }>();
const PENDING_MS = 2000;

function withPath(settings: MirroredSettings, key: SettingKey, value: unknown): MirroredSettings {
  const next: Record<string, unknown> = { ...settings };
  const [head, tail] = key.split(".");
  if (tail) next[head] = { ...(settings as unknown as Record<string, Record<string, unknown>>)[head], [tail]: value };
  else next[head] = value;
  return next as unknown as MirroredSettings;
}

function valueAt(settings: MirroredSettings, key: SettingKey): unknown {
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
export function setSetting(key: SettingKey, value: unknown) {
  send({ t: "set", key, value });
  const cur = store.get().settings;
  if (!cur) return;
  pending.set(key, { value, at: Date.now() });
  const settings = withPath(cur, key, value);
  saveSettings(settings);
  set({ settings });
}

/** Asks the desktop to create / change / delete a profile, or to open a CLI's sign-in in a new terminal tab. The reply is the next `profiles` message. */
export function profileAction(action: ProfileAction) {
  send({ t: "profile", ...action });
}

export function onDeepLink(l: (url: string) => void): Promise<() => void> {
  return listen<string>("remote://deeplink", (e) => l(e.payload));
}

/** Types Ctrl+C into a terminal. */
export function interrupt(ptyId: string) {
  send({ t: "input", ptyId, data: "\x03" });
}
