// The phone's side of the desktop's chat tabs: which chats it follows, their
// conversations (see chatSession.ts), and the messages it sends. The chat
// list itself lives in the remote store beside `tabs`.
//
// Following is what keeps the traffic small: the desktop streams a chat's
// events only after `chatopen`, so the phone opens the chats a screen is
// showing (or that wait for a permission, so the list can say what is asked)
// and closes them again. Every connection starts from nothing, so after each
// `ready` the open chats are asked again from the last event the phone has
// (`afterSeq = lastSeq`): a reconnect, a resume from the background or a
// dropped link all end with just the missing delta, never a duplicate.
import { useCallback, useEffect, useRef } from "react";
import type { ChatEvent } from "../../src/chat/chatTypes";
import type { Tab } from "./remote";
import { isAgentBusy } from "../../src/chat/chatModel";
import { applyEvents, canDispatch, chatStatus, emptySession, forceNeedsCancel, forceQueued, freshEvents, pendingPermissions, putBack, refusedChat, requeueRefused, takeQueued, type ChatSession } from "./chatSession";
import { t } from "./i18n";
import { currentChats, onMessage, send, sendChecked, showToast, useRemoteSelector } from "./remote";
import type { ChatInfo, ServerMsg } from "../../shared/remote-types";
import { beginPending, endPending } from "./pending";
import { createStore } from "./store";

interface ChatsSnapshot {
  /** The conversation of every chat the phone has followed, by chat id. */
  sessions: Record<string, ChatSession>;
  /** A chat a screen far from App's state asked to show, until App has opened it. */
  openRequest: string | null;
}

const store = createStore<ChatsSnapshot>({ sessions: {}, openRequest: null });

/** How long a requested chat or a handoff is waited for before giving up: a chat
 * starts its agent's adapter and replays the session first, which takes a while. */
const WAIT_MS = 45_000;

/** Screens showing each chat; a chat with any is followed. */
const refs = new Map<string, number>();
/** Chats `chatopen` was sent for on this connection. */
const opened = new Set<string>();
/** A connection said `ready` but its `chats` haven't arrived: nothing is opened against a stale list. */
let awaitingChats = true;
/** The desktop the sessions belong to. */
let lastHost: string | undefined;
/** The agent session each chat ran when last seen: a different one means the history started over. */
const sessionIds = new Map<string, string>();
const eventListeners = new Map<string, Set<(event: ChatEvent) => void>>();

const infoOf = (chatId: string): ChatInfo | undefined => currentChats()?.find((c) => c.chatId === chatId);

function patchSession(chatId: string, change: (s: ChatSession) => ChatSession) {
  const { sessions } = store.get();
  store.set({ sessions: { ...sessions, [chatId]: change(sessions[chatId] ?? emptySession()) } });
}

/** Opens the chats that should stream and closes the rest; a no-op until the list of this connection is known. */
function syncFollows() {
  const chats = currentChats();
  if (!chats || awaitingChats) return;
  const known = new Set(chats.map((c) => c.chatId));
  const { sessions } = store.get();
  // A chat with messages still to send (or one sent, not yet seen arriving) stays followed after its screen closes: the queue moves on its events, not on the pushed status alone.
  const pendingSend = (id: string) => {
    const s = sessions[id];
    return !!s && (s.queued.length > 0 || s.sentText !== null);
  };
  const wanted = new Set(chats.filter((c) => (refs.get(c.chatId) ?? 0) > 0 || c.status === "waiting" || pendingSend(c.chatId)).map((c) => c.chatId));
  for (const chatId of wanted) {
    if (opened.has(chatId)) continue;
    opened.add(chatId);
    const lastSeq = store.get().sessions[chatId]?.model.lastSeq ?? 0;
    send({ t: "chatopen", chatId, afterSeq: Math.max(0, lastSeq) });
  }
  for (const chatId of [...opened]) {
    if (wanted.has(chatId)) continue;
    opened.delete(chatId);
    if (known.has(chatId)) send({ t: "chatclose", chatId });
  }
}

