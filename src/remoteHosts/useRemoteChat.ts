import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { acknowledgePrompt, pauseUnconfirmedPrompt, promptRequestId, applyEvents, canDispatch, chatModels, chatModes, chatThought, chatStatus, emptySession, forceNeedsCancel, forceQueued, putBack, requeueRefused, takeQueued, type ChatSession as RemoteSession } from "../../shared/remoteChatSession";
import { t } from "../i18n";
import { eventsActivity } from "../chat/cacheWarning";
import { applyLocalError, isAgentBusy } from "../chat/chatModel";
import type { ChatSession } from "../chat/useChat";
import { claimBusyRefusal, onHostMessages, sendToHost, setPromptInFlight, useHost, useHostState } from "./remoteHosts";

/** Follows a chat of another PC and hands it to the desktop's agent views as if it ran here: the same
 * `ChatSession` `useChat` gives. The conversation is the remote's own event stream, folded by the
 * phone's reducer (shared/remoteChatSession.ts); messages typed while the agent works are queued here. */
export function useRemoteChat(hostId: string, chatId: string): ChatSession {
  const [session, setSession] = useState<RemoteSession>(emptySession);
  const sessionRef = useRef(session);
  const info = useHostState(hostId).chats.find((c) => c.chatId === chatId);
  const infoRef = useRef(info);
  infoRef.current = info;
  const host = useHost(hostId);
  const online = host?.status === "online";
  // A remote that can't switch models shows no choice.
  const promptReceipts = !!host?.caps.includes("chatPromptAck");
  const canSetModel = !!host?.caps.includes("chatModel");
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // This view among the window's senders to the host: an `agent_busy` refusal names no chat, so it is ours only while our prompt is the window's one in flight (see `claimBusyRefusal`).
  const sender = `${chatId}#${useId()}`;

  /** Changes the session synchronously (the queue is read right after), then renders it. */
  const update = useCallback(
    (fn: (s: RemoteSession) => RemoteSession) => {
      sessionRef.current = fn(sessionRef.current);
      setPromptInFlight(hostId, sender, sessionRef.current.sentText !== null);
      setSession(sessionRef.current);
    },
    [hostId, sender],
  );
  useEffect(() => () => setPromptInFlight(hostId, sender, false), [hostId, sender]);

  /** Hands the next queued message to the agent when it can take one; a send that never left goes back in the queue. */
  const pump = useCallback(() => {
    const s = sessionRef.current;
    if (!onlineRef.current || !canDispatch(s, chatStatus(infoRef.current, s.model))) return;
    const taken = takeQueued(s, promptReceipts ? promptRequestId() : null);
    if (!taken) return;
    const sentAt = taken.session.sentAtSeq ?? -1;
    update(() => taken.session);
    void sendToHost(hostId, { t: "chatprompt", chatId, text: taken.text, ...(taken.session.sentRequestId ? { requestId: taken.session.sentRequestId } : {}) }).then((ok) => {
      if (!ok) update((cur) => putBack(cur, taken.text, taken.files, sentAt, taken.session.deliveryVersion));
    });
  }, [hostId, chatId, update, promptReceipts]);

  // Follow the chat while this view is mounted and the link is up; a new link forgot every stream, so ask again from where we are.
  useEffect(() => {
    if (!online) return;
    // `lastSeq` starts at -1 (nothing seen yet) but the wire field is unsigned: -1 is refused as an invalid message and the chat never loads.
    void sendToHost(hostId, { t: "chatopen", chatId, afterSeq: Math.max(0, sessionRef.current.model.lastSeq) });
    return () => void sendToHost(hostId, { t: "chatclose", chatId });
  }, [hostId, chatId, online]);

  useEffect(
    () =>
      onHostMessages(hostId, (msgs) => {
        for (const m of msgs) {
          if (m.t === "chatpromptack" && m.chatId === chatId) {
            update((s) => acknowledgePrompt(s, m.requestId, m.message));
            continue;
          }
          // The remote refused our prompt because its agent was still working: back to the queue, sent after the turn.
          // Other errors are shown by the window's notice (remoteHosts.ts `onRemoteNotice`), not here.
          if (m.t === "error" && !promptReceipts && isAgentBusy(m.message) && claimBusyRefusal(hostId, sender)) {
            update((s) => requeueRefused(s) ?? s);
            continue;
          }
          if (m.t !== "chatevents" || m.chatId !== chatId) continue;
          const status = infoRef.current?.status;
          const wasUncertain = sessionRef.current.deliveryUncertain;
          update((s) => {
            const next = applyEvents(s, m.events, { replay: m.replay, busy: status === "busy" || status === "waiting" });
            return m.replay && !promptReceipts && next.sentRequestId ? pauseUnconfirmedPrompt(next) : next;
          });
          const pending = sessionRef.current;
          if (m.replay && promptReceipts && pending.sentText !== null && pending.sentRequestId) {
            void sendToHost(hostId, { t: "chatprompt", chatId, text: pending.sentText, requestId: pending.sentRequestId });
          }
          if (pending.deliveryUncertain && !wasUncertain) update((s) => ({ ...s, model: applyLocalError(s.model, t("chat.deliveryUncertain")) }));
        }
        pump();
      }),
    [hostId, chatId, sender, update, pump, promptReceipts],
  );

  // The remote's status changed (a turn ended, the link came back): the queue may be able to move.
  useEffect(pump, [pump, info?.status, online, session.queued.length]);

  const status = chatStatus(info, session.model);
  const model = useMemo(() => (status === session.model.status ? session.model : { ...session.model, status }), [session.model, status]);
  const modes = useMemo(() => chatModes(info, model), [info, model]);
  const models = useMemo(() => (canSetModel ? chatModels(info, model) : null), [canSetModel, info, model]);
  const thought = useMemo(() => chatThought(info, model), [info, model]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      update((s) => ({ ...s, queued: [...s.queued, { text: trimmed, files: [] }] }));
      pump();
    },
    [update, pump],
  );
  const cancel = useCallback(() => void sendToHost(hostId, { t: "chatcancel", chatId }), [hostId, chatId]);
  const answerPermission = useCallback((requestId: string, optionId: string | null) => void sendToHost(hostId, { t: "chatpermission", chatId, requestId, optionId }), [hostId, chatId]);
  const answerAsk = useCallback(
    (requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void sendToHost(hostId, { t: "chatask", chatId, requestId, action, content }),
    [hostId, chatId],
  );
  const setMode = useCallback((modeId: string) => void sendToHost(hostId, { t: "chatmode", chatId, modeId }), [hostId, chatId]);
  /** The remote says the outcome: its `_flowcode/model` event, or a refusal as a host error (shown as the window's notice, see `onRemoteNotice`, not in this chat). A link that refused the message gets a local error here. */
  const setModel = useCallback(
    (modelId: string) =>
      void sendToHost(hostId, { t: "chatmodel", chatId, modelId }).then((ok) => {
        if (!ok) update((s) => ({ ...s, model: applyLocalError(s.model, t("chat.model.failed", { error: t("chat.model.offline") })) }));
      }),
    [hostId, chatId, update],
  );
  /** Like `setModel`: the remote's `_flowcode/thought` event shows the outcome. */
  const setThought = useCallback(
    (value: string) =>
      void sendToHost(hostId, { t: "chatthought", chatId, value }).then((ok) => {
        if (!ok) update((s) => ({ ...s, model: applyLocalError(s.model, t("chat.thought.failed", { error: t("chat.model.offline") })) }));
      }),
    [hostId, chatId, update],
  );
  const unqueue = useCallback((index: number) => update((s) => ({ ...s, queued: s.queued.filter((_, i) => i !== index) })), [update]);
  const force = useCallback(
    (index: number) => {
      const cancels = forceNeedsCancel(sessionRef.current, chatStatus(infoRef.current, sessionRef.current.model));
      update((s) => forceQueued(s, index));
      if (cancels) cancel();
      else pump();
    },
    [update, pump, cancel],
  );
  // The agent runs on the other PC: there is nothing to start again from here.
  const restart = useCallback(() => {}, []);
  // Likewise nothing runs here to close: the remote PC owns the agent.
  const close = useCallback(async () => {}, []);

  const activity = useMemo(() => eventsActivity(session.events), [session.events]);

  return {
    model,
    phase: session.loaded ? "ready" : "starting",
    error: null,
    modes,
    models,
    thought,
    chatId,
    // A remote PC's agent runs on that PC, never in a WSL distro of this one.
    wslDistro: null,
    profileId: null,
    queued: useMemo(() => session.queued.map((q) => ({ text: q.text, attachments: [] })), [session.queued]),
    // The remote protocol carries text only.
    canAttach: false,
    resumed: true,
    loaded: true,
    clearCount: 0,
    sessionId: info?.sessionId,
    lastActivityAt: activity.at,
    usageTokens: activity.tokens,
    send,
    cancel,
    answerPermission,
    answerAsk,
    setMode,
    setModel,
    setThought,
    unqueue,
    force,
    restart,
    close,
  };
}
