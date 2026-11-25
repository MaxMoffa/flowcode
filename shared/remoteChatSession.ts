// A client's copy of one desktop chat: the conversation model (the desktop's
// own reducer, src/chat/chatModel.ts) plus what only the phone keeps: the raw
// events for plugin views and the messages waiting to be sent. Pure functions,
// so the resume-after-reconnect and queue rules are testable without a link.
import { applyEvents as applyModelEvents, applyLocalError, isAgentBusy, isAgentExited, forceCancels, initialChat, liveModels, liveThought, normalizeModels, normalizeThought, settleChat, type ChatModelState } from "../src/chat/chatModel";
import type { ChatEvent, ChatModels, ChatModes, ChatStatus, ChatThought } from "../src/chat/chatTypes";
import { NO_ACTIVITY, trackActivity, type ChatActivity } from "../src/chat/cacheWarning";
import type { ChatAttachmentRef, ChatInfo } from "./remote-types";

/** A message waiting to be sent: its text and the files already uploaded for it. */
type QueuedPrompt = { text: string; files: ChatAttachmentRef[] };

/** Raw events kept per chat for plugin views to replay; the oldest go first. */
export const MAX_RAW_EVENTS = 4000;

/** Conversation items kept per chat; past it the oldest go (a chat left running for days must not grow without end). `lastSeq` is kept apart, so dropping never makes old events look new. */
export const MAX_ITEMS = 5000;

export interface ChatSession {
  model: ChatModelState;
  /** Raw events in `seq` order, newest last, at most MAX_RAW_EVENTS. */
  events: ChatEvent[];
  /** Last activity time + context size, folded per batch: no pass over `events` on every render. */
  activity: ChatActivity;
  /** Messages typed while the agent was busy (or the link down), sent one per finished turn. */
  queued: QueuedPrompt[];
  /** `lastSeq` when the last message was handed to the agent: until a newer event arrives its turn hasn't started, so the queue must not send another. */
  sentAtSeq: number | null;
  /** The message last handed to the agent, until its `user` event shows it arrived: what a refusal that names no chat (`agent_busy`) puts back. */
  sentText: string | null;
  /** The files of `sentText`, kept and cleared with it. */
  sentFiles: ChatAttachmentRef[];
  /** Stable across reconnects until the server acknowledges this delivery. */
  sentRequestId: string | null;
  /** An old server cannot prove delivery: keep the text visible for manual retry. */
  deliveryUncertain: boolean;
  /** Local attempt identity, including sends to legacy servers. */
  deliveryVersion: number;
  /** The desktop answered `chatopen` (even with nothing): the conversation shown is complete up to now. */
  loaded: boolean;
  /** Older events of the log than the ones held: the desktop sent only its newest page (`chatPaging`). `firstSeq` is the `beforeSeq` of the next request; `loading` while one is out. */
  older: { has: boolean; firstSeq: number; loading: boolean };
}

export const emptySession = (): ChatSession => ({ model: initialChat(), events: [], activity: NO_ACTIVITY, queued: [], sentAtSeq: null, sentText: null, sentFiles: [], sentRequestId: null, deliveryUncertain: false, deliveryVersion: 0, loaded: false, older: { has: false, firstSeq: 0, loading: false } });

export const promptRequestId = () => `${Date.now()}-${crypto.randomUUID()}`;

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
export function applyEvents(session: ChatSession, raw: unknown[], opts: { replay: boolean; busy: boolean; page?: { hasMore: boolean; firstSeq: number } }): ChatSession {
  const fresh = freshEvents(session, raw);
  let model = applyModelEvents(session.model, fresh);
  if (model.items.length > MAX_ITEMS) model = { ...model, items: model.items.slice(-MAX_ITEMS) };
  // A busy chat replayed whole has no turn start in the events we kept: counting from now is an approximation.
  if (opts.replay) model = opts.busy ? (model.status === "starting" ? { ...model, status: "busy", turnActive: true, turn: model.turn ?? { startedAt: Date.now(), outChars: 0 } } : model) : settleChat(model);
  // One copy per batch (concat), a second only when over the cap. The identity must change: ChatScreen memoises on it, so in-place push is not an option.
  const events = fresh.length === 0 ? session.events : (() => {
    const all = session.events.concat(fresh);
    return all.length > MAX_RAW_EVENTS ? all.slice(-MAX_RAW_EVENTS) : all;
  })();
  // The sent message's own `user` event (or the agent's end) settles it: nothing left to put back.
  const landed = session.sentRequestId === null && session.sentText !== null && fresh.some((e) => (e.kind === "user" && e.text === session.sentText && e.seq > (session.sentAtSeq ?? -Infinity)) || e.kind === "exit");
  // The replay of a paged open says whether older events exist (a delta replay says nothing: what is known stays).
  const older = opts.replay && opts.page ? { has: opts.page.hasMore, firstSeq: opts.page.firstSeq, loading: false } : session.older;
  const activity = fresh.length === 0 ? session.activity : fresh.reduce(trackActivity, session.activity);
  const next = { ...session, model, events, activity, older, loaded: session.loaded || opts.replay, sentText: landed ? null : session.sentText, sentFiles: landed ? [] : session.sentFiles };
  if (opts.replay && next.sentText !== null && next.sentRequestId === null) {
    return { ...next, queued: [{ text: next.sentText, files: next.sentFiles }, ...next.queued], sentText: null, sentFiles: [], sentAtSeq: null, deliveryUncertain: true };
  }
  return next;
}

