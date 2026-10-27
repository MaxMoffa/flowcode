// The other PCs this desktop is paired with (it is their "phone"): their live
// status, their tabs and chats, and the message bus the open views stream
// through. The connections live in the Rust backend (remote_host_* commands);
// this is the window's mirror of them, shared by the header selector, the
// remote tab strip and the views. One store per window.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ChatInfo, ClientMsg, MirroredSettings, ServerMsg, Tab } from "../../shared/remote-types";
import { isAgentBusy, isAgentExited } from "../chat/chatModel";
import { t } from "../i18n";

type HostStatus = "offline" | "connecting" | "online";

export interface HostInfo {
  id: string;
  hostName: string;
  deviceName: string;
  status: HostStatus;
  error?: string;
  caps: string[];
  appVersion?: string;
}

/** `"local"` = this PC; otherwise a host id. */
type ActiveHost = string;
export const LOCAL_HOST = "local";

interface HostState {
  tabs: Tab[];
  chats: ChatInfo[];
  settings: MirroredSettings | null;
  /** `pty:<ptyId>` or `chat:<chatId>` of the tab in front. */
  activeKey: string | null;
}

interface Snapshot {
  hosts: Record<string, HostInfo>;
  list: HostInfo[];
  state: Record<string, HostState>;
  activeHost: ActiveHost;
}

const EMPTY_STATE: HostState = { tabs: [], chats: [], settings: null, activeKey: null };

/** How long after "new terminal"/"new chat" the first tab to appear is taken as the new one. */
export const NEW_TAB_WAIT_MS = 10_000;

const ptyKey = (ptyId: string) => `pty:${ptyId}`;
const chatKey = (chatId: string) => `chat:${chatId}`;

export type RemoteEntry = { key: string; kind: "pty"; tab: Tab } | { key: string; kind: "chat"; chat: ChatInfo };

/** The tabs of a host in strip order: by desktop window (in order of appearance), terminals before chats within one. */
export function remoteEntries(tabs: Tab[], chats: ChatInfo[]): RemoteEntry[] {
  const windows: string[] = [];
  for (const w of [...tabs.map((x) => x.window), ...chats.map((x) => x.window)]) if (!windows.includes(w)) windows.push(w);
  return windows.flatMap((w) => [
    ...tabs.filter((x) => x.window === w).map((tab): RemoteEntry => ({ key: ptyKey(tab.ptyId), kind: "pty", tab })),
    ...chats.filter((x) => x.window === w).map((chat): RemoteEntry => ({ key: chatKey(chat.chatId), kind: "chat", chat })),
  ]);
}

/** Keeps the tab in front while it exists, else the first one left. */
export function pickActiveKey(current: string | null, keys: string[]): string | null {
  if (current && keys.includes(current)) return current;
  return keys[0] ?? null;
}

/** The first key that wasn't there before (the tab a "new" button just made). */
export function firstNewKey(before: ReadonlySet<string>, keys: string[]): string | null {
  return keys.find((k) => !before.has(k)) ?? null;
}

let snap: Snapshot = { hosts: {}, list: [], state: {}, activeHost: LOCAL_HOST };
const subs = new Set<() => void>();
const bus = new Map<string, Set<(msgs: ServerMsg[]) => void>>();
/** Keys before a "new" request, per host, until the new tab shows up (or the wait ends). */
const pendingNew = new Map<string, { before: Set<string>; until: number }>();

function commit(next: Snapshot) {
  snap = next;
  subs.forEach((fn) => fn());
}

function setHosts(list: HostInfo[]) {
  const hosts = Object.fromEntries(list.map((h) => [h.id, h]));
  const activeHost = snap.activeHost !== LOCAL_HOST && !hosts[snap.activeHost] ? LOCAL_HOST : snap.activeHost;
  const state = Object.fromEntries(Object.entries(snap.state).filter(([id]) => hosts[id]));
  commit({ ...snap, hosts, list, state, activeHost });
}

function patchState(hostId: string, fn: (s: HostState) => HostState) {
  const prev = snap.state[hostId] ?? EMPTY_STATE;
  const next = fn(prev);
  if (next !== prev) commit({ ...snap, state: { ...snap.state, [hostId]: next } });
}