/** Follows a chat while a screen shows it; returns the stop function. */
export function followChat(chatId: string): () => void {
  refs.set(chatId, (refs.get(chatId) ?? 0) + 1);
  syncFollows();
  return () => {
    const n = (refs.get(chatId) ?? 1) - 1;
    if (n > 0) refs.set(chatId, n);
    else refs.delete(chatId);
    syncFollows();
  };
}

/** Follows `chatId` for as long as the calling screen shows it. */
export function useFollowChat(chatId: string) {
  useEffect(() => followChat(chatId), [chatId]);
}

/** Hands the next queued message to the agent when it can take one; a send that never left the phone goes back in the queue. */
function pump(chatId: string) {
  const session = store.get().sessions[chatId];
  if (!session || !canDispatch(session, chatStatus(infoOf(chatId), session.model))) return;
  const taken = takeQueued(session);
  if (!taken) return;
  const sentAt = taken.session.sentAtSeq ?? -1;
  patchSession(chatId, () => taken.session);
  void sendChecked({ t: "chatprompt", chatId, text: taken.text }).then((ok) => {
    if (!ok) patchSession(chatId, (s) => putBack(s, taken.text, sentAt));
  });
}

const pumpAll = () => Object.keys(store.get().sessions).forEach(pump);

function onChatEvents(chatId: string, events: unknown[], replay: boolean) {
  const before = store.get().sessions[chatId] ?? emptySession();
  const fresh = freshEvents(before, events);
  const status = infoOf(chatId)?.status;
  patchSession(chatId, () => applyEvents(before, events, { replay, busy: status === "busy" || status === "waiting" }));
  const listeners = eventListeners.get(chatId);
  if (listeners) for (const event of fresh) listeners.forEach((l) => l(event));
  pump(chatId);
  // The sent message may have arrived, or the queue emptied: a chat kept followed for them can be let go.
  syncFollows();
}

/** The desktop refused a prompt as `agent_busy` (its error names no chat): the message in flight goes back to the front of its queue, sent again once the turn is over. */
function onRefusedBusy() {
  const chatId = refusedChat(store.get().sessions);
  const back = chatId ? requeueRefused(store.get().sessions[chatId]) : null;
  if (!chatId || !back) {
    showToast(t("chatBusyRefused"));
    return;
  }
  patchSession(chatId, () => back);
}

function onChatList(chats: ChatInfo[]) {
  awaitingChats = false;
  const live = new Set(chats.map((c) => c.chatId));
  const { sessions } = store.get();
  const kept: Record<string, ChatSession> = {};
  for (const chat of chats) {
    // The agent started a new session under the same chat: its history began again, so start over from the first event.
    const prev = sessionIds.get(chat.chatId);
    if (chat.sessionId && prev && prev !== chat.sessionId) opened.delete(chat.chatId);
    else if (sessions[chat.chatId]) kept[chat.chatId] = sessions[chat.chatId];
    if (chat.sessionId) sessionIds.set(chat.chatId, chat.sessionId);
  }
  for (const id of Object.keys(sessions)) if (!live.has(id) && (refs.get(id) ?? 0) > 0) kept[id] = sessions[id];
  for (const id of [...sessionIds.keys()]) if (!live.has(id)) sessionIds.delete(id);
  store.set({ sessions: kept });
  syncFollows();
  pumpAll();
}

function onChatMsg(m: ServerMsg) {
  switch (m.t) {
    case "ready":
      opened.clear();
      awaitingChats = true;
      if (m.hostName !== lastHost) {
        lastHost = m.hostName;
        sessionIds.clear();
        store.set({ sessions: {} });
      }
      break;
    case "chats":
      onChatList(m.chats);
      break;
    case "chatevents":
      onChatEvents(m.chatId, m.events, m.replay);
      break;
    case "error":
      if (isAgentBusy(m.message)) onRefusedBusy();
      break;
  }
}

onMessage(onChatMsg);

export const useChatSession = (chatId: string): ChatSession | undefined => store.useSelector((s) => s.sessions[chatId]);
export const useChatInfo = (chatId: string | null): ChatInfo | undefined => useRemoteSelector((s) => (chatId ? s.chats?.find((c) => c.chatId === chatId) : undefined));

