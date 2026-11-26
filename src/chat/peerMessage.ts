/** Messages between the agents of different tabs (the backend's `agent_messages.rs`): the events the views get and the framed prompt a replayed history shows. */

/** Where a message stands (the backend's `MsgState`). */
export type PeerState = "pending_consent" | "queued" | "delivered" | "replied" | "declined" | "expired" | "failed";

const PEER_STATES: readonly string[] = ["pending_consent", "queued", "delivered", "replied", "declined", "expired", "failed"];

/** The event on the target (a chat's log or a terminal tab's stream): a message it was sent, and where it stands. */
export const PEER_IN_METHOD = "_flowcode/peer_in";
/** The event on the sender: a message its agent sent, and where it stands. */
export const PEER_OUT_METHOD = "_flowcode/peer_out";

/** The other side of a message: its tab as it was when the message was sent. */
export interface PeerTab {
  tabId?: string;
  label: string;
  /** The CLI id (`claude`, `codex`...), when known. */
  agent?: string;
  /** The window showing it, for "Open tab". */
  window?: string;
  kind?: "chat" | "terminal";
}

/** A message this chat or tab received. */
export interface PeerIn {
  msgId: string;
  text: string;
  from: PeerTab;
  hops: number;
  /** The message of ours it answers. */
  replyTo?: string;
  state: PeerState;
  error?: string;
  /** Consent was asked although the tab's policy would not: the two agents went back and forth too often. */
  forcedConsent?: boolean;
  /** The sender's `wait_for_reply` took it (or is about to): its strip shows it, no card of its own. */
  hidden?: boolean;
  at?: number;
}

/** A message this chat's or tab's agent sent. */
export interface PeerOut {
  msgId: string;
  text: string;
  to: PeerTab;
  state: PeerState;
  error?: string;
  replyTo?: string;
  replyId?: string;
  replyText?: string;
  /** The answer came back through `wait_for_reply`, so no incoming card shows it. */
  replyViaWait?: boolean;
  at?: number;
}

const record = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const stateOf = (v: unknown): PeerState | null => (PEER_STATES.includes(v as string) ? (v as PeerState) : null);

function parseTab(raw: unknown): PeerTab {
  const p = record(raw);
  const kind = p.kind === "chat" || p.kind === "terminal" ? p.kind : undefined;
  return {
    label: str(p.label) ?? "?",
    ...(str(p.tabId) ? { tabId: str(p.tabId) } : {}),
    ...(str(p.agent) ? { agent: str(p.agent) } : {}),
    ...(str(p.window) ? { window: str(p.window) } : {}),
    ...(kind ? { kind } : {}),
  };
}

/** The `_flowcode/peer_in` params, checked; null when they are not a message. */
export function parsePeerIn(raw: unknown): PeerIn | null {
  const p = record(raw);
  const msgId = str(p.msgId);
  const state = stateOf(p.state);
  if (!msgId || !state || typeof p.text !== "string") return null;
  return {
    msgId,
    text: p.text,
    from: parseTab(p.from),
    hops: typeof p.hops === "number" ? p.hops : 0,
    state,
    ...(str(p.replyTo) ? { replyTo: str(p.replyTo) } : {}),
    ...(str(p.error) ? { error: str(p.error) } : {}),
    ...(p.forcedConsent === true ? { forcedConsent: true } : {}),
    ...(p.viaWait === true || p.awaited === true ? { hidden: true } : {}),
    ...(typeof p.at === "number" ? { at: p.at } : {}),
  };
}

/** The `_flowcode/peer_out` params, checked. */
export function parsePeerOut(raw: unknown): PeerOut | null {
  const p = record(raw);
  const msgId = str(p.msgId);
  const state = stateOf(p.state);
  if (!msgId || !state || typeof p.text !== "string") return null;
  return {
    msgId,
    text: p.text,
    to: parseTab(p.to),
    state,
    ...(str(p.error) ? { error: str(p.error) } : {}),
    ...(str(p.replyTo) ? { replyTo: str(p.replyTo) } : {}),
    ...(str(p.replyId) ? { replyId: str(p.replyId) } : {}),
    ...(typeof p.replyText === "string" && p.replyText !== "" ? { replyText: p.replyText } : {}),
    ...(p.replyViaWait === true ? { replyViaWait: true } : {}),
    ...(typeof p.at === "number" ? { at: p.at } : {}),
  };
}