/** Folds the messages that describe a host (tabs, chats, settings) into the store. */
function applyMessages(hostId: string, msgs: ServerMsg[]) {
  for (const m of msgs) {
    if (m.t !== "tabs" && m.t !== "chats" && m.t !== "settings") continue;
    patchState(hostId, (s) => {
      const next = m.t === "tabs" ? { ...s, tabs: m.tabs } : m.t === "chats" ? { ...s, chats: m.chats } : { ...s, settings: m.settings };
      if (m.t === "settings") return next;
      const keys = remoteEntries(next.tabs, next.chats).map((e) => e.key);
      const pending = pendingNew.get(hostId);
      if (pending && Date.now() > pending.until) pendingNew.delete(hostId);
      const fresh = pending && Date.now() <= pending.until ? firstNewKey(pending.before, keys) : null;
      if (fresh) pendingNew.delete(hostId);
      return { ...next, activeKey: fresh ?? pickActiveKey(next.activeKey, keys) };
    });
  }
}

let started = false;
/** Starts listening to the backend; safe to call from anywhere, any number of times. */
function ensureRemoteHosts() {
  if (started) return;
  started = true;
  const refresh = () => invoke<HostInfo[]>("remote_hosts").then(setHosts).catch(() => {});
  void listen<HostInfo>("remote-host://state", (e) => {
    const h = e.payload;
    const known = !!snap.hosts[h.id];
    const hosts = { ...snap.hosts, [h.id]: h };
    commit({ ...snap, hosts, list: known ? snap.list.map((x) => (x.id === h.id ? h : x)) : [...snap.list, h] });
  });
  void listen<{ hostId: string; msgs: ServerMsg[] }>("remote-host://msgs", (e) => {
    const { hostId, msgs } = e.payload;
    applyMessages(hostId, msgs);
    bus.get(hostId)?.forEach((fn) => fn(msgs));
    // The backend sends every window each host's messages: only the window with that PC in front says what went wrong.
    if (hostId !== snap.activeHost) return;
    for (const m of msgs) {
      const notice = errorNotice(m);
      if (notice) notices.forEach((fn) => fn(notice));
    }
  });
  void listen("remote-host://list", refresh);
  void refresh();
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => void subs.delete(fn);
}
const getSnapshot = () => snap;

function useStore<T>(select: (s: Snapshot) => T): T {
  useEffect(ensureRemoteHosts, []);
  return useSyncExternalStore(subscribe, () => select(getSnapshot()));
}

export const useHosts = () => useStore((s) => s.list);
export const useHost = (id: string) => useStore((s) => s.hosts[id]);
export const useActiveHost = () => useStore((s) => s.activeHost);
export const useHostState = (id: string) => useStore((s) => s.state[id] ?? EMPTY_STATE);

/** Messages of a host, in batches as the backend delivers them (output, snapshots, chat events...). */
export function onHostMessages(hostId: string, fn: (msgs: ServerMsg[]) => void): () => void {
  let set = bus.get(hostId);
  if (!set) bus.set(hostId, (set = new Set()));
  set.add(fn);
  return () => void set.delete(fn);
}

const notices = new Set<(message: string) => void>();

/** What a host's message has to tell the user, if anything: a non-fatal error (a fatal one ends the link and shows on the host's status). `agent_busy` is handled by the chat that sent the prompt (it goes back in the queue). */
export function errorNotice(m: ServerMsg): string | null {
  if (m.t !== "error" || m.fatal || isAgentBusy(m.message)) return null;
  // The chat's own events show the agent ended; the refused message just never got there.
  if (isAgentExited(m.message)) return t("remoteHosts.agentExited");
  return m.message;
}

/** Errors of the PC in front of this window, as they come, to show as a transient notice. */
export function onRemoteNotice(fn: (message: string) => void): () => void {
  notices.add(fn);
  return () => void notices.delete(fn);
}

/**
 * Prompts this window sent to each host that are still waiting for their
 * `user` event, keyed by an id of the sending chat view. An `agent_busy`
 * refusal names no chat, so it can only be told apart when exactly one is in
 * flight. The backend hands host messages to every window, and a window can't
 * see the others' prompts: two windows each with one prompt in flight to the
 * same PC would both claim it. Rare (two windows sending to one PC in the same
 * instant), and the worst case is a message sent again after the turn.
 */
const inFlight = new Map<string, Set<string>>();

export function setPromptInFlight(hostId: string, sender: string, flying: boolean) {
  let set = inFlight.get(hostId);
  if (flying) {
    if (!set) inFlight.set(hostId, (set = new Set()));
    set.add(sender);
  } else if (set) {
    set.delete(sender);
    if (set.size === 0) inFlight.delete(hostId);
  }
}

