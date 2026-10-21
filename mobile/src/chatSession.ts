// The phone's copy of one desktop chat: the conversation model (the desktop's
// own reducer, src/chat/chatModel.ts) plus what only the phone keeps: the raw
// events for plugin views and the messages waiting to be sent. Pure functions,
// so the resume-after-reconnect and queue rules are testable without a link.
import { applyEvent, initialChat, settleChat, type ChatModelState } from "../../src/chat/chatModel";
import type { ChatEvent, ChatModes, ChatStatus } from "../../src/chat/chatTypes";
import type { ChatInfo } from "../../shared/remote-types";

/** Raw events kept per chat for plugin views to replay; the oldest go first. */
export const MAX_RAW_EVENTS = 4000;

export interface ChatSession {
  model: ChatModelState;
  /** Raw events in `seq` order, newest last, at most MAX_RAW_EVENTS. */
  events: ChatEvent[];
  /** Messages typed while the agent was busy (or the link down), sent one per finished turn. */
  queued: string[];
  /** `lastSeq` when the last message was handed to the agent: until a newer event arrives its turn hasn't started, so the queue must not send another. */
  sentAtSeq: number | null;
  /** The desktop answered `chatopen` (even with nothing): the conversation shown is complete up to now. */
  loaded: boolean;
}

export const emptySession = (): ChatSession => ({ model: initialChat(), events: [], queued: [], sentAtSeq: null, loaded: false });

function isChatEvent(v: unknown): v is ChatEvent {
  return typeof v === "object" && v !== null && typeof (v as ChatEvent).seq === "number" && typeof (v as ChatEvent).kind === "string";
}

/** The events of a batch the session hasn't seen, in `seq` order. */
export function freshEvents(session: ChatSession, raw: unknown[]): ChatEvent[] {
  return raw.filter(isChatEvent).filter((e) => e.seq > session.model.lastSeq).sort((a, b) => a.seq - b.seq);
}

/**
 * Folds a `chatevents` batch into the session. Events at or below `lastSeq`
 * are dropped, so a replay overlapping what the phone already has (a
 * reconnect asks for `afterSeq = lastSeq`, but a live batch may be in flight)
 * never duplicates anything. A replay ends the "starting" state: settled when
 * the agent isn't working (a resumed session's history reads like a turn in
 * progress), busy when it is.
 */
export function applyEvents(session: ChatSession, raw: unknown[], opts: { replay: boolean; busy: boolean }): ChatSession {
  const fresh = freshEvents(session, raw);
  let model = fresh.reduce(applyEvent, session.model);
  if (opts.replay) model = opts.busy ? (model.status === "starting" ? { ...model, status: "busy", turnActive: true } : model) : settleChat(model);
  const events = fresh.length === 0 ? session.events : [...session.events, ...fresh].slice(-MAX_RAW_EVENTS);
  return { ...session, model, events, loaded: session.loaded || opts.replay };
}

/** Where the conversation stands: the events win for "waiting" (they are the freshest), the desktop's word for the rest. */
export function chatStatus(info: ChatInfo | undefined, model: ChatModelState): ChatStatus {
  if (model.status === "exited" || info?.status === "exited") return "exited";
  if (model.status === "waiting") return "waiting";
  return info?.status ?? model.status;
}

/** The agent can take a message now: idle, and the last one sent has started its turn. */
export function canDispatch(session: ChatSession, status: ChatStatus): boolean {
  if (status !== "idle" || session.queued.length === 0) return false;
  return session.sentAtSeq === null || session.model.lastSeq > session.sentAtSeq;
}

/** Takes the next queued message out; the caller sends it. */
export function takeQueued(session: ChatSession): { session: ChatSession; text: string } | null {
  const [text, ...rest] = session.queued;
  if (text === undefined) return null;
  return { text, session: { ...session, queued: rest, sentAtSeq: session.model.lastSeq } };
}

/** The send never left the phone: back to the front of the queue, as if untouched. */
export function putBack(session: ChatSession, text: string, sentAt: number): ChatSession {
  return { ...session, queued: [text, ...session.queued], sentAtSeq: session.sentAtSeq === sentAt ? null : session.sentAtSeq };
}

/** The permission request waiting for an answer, oldest first. */
export function pendingPermissions(model: ChatModelState) {
  return model.items.flatMap((i) => (i.type === "permission" && i.resolved === undefined ? [i] : []));
}

/** The ACP `modes` the desktop announced, checked; the live mode (from events) wins over the announced one. */
export function chatModes(info: ChatInfo | undefined, model: ChatModelState): ChatModes | null {
  const m = info?.modes as Partial<ChatModes> | null | undefined;
  if (!m || !Array.isArray(m.availableModes) || m.availableModes.length === 0) return null;
  const availableModes = m.availableModes.filter((x) => x && typeof x.id === "string" && typeof x.name === "string");
  if (availableModes.length === 0) return null;
  return { currentModeId: model.currentModeId ?? m.currentModeId ?? availableModes[0].id, availableModes };
}