/** A chat's conversation right now, for code outside React. */
export const getChatSession = (chatId: string): ChatSession | undefined => store.get().sessions[chatId];

/** Every event received so far, for a plugin view's replay. */
export const rawChatEvents = (chatId: string): ChatEvent[] => store.get().sessions[chatId]?.events ?? [];

/** New events as they arrive; the caller replays `rawChatEvents` and drops what it already has by `seq`. */
export function onNewChatEvents(chatId: string, listener: (event: ChatEvent) => void): () => void {
  let set = eventListeners.get(chatId);
  if (!set) eventListeners.set(chatId, (set = new Set()));
  set.add(listener);
  return () => void eventListeners.get(chatId)?.delete(listener);
}

/** Queues a message; it goes out as soon as the agent is idle and the link up. */
export function sendChatPrompt(chatId: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return;
  patchSession(chatId, (s) => ({ ...s, queued: [...s.queued, trimmed] }));
  pump(chatId);
  syncFollows();
}

export function unqueueChatPrompt(chatId: string, index: number) {
  patchSession(chatId, (s) => ({ ...s, queued: s.queued.filter((_, i) => i !== index) }));
  syncFollows();
}
/** "Send now": the message goes first and a running turn (or the message still on its way) is cancelled, so it leaves as soon as the agent is idle. */
export function forceChatPrompt(chatId: string, index: number) {
  const session = store.get().sessions[chatId];
  if (!session) return;
  patchSession(chatId, (s) => forceQueued(s, index));
  if (forceNeedsCancel(session, chatStatus(infoOf(chatId), session.model))) cancelChat(chatId);
  else pump(chatId);
}

export const cancelChat = (chatId: string) => send({ t: "chatcancel", chatId });
/** Answers a permission request; false when the link refused it, so the caller can offer the buttons again. */
export const answerChatPermission = (chatId: string, requestId: string, optionId: string | null): Promise<boolean> => sendChecked({ t: "chatpermission", chatId, requestId, optionId });
export const setChatMode = (chatId: string, modeId: string) => send({ t: "chatmode", chatId, modeId });
/** Switches the chat's model; the desktop's `_flowcode/model` event shows it, a refusal arrives as an error toast. */
export function setChatModel(chatId: string, modelId: string) {
  void sendChecked({ t: "chatmodel", chatId, modelId }).then((ok) => {
    if (!ok) showToast(t("chatModelSendFailed"));
  });
}
/** Switches the chat's thinking level; the desktop's `_flowcode/thought` event shows it, a refusal arrives as an error toast. */
export function setChatThought(chatId: string, value: string) {
  void sendChecked({ t: "chatthought", chatId, value }).then((ok) => {
    if (!ok) showToast(t("chatThoughtSendFailed"));
  });
}
/** How long after a `/clear` the chat's tab may show up under a new chat id. */
const CLEAR_WAIT_MS = 10000;
let clearing: { tabId: string; until: number } | null = null;

/** The tab being cleared right now, if any: the chat that left its list may be coming back under a new id. */
export const recentClearTab = (): string | null => (clearing && Date.now() < clearing.until ? clearing.tabId : null);

/** `/clear`: the desktop starts a fresh conversation in the chat's tab; the chat comes back under a new id (App follows the tab). */
export function clearChat(chatId: string) {
  const tabId = infoOf(chatId)?.tabId;
  if (tabId) clearing = { tabId, until: Date.now() + CLEAR_WAIT_MS };
  void sendChecked({ t: "chatclear", chatId }).then((ok) => {
    if (!ok) showToast(t("chatClearSendFailed"));
  });
}
export const renameChat =(chatId: string, label: string) => send({ t: "chatrename", chatId, label });
/** Asks the desktop to turn the chat's session into a terminal tab. */
const chatToTerminal = (chatId: string) => send({ t: "chatterminal", chatId });

/** The first permission the agent is waiting on in a followed chat, if any: what a list row can say about it. */
export const pendingPermissionTitle = (session: ChatSession | undefined, info?: ChatInfo): string | undefined => {
  // An agent that is gone asks nothing any more, even before its `exit` event marked the requests cancelled.
  if (!session || chatStatus(info, session.model) === "exited") return undefined;
  const first = pendingPermissions(session.model)[0];
  return first ? (first.toolCall.title ?? first.toolCall.kind) : undefined;
};