/**
 * Puts an older page (the answer to `chatolder`) in front of the conversation.
 * It is folded alone (a page starts at a user turn, so nothing in it waits for
 * an event of the newer ones); an item the session already has keeps its newer
 * state. Raw events go in front too, within MAX_RAW_EVENTS.
 */
export function prependOlder(session: ChatSession, raw: unknown[], page: { hasMore: boolean; firstSeq: number }): ChatSession {
  const events = raw.filter(isChatEvent).sort((a, b) => a.seq - b.seq);
  // A page that brought nothing ends the paging: asking again would loop.
  const older = { has: page.hasMore && events.length > 0, firstSeq: events.length > 0 ? page.firstSeq : session.older.firstSeq, loading: false };
  if (events.length === 0) return { ...session, older };
  const items = settleChat(applyModelEvents(initialChat(), events)).items;
  const known = new Set(session.model.items.map((i) => i.id));
  const fresh = items.filter((i) => !known.has(i.id));
  const held = new Set(session.events.map((e) => e.seq));
  const rawOlder = events.filter((e) => !held.has(e.seq));
  return {
    ...session,
    model: fresh.length === 0 ? session.model : { ...session.model, items: [...fresh, ...session.model.items] },
    events: rawOlder.length === 0 ? session.events : [...rawOlder, ...session.events].slice(-MAX_RAW_EVENTS),
    older,
  };
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
  if (status !== "idle" || session.queued.length === 0 || session.sentText !== null || session.deliveryUncertain) return false;
  return session.sentAtSeq === null || session.model.lastSeq > session.sentAtSeq;
}

/** Takes the next queued message out; the caller sends it. */
export function takeQueued(session: ChatSession, requestId: string | null = null): { session: ChatSession; text: string; files: ChatAttachmentRef[] } | null {
  const [first, ...rest] = session.queued;
  if (first === undefined) return null;
  const { text, files } = first;
  return { text, files, session: { ...session, queued: rest, sentAtSeq: session.model.lastSeq, sentText: text, sentFiles: files, sentRequestId: requestId, deliveryVersion: session.deliveryVersion + 1 } };
}

/** The send never left the phone: back to the front of the queue, as if untouched. */
export function putBack(session: ChatSession, text: string, files: ChatAttachmentRef[], sentAt: number, version = session.deliveryVersion): ChatSession {
  const mine = session.sentAtSeq === sentAt;
  if (!mine || session.sentText !== text || session.deliveryVersion !== version) return session;
  return { ...session, queued: [{ text, files }, ...session.queued], sentAtSeq: null, sentText: null, sentFiles: [], sentRequestId: null };
}

/**
 * The desktop refused the last message (`agent_busy`: a turn was still
 * running): it goes back to the front of the queue and waits for an event
 * newer than now, so it isn't sent again until the agent has moved on. Null
 * when no message is waiting for its `user` event.
 */
export function requeueRefused(session: ChatSession): ChatSession | null {
  if (session.sentText === null) return null;
  return { ...session, queued: [{ text: session.sentText, files: session.sentFiles }, ...session.queued], sentText: null, sentFiles: [], sentRequestId: null, sentAtSeq: session.sentAtSeq ?? session.model.lastSeq };
}

/** Correlated replies never consume another chat's pending text. */
export function acknowledgePrompt(session: ChatSession, requestId: string, message?: string): ChatSession {
  if (session.sentRequestId !== requestId) return session;
  if (!message) return { ...session, sentText: null, sentFiles: [], sentRequestId: null };
  const next = requeueRefused(session) ?? session;
  const retryAfterTurn = isAgentBusy(message) || isAgentExited(message);
  return { ...next, deliveryUncertain: !retryAfterTurn, model: retryAfterTurn ? next.model : applyLocalError(next.model, message) };
}

export function pauseUnconfirmedPrompt(session: ChatSession): ChatSession {
  if (session.sentText === null) return session;
  return { ...session, queued: [{ text: session.sentText, files: session.sentFiles }, ...session.queued], sentText: null, sentFiles: [], sentRequestId: null, sentAtSeq: null, deliveryUncertain: true };
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
  return { ...session, queued, sentAtSeq: null, deliveryUncertain: false };
}

/** "Send now" also cancels: a turn runs, or the last message is still on its way (sent, its `user` event not seen yet). */
export const forceNeedsCancel = (session: ChatSession, status: ChatStatus): boolean => forceCancels(status, session.sentText !== null);

/** The permission request waiting for an answer, oldest first. */
export function pendingPermissions(model: ChatModelState) {
  return model.items.flatMap((i) => (i.type === "permission" && i.resolved === undefined ? [i] : []));
}

/** The questions (AskUserQuestion) waiting for an answer, oldest first. */
export function pendingAsks(model: ChatModelState) {
  return model.items.flatMap((i) => (i.type === "ask" && i.resolved === undefined ? [i] : []));
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

/** The thinking levels the desktop announced, checked; the list its events last said wins. Null when there is nothing to choose between. */
export function chatThought(info: ChatInfo | undefined, model: ChatModelState): ChatThought | null {
  return liveThought(model.thought !== undefined ? model.thought : normalizeThought(info?.thought));
}