/** An `agent_busy` refusal from `hostId` is this sender's: the only prompt this window has in flight to that PC. */
export function claimBusyRefusal(hostId: string, sender: string): boolean {
  const set = inFlight.get(hostId);
  return !!set && set.size === 1 && set.has(sender);
}

/** What the shortcuts can do to the remote terminal in front (copy, paste, clear). */
export interface RemoteTerminalHandle {
  copySelection: () => void;
  paste: () => void;
  clear: () => void;
}

let frontTerminal: RemoteTerminalHandle | null = null;

/** The remote terminal on screen registers itself while it is; `null` (with the same handle) when it goes. */
export function setFrontRemoteTerminal(handle: RemoteTerminalHandle, front: boolean) {
  if (front) frontTerminal = handle;
  else if (frontTerminal === handle) frontTerminal = null;
}

export const frontRemoteTerminal = (): RemoteTerminalHandle | null => frontTerminal;

/** Resolves false when the message did not leave ("not connected", "busy"). */
export function sendToHost(id: string, msg: ClientMsg): Promise<boolean> {
  return invoke("remote_host_send", { id, msg }).then(
    () => true,
    () => false,
  );
}

export const connectHost = (id: string) => invoke("remote_host_connect", { id }).catch(() => {});
export const disconnectHost = (id: string) => invoke("remote_host_disconnect", { id }).catch(() => {});
export const forgetHost = (id: string) => invoke("remote_host_forget", { id }).catch(() => {});

/** Starts the reconnect loop of every paired PC, so their status in a menu is live. */
export function connectAllHosts() {
  snap.list.forEach((h) => void connectHost(h.id));
}

export function setActiveHost(id: ActiveHost) {
  if (id === snap.activeHost) return;
  commit({ ...snap, activeHost: id });
  if (id === LOCAL_HOST) return;
  void connectHost(id);
  // The latest tabs/chats the backend already holds, so the strip is not empty until the next change.
  invoke<ServerMsg[]>("remote_host_cached", { id })
    .then((msgs) => applyMessages(id, msgs))
    .catch(() => {});
}

export function selectRemoteKey(hostId: string, key: string) {
  patchState(hostId, (s) => (s.activeKey === key ? s : { ...s, activeKey: key }));
}

/** Call right before asking a host for a new tab or chat: the first one to appear next is brought to the front. */
export function expectNewTab(hostId: string) {
  const s = snap.state[hostId] ?? EMPTY_STATE;
  pendingNew.set(hostId, { before: new Set(remoteEntries(s.tabs, s.chats).map((e) => e.key)), until: Date.now() + NEW_TAB_WAIT_MS });
}

/** Closes a tab of a PC: a terminal or a chat, when that PC can. The remote refuses the last tab of a window. */
export function closeRemoteEntry(hostId: string, entry: RemoteEntry) {
  const caps = snap.hosts[hostId]?.caps ?? [];
  if (entry.kind === "pty") {
    if (caps.includes("closeTab")) void sendToHost(hostId, { t: "closetab", ptyId: entry.tab.ptyId });
  } else if (caps.includes("chatCloseTab")) {
    void sendToHost(hostId, { t: "chatclosetab", chatId: entry.chat.chatId });
  }
}

/** Keyboard shortcuts while a PC is in front: the same gestures as on local tabs, on its tabs. */
export const remoteShortcuts = {
  newTab(hostId: string) {
    if (snap.hosts[hostId]?.status !== "online") return;
    expectNewTab(hostId);
    void sendToHost(hostId, { t: "newtab" });
  },
  closeTab(hostId: string) {
    const s = snap.state[hostId] ?? EMPTY_STATE;
    const entry = remoteEntries(s.tabs, s.chats).find((e) => e.key === s.activeKey);
    if (entry) closeRemoteEntry(hostId, entry);
  },
  /** `delta` steps along the strip, wrapping around. */
  step(hostId: string, delta: number) {
    const s = snap.state[hostId] ?? EMPTY_STATE;
    const keys = remoteEntries(s.tabs, s.chats).map((e) => e.key);
    if (keys.length === 0) return;
    const at = Math.max(0, keys.indexOf(s.activeKey ?? ""));
    selectRemoteKey(hostId, keys[(at + delta + keys.length) % keys.length]);
  },
  /** `index` -1 = the last tab. */
  select(hostId: string, index: number) {
    const s = snap.state[hostId] ?? EMPTY_STATE;
    const keys = remoteEntries(s.tabs, s.chats).map((e) => e.key);
    const key = index < 0 ? keys[keys.length - 1] : keys[index];
    if (key) selectRemoteKey(hostId, key);
  },
};
