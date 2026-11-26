import { PEER_IN_METHOD, PEER_OUT_METHOD, parsePeerIn, parsePeerOut, type PeerIn, type PeerOut } from "../chat/peerMessage";

/** The messages of a terminal tab: what other agents sent it (its inbox) and what its agent sent, latest state per message. */
export interface TerminalPeers {
  incoming: PeerIn[];
  outgoing: PeerOut[];
  /** Ids the user closed the card on. */
  dismissed: string[];
}

export const EMPTY_TERMINAL_PEERS: TerminalPeers = { incoming: [], outgoing: [], dismissed: [] };

/** Messages kept per side: the card shows the latest. */
const KEEP = 20;

/** Folds one `_flowcode/peer_in` / `_flowcode/peer_out` event of the tab's stream; anything else leaves it as it is. */
export function applyTerminalPeer(state: TerminalPeers, method: string, params: unknown): TerminalPeers {
  if (method === PEER_IN_METHOD) {
    const peer = parsePeerIn(params);
    if (!peer) return state;
    const known = state.incoming.some((p) => p.msgId === peer.msgId);
    const incoming = known ? state.incoming.map((p) => (p.msgId === peer.msgId ? peer : p)) : [...state.incoming, peer].slice(-KEEP);
    return { ...state, incoming };
  }
  if (method === PEER_OUT_METHOD) {
    const out = parsePeerOut(params);
    if (!out) return state;
    const known = state.outgoing.some((p) => p.msgId === out.msgId);
    const outgoing = known ? state.outgoing.map((p) => (p.msgId === out.msgId ? out : p)) : [...state.outgoing, out].slice(-KEEP);
    return { ...state, outgoing };
  }
  return state;
}

/** Merges the backend's snapshot (`agent_messages_of_tab`: `[{ method, params }]`, oldest first) under the live state. */
export function seedTerminalPeers(state: TerminalPeers, raw: unknown): TerminalPeers {
  if (!Array.isArray(raw)) return state;
  let seeded = EMPTY_TERMINAL_PEERS;
  for (const entry of raw) {
    const e = (entry && typeof entry === "object" ? entry : {}) as { method?: unknown; params?: unknown };
    if (typeof e.method === "string") seeded = applyTerminalPeer(seeded, e.method, e.params);
  }
  // A live event is newer than the snapshot.
  const merge = <T extends { msgId: string }>(snap: T[], live: T[]) => [...snap.map((p) => live.find((l) => l.msgId === p.msgId) ?? p), ...live.filter((l) => !snap.some((p) => p.msgId === l.msgId))];
  const incoming = merge(seeded.incoming, state.incoming);
  const outgoing = merge(seeded.outgoing, state.outgoing);
  return { incoming, outgoing, dismissed: state.dismissed };
}

/** What the card shows: incoming messages still waiting (consent or unread) or new, and the outgoing ones not closed; at most a few each. */
export function shownTerminalPeers(state: TerminalPeers): { incoming: PeerIn[]; outgoing: PeerOut[] } {
  const open = (id: string) => !state.dismissed.includes(id);
  const incoming = state.incoming.filter((p) => !p.hidden && (p.state === "pending_consent" || p.state === "queued" || open(p.msgId))).slice(-4);
  const outgoing = state.outgoing.filter((p) => open(p.msgId)).slice(-3);
  return { incoming, outgoing };
}

/** The user closed the card: what it shows now goes, except what still waits for them. */
export function dismissTerminalPeers(state: TerminalPeers): TerminalPeers {
  const shown = shownTerminalPeers(state);
  const ids = [...shown.incoming.filter((p) => p.state !== "pending_consent" && p.state !== "queued").map((p) => p.msgId), ...shown.outgoing.map((p) => p.msgId)];
  return { ...state, dismissed: [...state.dismissed, ...ids].slice(-100) };
}

/** Unread messages: the agent has not called read_messages yet. */
export const unreadTerminalPeers = (state: TerminalPeers): number => state.incoming.filter((p) => p.state === "queued").length;
