// What the agent in a desktop terminal tab does through Flowcode's MCP tools, as the desktop reports it on the terminal stream (`ext` messages): its delegations, and pages it asks to open.
import { parseDelegate, type DelegateInfo } from "../../src/chat/chatModel";
import { EMPTY_TERMINAL_DELEGATES, upsertTerminalDelegate, type TerminalDelegates } from "../../src/terminal/terminalDelegates";
import { applyTerminalPeer, EMPTY_TERMINAL_PEERS, type TerminalPeers } from "../../src/terminal/terminalPeers";
import { PEER_IN_METHOD, PEER_OUT_METHOD } from "../../src/chat/peerMessage";
import { isPreviewableFile } from "../../shared/agentOpen";
import type { ServerMsg } from "../../shared/remote-types";
import { relativeArtifactPath } from "./agentPreview";
import { localLinkPage, parseTyped, type Page } from "./browserUrl";
import { onMessage } from "./remote";
import { createStore } from "./store";

const store = createStore<{ delegations: Record<string, TerminalDelegates>; peers: Record<string, TerminalPeers> }>({ delegations: {}, peers: {} });
const NONE: DelegateInfo[] = [];

/** A terminal tab's agent asked to open `target` (a URL or a file); `cwd` is where it asked from. */
export interface TermOpen {
  target: string;
  cwd: string;
}
const openListeners = new Map<string, Set<(open: TermOpen) => void>>();

/** Applies one `ext` message. Methods the phone does not show (calls, requests: a delegate that waits says so in its own state, and its chat answers it) are ignored. */
/** @internal exported for tests */
export function applyTermExt(ptyId: string, method: string, params: unknown) {
  if (method === "_flowcode/delegate") {
    const delegate = parseDelegate(params);
    if (!delegate) return;
    const prev = store.get().delegations[ptyId] ?? EMPTY_TERMINAL_DELEGATES;
    const next = upsertTerminalDelegate(prev, delegate);
    if (next !== prev) store.set({ delegations: { ...store.get().delegations, [ptyId]: next } });
  } else if (method === PEER_IN_METHOD || method === PEER_OUT_METHOD) {
    // Messages from and to other tabs' agents (a desktop with `agentMessages` seeds the open ones when the stream starts).
    const prev = store.get().peers[ptyId] ?? EMPTY_TERMINAL_PEERS;
    const next = applyTerminalPeer(prev, method, params);
    if (next !== prev) store.set({ peers: { ...store.get().peers, [ptyId]: next } });
  } else if (method === "_flowcode/open") {
    const { target, cwd } = (params && typeof params === "object" ? params : {}) as { target?: unknown; cwd?: unknown };
    if (typeof target !== "string" || target === "") return;
    openListeners.get(ptyId)?.forEach((l) => l({ target, cwd: typeof cwd === "string" ? cwd : "" }));
  }
}

/** The tabs that are gone take their delegations with them. */
/** @internal exported for tests */
export function pruneTermExt(alive: Set<string>) {
  const current = store.get().delegations;
  const kept = Object.fromEntries(Object.entries(current).filter(([id]) => alive.has(id)));
  if (Object.keys(kept).length !== Object.keys(current).length) store.set({ delegations: kept });
  const peers = store.get().peers;
  const keptPeers = Object.fromEntries(Object.entries(peers).filter(([id]) => alive.has(id)));
  if (Object.keys(keptPeers).length !== Object.keys(peers).length) store.set({ peers: keptPeers });
}

/** The messages of the terminal's agent, received and sent. */
export function useTermPeers(ptyId: string): TerminalPeers {
  return store.useSelector((s) => s.peers[ptyId] ?? EMPTY_TERMINAL_PEERS);
}

/** The user closed the terminal's message cards (what still waits stays). */
export function dismissTermPeers(ptyId: string, next: (prev: TerminalPeers) => TerminalPeers) {
  const prev = store.get().peers[ptyId];
  if (prev) store.set({ peers: { ...store.get().peers, [ptyId]: next(prev) } });
}

onMessage((m: ServerMsg) => {
  if (m.t === "ext") applyTermExt(m.ptyId, m.method, m.params);
  else if (m.t === "tabs") pruneTermExt(new Set(m.tabs.map((x) => x.ptyId)));
});

/** The tasks the terminal's agent delegated, in start order (empty when none, or from a desktop that does not report them). */
export function useTermDelegates(ptyId: string): DelegateInfo[] {
  return store.useSelector((s) => s.delegations[ptyId]?.delegates ?? NONE);
}

/** Calls `l` for each page the terminal's agent asks to open while subscribed (live only: an old request is no news). */
export function onTermOpen(ptyId: string, l: (open: TermOpen) => void): () => void {
  const set = openListeners.get(ptyId) ?? new Set();
  set.add(l);
  openListeners.set(ptyId, set);
  return () => {
    set.delete(l);
    if (set.size === 0) openListeners.delete(ptyId);
  };
}

/** The page an agent's open request shows in the terminal's in-app browser: a web address, or a previewable file inside the tab's folder (else null: nothing to show). */
export function termOpenPage(open: TermOpen, ptyId: string, rootCwd: string): Page | null {
  if (/^https?:\/\//i.test(open.target)) return localLinkPage(open.target);
  if (!isPreviewableFile(open.target)) return null;
  const path = relativeArtifactPath(open.target, open.cwd || rootCwd, rootCwd);
  return path ? parseTyped(path, ptyId) : null;
}

/** @internal exported for tests */
export const getTermDelegates = (ptyId: string): DelegateInfo[] => store.get().delegations[ptyId]?.delegates ?? NONE;