/** The `peer` field of a `user` event (the backend delivered the message as this prompt): the message, delivered. */
export function peerFromUserEvent(meta: unknown, text: string, at: number): PeerIn | null {
  const p = record(meta);
  const msgId = str(p.id);
  if (!msgId) return null;
  const kind = p.fromKind === "chat" || p.fromKind === "terminal" ? p.fromKind : undefined;
  return {
    msgId,
    text,
    from: {
      label: str(p.fromLabel) ?? "?",
      ...(str(p.fromTabId) ? { tabId: str(p.fromTabId) } : {}),
      ...(str(p.fromAgent) ? { agent: str(p.fromAgent) } : {}),
      ...(str(p.fromWindow) ? { window: str(p.fromWindow) } : {}),
      ...(kind ? { kind } : {}),
    },
    hops: typeof p.hops === "number" ? p.hops : 0,
    state: "delivered",
    ...(str(p.replyTo) ? { replyTo: str(p.replyTo) } : {}),
    at,
  };
}

/** The frame's opening tag, as the backend writes it (`agent_messages::frame`). */
export const PEER_FRAME_PREFIX = "<flowcode-message ";

/** The agents' names as the frame says them, back to their CLI ids. */
const AGENT_IDS: Record<string, string> = { claude: "claude", codex: "codex", gemini: "gemini", opencode: "opencode", cline: "cline", vibe: "vibe" };

/**
 * A prompt the backend framed for the agent (`<flowcode-message id=... from="api · Codex" ...>text</flowcode-message>` and a
 * `[Flowcode]` paragraph), as a replayed history gives it back: the message, delivered. Tolerant: the attributes are
 * optional, and a frame cut short (its chunks still streaming) keeps what it has. Null when the text is no frame.
 */
export function parsePeerFrame(text: string): PeerIn | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(PEER_FRAME_PREFIX)) return null;
  const close = trimmed.indexOf(">");
  if (close < 0) return null;
  const attrs: Record<string, string> = {};
  for (const m of trimmed.slice(PEER_FRAME_PREFIX.length - 1, close).matchAll(/([a-z_]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  const rest = trimmed.slice(close + 1).replace(/^\r?\n/, "");
  const end = rest.search(/\r?\n?<\/flowcode-message>/);
  const body = (end >= 0 ? rest.slice(0, end) : rest.split(/\n\[Flowcode\]/)[0]).replace(/<\\\/(flowcode-message)/gi, "</$1");
  const from = attrs.from ?? "";
  const dot = from.lastIndexOf(" · ");
  const label = dot >= 0 ? from.slice(0, dot) : from;
  const agentName = dot >= 0 ? from.slice(dot + 3).toLowerCase() : "";
  const hops = Number.parseInt(attrs.hops ?? "", 10);
  return {
    msgId: attrs.id || `frame-${label}`,
    text: body,
    from: { label: label || "?", ...(attrs.from_tab ? { tabId: attrs.from_tab } : {}), ...(AGENT_IDS[agentName] ? { agent: AGENT_IDS[agentName] } : {}) },
    hops: Number.isFinite(hops) ? hops : 0,
    state: "delivered",
    ...(attrs.reply_to ? { replyTo: attrs.reply_to } : {}),
  };
}

/** The message is waiting for the user to accept it. */
export const peerPending = (p: Pick<PeerIn, "state">): boolean => p.state === "pending_consent";

/** The hint a terminal card copies or types for the agent (it is for the agent: English). */
export const TERMINAL_READ_HINT = "Read your Flowcode messages with read_messages and handle them.";

/** The first line of a message, for one-line strips. */
export function firstLine(text: string, max = 120): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