/** The view each chat was last shown with, so leaving a chat and coming back keeps a plugin view. */
export const lastChatViews = new Map<string, string>();

/** A list far from App (a drawer, a row) asks for a chat; App opens it. */
export const requestOpenChat = (chatId: string) => store.set({ openRequest: chatId });
export const clearOpenRequest = () => store.set({ openRequest: null });
export const useOpenRequest = (): string | null => store.useSelector((s) => s.openRequest);

/** A requested chat opens as soon as the desktop lists it; returns the `onCreate` callback for NewTerminalSheet. */
export function useOpenNewChat(chats: ChatInfo[] | null, onOpen: (chatId: string) => void): () => void {
  /** The chats known when asking, and until when to wait. */
  const pendingRef = useRef<{ known: Set<string>; until: number } | null>(null);

  useEffect(() => {
    const p = pendingRef.current;
    if (!p || !chats) return;
    if (Date.now() > p.until) {
      pendingRef.current = null;
      return;
    }
    const fresh = chats.find((c) => !p.known.has(c.chatId));
    if (fresh) {
      pendingRef.current = null;
      endPending();
      onOpen(fresh.chatId);
    }
  }, [chats, onOpen]);

  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  return useCallback(() => {
    pendingRef.current = { known: new Set((chatsRef.current ?? []).map((c) => c.chatId)), until: Date.now() + WAIT_MS };
  }, []);
}

/**
 * After asking the desktop to turn a chat into a terminal: opens that
 * terminal once the tab list has it (the chat's tab keeps its id, else any
 * new terminal). The chat leaves the list first, so App must be the one asking.
 */
export function useChatHandoff(tabs: Tab[] | null, onOpen: (ptyId: string) => void): (chat: ChatInfo) => void {
  const pendingRef = useRef<{ tabId: string; known: Set<string>; until: number } | null>(null);

  useEffect(() => {
    const p = pendingRef.current;
    if (!p || !tabs) return;
    if (Date.now() > p.until) {
      pendingRef.current = null;
      return;
    }
    const target = tabs.find((x) => x.tabId === p.tabId) ?? tabs.find((x) => !p.known.has(x.ptyId));
    if (target) {
      pendingRef.current = null;
      endPending();
      onOpen(target.ptyId);
    }
  }, [tabs, onOpen]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  return useCallback((chat: ChatInfo) => {
    pendingRef.current = { tabId: chat.tabId, known: new Set((tabsRef.current ?? []).map((x) => x.ptyId)), until: Date.now() + WAIT_MS };
    beginPending({ kind: "toTerminal", label: "" }, WAIT_MS);
    chatToTerminal(chat.chatId);
  }, []);
}

/**
 * After asking the desktop to turn a terminal's agent into a chat: the desktop
 * closes the terminal tab and opens a chat resuming its session. Opens that
 * chat, shown with `view`, once the chat list has it.
 */
export function useTerminalHandoff(chats: ChatInfo[] | null, onOpen: (chatId: string) => void): (ptyId: string, view: string) => void {
  const pendingRef = useRef<{ known: Set<string>; view: string; until: number } | null>(null);

  useEffect(() => {
    const p = pendingRef.current;
    if (!p || !chats) return;
    if (Date.now() > p.until) {
      pendingRef.current = null;
      return;
    }
    const fresh = chats.find((c) => !p.known.has(c.chatId));
    if (fresh) {
      pendingRef.current = null;
      endPending();
      lastChatViews.set(fresh.chatId, p.view);
      onOpen(fresh.chatId);
    }
  }, [chats, onOpen]);

  const chatsRef = useRef(chats);
  chatsRef.current = chats;
  return useCallback((ptyId: string, view: string) => {
    pendingRef.current = { known: new Set((chatsRef.current ?? []).map((c) => c.chatId)), view, until: Date.now() + WAIT_MS };
    beginPending({ kind: "toChat", label: "" }, WAIT_MS);
    send({ t: "terminalchat", ptyId });
  }, []);
}
