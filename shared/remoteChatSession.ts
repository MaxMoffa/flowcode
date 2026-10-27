// A client's copy of one desktop chat: the conversation model (the desktop's
// own reducer, src/chat/chatModel.ts) plus what only the phone keeps: the raw
// events for plugin views and the messages waiting to be sent. Pure functions,
// so the resume-after-reconnect and queue rules are testable without a link.
import { applyEvent, forceCancels, initialChat, liveModels, normalizeModels, settleChat, type ChatModelState } from "../src/chat/chatModel";
import type { ChatEvent, ChatModels, ChatModes, ChatStatus } from "../src/chat/chatTypes";
import type { ChatInfo } from "./remote-types";

/** Raw events kept per chat for plugin views to replay; the oldest go first. */
export const MAX_RAW_EVENTS = 4000;

/** Conversation items kept per chat; past it the oldest go (a chat left running for days must not grow without end). `lastSeq` is kept apart, so dropping never makes old events look new. */
export const MAX_ITEMS = 5000;

export interface ChatSession {
  model: ChatModelState;
  /** Raw events in `seq` order, newest last, at most MAX_RAW_EVENTS. */
  events: ChatEvent[];
  /** Messages typed while the agent was busy (or the link down), sent one per finished turn. */
  queued: string[];
  /** `lastSeq` when the last message was handed to the agent: until a newer event arrives its turn hasn't started, so the queue must not send another. */
  sentAtSeq: number | null;
  /** The message last handed to the agent, until its `user` event shows it arrived: what a refusal that names no chat (`agent_busy`) puts back. */
  sentText: string | null;
  /** The desktop answered `chatopen` (even with nothing): the conversation shown is complete up to now. */
  loaded: boolean;
}

export const emptySession = (): ChatSession => ({ model: initialChat(), events: [], queued: [], sentAtSeq: null, sentText: null, loaded: false });

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
  if (model.items.length > MAX_ITEMS) model = { ...model, items: model.items.slice(-MAX_ITEMS) };
  // A busy chat replayed whole has no turn start in the events we kept: counting from now is an approximation.
  if (opts.replay) model = opts.busy ? (model.status === "starting" ? { ...model, status: "busy", turnActive: true, turn: model.turn ?? { startedAt: Date.now(), outChars: 0 } } : model) : settleChat(model);
  const events = fresh.length === 0 ? session.events : [...session.events, ...fresh].slice(-MAX_RAW_EVENTS);
  // The sent message's own `user` event (or the agent's end) settles it: nothing left to put back.
  const landed = session.sentText !== null && fresh.some((e) => (e.kind === "user" && e.seq > (session.sentAtSeq ?? -Infinity)) || e.kind === "exit");
  return { ...session, model, events, loaded: session.loaded || opts.replay, sentText: landed ? null : session.sentText };
}

/**
 * Where the conversation stands. The events win when they say the agent is
 * working (they are the freshest: the pushed `chats` list can lag behind a turn
 * that just started, and a queued message sent on its stale "idle" would be
 * refused), the desktop's word for the rest (a turn started elsewhere whose
 * events haven't arrived yet).
 */
export function chatStatus(info: ChatInfo | undefined, model: ChatModelState): ChatStatus {
  if (model.status === "exited" || info?.status === "exited") return "exited";
  if (model.status === "waiting") return "waiting";
  if (model.status === "busy") return info?.status === "waiting" ? "waiting" : "busy";
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
  return { text, session: { ...session, queued: rest, sentAtSeq: session.model.lastSeq, sentText: text } };
}

/** The send never left the phone: back to the front of the queue, as if untouched. */
export function putBack(session: ChatSession, text: string, sentAt: number): ChatSession {
  const mine = session.sentAtSeq === sentAt;
  return { ...session, queued: [text, ...session.queued], sentAtSeq: mine ? null : session.sentAtSeq, sentText: mine ? null : session.sentText };
}

/**
 * The desktop refused the last message (`agent_busy`: a turn was still
 * running): it goes back to the front of the queue and waits for an event
 * newer than now, so it isn't sent again until the agent has moved on. Null
 * when no message is waiting for its `user` event.
 */
export function requeueRefused(session: ChatSession): ChatSession | null {
  if (session.sentText === null) return null;
  return { ...session, queued: [session.sentText, ...session.queued], sentText: null, sentAtSeq: session.model.lastSeq };
}

/** The chat a refusal naming no chat belongs to: the one message still waiting for its `user` event. Null when none or several are (it can't be told). */
export function refusedChat(sessions: Record<string, ChatSession>): string | null {
  const waiting = Object.keys(sessions).filter((id) => sessions[id].sentText !== null);
  return waiting.length === 1 ? waiting[0] : null;
}

/** "Send now": the queued message goes first and the sent-at guard is dropped, so it leaves as soon as the agent is idle (the caller cancels a running turn). */
export function forceQueued(session: ChatSession, index: number): ChatSession {
  if (index < 0 || index >= session.queued.length) return session;
  const queued = [session.queued[index], ...session.queued.filter((_, i) => i !== index)];
  return { ...session, queued, sentAtSeq: null };
}

/** "Send now" also cancels: a turn runs, or the last message is still on its way (sent, its `user` event not seen yet). */
export const forceNeedsCancel = (session: ChatSession, status: ChatStatus): boolean => forceCancels(status, session.sentText !== null);

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

/** The models the desktop announced (already normalized there), checked; the list its events last said and the live model win. Null when there is nothing to choose between. */
export function chatModels(info: ChatInfo | undefined, model: ChatModelState): ChatModels | null {
  return liveModels(model.models !== undefined ? model.models : normalizeModels(info?.models), model.currentModelId);
}
