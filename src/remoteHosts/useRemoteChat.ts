import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { acknowledgePrompt, pauseUnconfirmedPrompt, promptRequestId, applyEvents, canDispatch, prependOlder, chatModels, chatModes, chatThought, chatStatus, emptySession, forceNeedsCancel, forceQueued, putBack, requeueRefused, takeQueued, type ChatSession as RemoteSession } from "../../shared/remoteChatSession";
import { t } from "../i18n";
import { eventsActivity } from "../chat/cacheWarning";
import { forgetCacheWarning } from "../chat/useCacheWarning";
import { applyLocalError, isAgentBusy } from "../chat/chatModel";
import type { ChatSession } from "../chat/useChat";
import { invoke } from "@tauri-apps/api/core";
import type { ChatAttachment, ChatEvent } from "../chat/chatTypes";
import { discardAttachment } from "../chat/attachmentRelease";
import { queuedAttachments, takeStaged, type StagedFiles } from "./queuedFiles";
import type { ChatAttachmentRef } from "../../shared/remote-types";
import { createAgentOpenTracker, routeAgentOpen } from "../browser/agentOpen";
import { agentCallOf } from "../../shared/agentOpen";
import { addCall } from "../calls/callStore";
import { useChatCalls } from "../calls/useChatCalls";
import { cliName, type AgentCli } from "../agents/cliInfo";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { loopbackPort, tunnelUrl } from "./remoteTunnel";
import { cancelExpectedTab, chatLike, claimBusyRefusal, expectNewTab, onHostMessages, remoteCallTabId, sendToHost, setPromptInFlight, useHost, useHostState } from "./remoteHosts";

/** Follows a chat of another PC and hands it to the desktop's agent views as if it ran here: the same
 * `ChatSession` `useChat` gives. The conversation is the remote's own event stream, folded by the
 * phone's reducer (shared/remoteChatSession.ts); messages typed while the agent works are queued here. */
export function useRemoteChat(hostId: string, chatId: string): ChatSession {
  const [session, setSession] = useState<RemoteSession>(emptySession);
  const sessionRef = useRef(session);
  // The composer's copies of the files of queued messages, by the id the other PC stored them under (see queuedFiles).
  const stagedRef = useRef<StagedFiles>(new Map());
  useEffect(() => {
    const staged = stagedRef.current;
    return () => {
      staged.forEach(discardAttachment);
      staged.clear();
    };
  }, []);
  const info = useHostState(hostId).chats.find((c) => c.chatId === chatId);
  const infoRef = useRef(info);
  infoRef.current = info;
  const host = useHost(hostId);
  const online = host?.status === "online";
  // A remote that can't switch models shows no choice.
  const promptReceipts = !!host?.caps.includes("chatPromptAck");
  const canSetModel = !!host?.caps.includes("chatModel");
  // A remote that pages its log sends only the newest page; older ones come on request.
  const chatPaging = !!host?.caps.includes("chatPaging");
  const pagingRef = useRef(chatPaging);
  pagingRef.current = chatPaging;
  // Chunks of a split replay (or older page) wait for the last one and are folded as one batch.
  const replayBuf = useRef<unknown[]>([]);
  const olderBuf = useRef<unknown[]>([]);
  // The chat's agent started a new session under the same chat (a `/clear` over there): its history began again.
  const [generation, setGeneration] = useState(0);
  const [clearCount, setClearCount] = useState(0);
  const sessionKey = info?.sessionId;
  const seenSession = useRef(sessionKey);
  const onlineRef = useRef(online);
  onlineRef.current = online;
  // This view among the window's senders to the host: an `agent_busy` refusal names no chat, so it is ours only while our prompt is the window's one in flight (see `claimBusyRefusal`).
  const sender = `${chatId}#${useId()}`;
  // What the agent opens (a page, its dev server) lands in this PC's Browser panel, its localhost addresses through a tunnel.
  const confirmOpen = useConfirmDialog();
  const confirmOpenRef = useRef(confirmOpen);
  confirmOpenRef.current = confirmOpen;
  const infoCwdForOpen = info?.cwd ?? "";
  const trackOpen = useMemo(() => createAgentOpenTracker(infoCwdForOpen), [infoCwdForOpen]);
  const trackOpenRef = useRef(trackOpen);
  trackOpenRef.current = trackOpen;
  // The bubble that calls the user from this chat's tab in the strip (see CallBubble): `call_user`, permissions and questions.
  const callTab = remoteCallTabId(hostId, `chat:${chatId}`);
  const callInfoRef = useRef({ agent: info?.agent, label: info?.label });
  callInfoRef.current = { agent: info?.agent, label: info?.label };

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
    void sendToHost(hostId, { t: "chatprompt", chatId, text: taken.text, ...(taken.files.length > 0 ? { attachments: taken.files } : {}), ...(taken.session.sentRequestId ? { requestId: taken.session.sentRequestId } : {}) }).then((ok) => {
      if (!ok) update((cur) => putBack(cur, taken.text, taken.files, sentAt, taken.session.deliveryVersion));
      // Out of the queue for good: its files are on the other PC, the staged copies are not needed.
      else takeStaged(stagedRef.current, taken.files).forEach(discardAttachment);
    });
  }, [hostId, chatId, update, promptReceipts]);

  useEffect(() => {
    const prev = seenSession.current;
    seenSession.current = sessionKey;
    if (!sessionKey || !prev || prev === sessionKey) return;
    replayBuf.current = [];
    olderBuf.current = [];
    forgetCacheWarning(chatId);
    // The agent replaced its session in place: no new tab is coming for the /clear that did it.
    cancelExpectedTab(hostId, chatId);
    // Nothing of the old history applies, but a message still on its way must not vanish: it queues again in the fresh session.
    update((old) => {
      const inFlight = old.sentText !== null ? [{ text: old.sentText, files: old.sentFiles }] : [];
      return { ...emptySession(), queued: [...inFlight, ...old.queued], deliveryVersion: old.deliveryVersion + 1 };
    });
    setClearCount((n) => n + 1);
    setGeneration((g) => g + 1);
  }, [sessionKey, hostId, chatId, update]);

  // Follow the chat while this view is mounted and the link is up; a new link forgot every stream, so ask again from where we are.
  useEffect(() => {
    if (!online) return;
    // `lastSeq` starts at -1 (nothing seen yet) but the wire field is unsigned: -1 is refused as an invalid message and the chat never loads.
    replayBuf.current = [];
    olderBuf.current = [];
    update((s) => (s.older.loading ? { ...s, older: { ...s.older, loading: false } } : s));
    void sendToHost(hostId, { t: "chatopen", chatId, afterSeq: Math.max(0, sessionRef.current.model.lastSeq), ...(pagingRef.current ? { paged: true } : {}) });
    return () => void sendToHost(hostId, { t: "chatclose", chatId });
  }, [hostId, chatId, online, update, generation]);

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
          if (m.t === "chatolder" && m.chatId === chatId) {
            olderBuf.current = [...olderBuf.current, ...m.events];
            if (m.partial) continue;
            const page = olderBuf.current;
            olderBuf.current = [];
            update((s) => prependOlder(s, page, { hasMore: m.hasMore, firstSeq: m.firstSeq }));
            continue;
          }
          if (m.t !== "chatevents" || m.chatId !== chatId) continue;
          if (m.replay && m.partial) {
            replayBuf.current = [...replayBuf.current, ...m.events];
            continue;
          }
          const events = replayBuf.current.length > 0 ? [...replayBuf.current, ...m.events] : m.events;
          replayBuf.current = [];
          const status = infoRef.current?.status;
          const wasUncertain = sessionRef.current.deliveryUncertain;
          const page = m.replay && m.hasMore !== undefined ? { hasMore: m.hasMore, firstSeq: m.firstSeq ?? 0 } : undefined;
          update((s) => {
            const next = applyEvents(s, events, { replay: m.replay, busy: status === "busy" || status === "waiting", page });
            return m.replay && !promptReceipts && next.sentRequestId ? pauseUnconfirmedPrompt(next) : next;
          });
          if (!m.replay) {
            for (const ev of events) {
              // `call_user`: the agent wants the user's eyes; the bubble shows when they are looking at another tab.
              const call = agentCallOf(ev as ChatEvent);
              if (call) {
                const { agent, label } = callInfoRef.current;
                addCall({ tabId: callTab, agent: agent as AgentCli | undefined, label, key: `call:${callTab}`, kind: "custom", title: t("calls.title.call", { agent: cliName(agent ?? "") }), detail: call.message });
              }
              const open = trackOpenRef.current(ev as ChatEvent);
              // Files stay on that PC: only addresses can be shown here.
              if (!open || !/^https?:\/\//i.test(open.target)) continue;
              const shown = loopbackPort(open.target) !== null ? tunnelUrl(hostId, open.target) : Promise.resolve(open.target);
              void shown.then((target) => routeAgentOpen({ ...open, target }, null, confirmOpenRef.current), () => {});
            }
          }
          const pending = sessionRef.current;
          if (m.replay && promptReceipts && pending.sentText !== null && pending.sentRequestId) {
            void sendToHost(hostId, { t: "chatprompt", chatId, text: pending.sentText, ...(pending.sentFiles.length > 0 ? { attachments: pending.sentFiles } : {}), requestId: pending.sentRequestId });
          }
          if (pending.deliveryUncertain && !wasUncertain) update((s) => ({ ...s, model: applyLocalError(s.model, t("chat.deliveryUncertain")) }));
        }
        pump();
      }),
    [hostId, chatId, sender, update, pump, promptReceipts, callTab],
  );

  // The remote's status changed (a turn ended, the link came back): the queue may be able to move.
  useEffect(pump, [pump, info?.status, online, session.queued.length]);

  const status = chatStatus(info, session.model);
  const model = useMemo(() => (status === session.model.status ? session.model : { ...session.model, status }), [session.model, status]);
  const modes = useMemo(() => chatModes(info, model), [info, model]);
  const models = useMemo(() => (canSetModel ? chatModels(info, model) : null), [canSetModel, info, model]);
  const thought = useMemo(() => chatThought(info, model), [info, model]);

  // Files go to the host first (one stream each), then the message with their ids joins the queue. Messages typed meanwhile wait behind them.
  const canAttach = !!host?.caps.includes("chatAttach");
  const uploads = useRef({ pending: 0, tail: Promise.resolve() });
  const send = useCallback(
    (text: string, attachments: ChatAttachment[] = []) => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      const enqueue = (files: ChatAttachmentRef[]) => {
        update((s) => ({ ...s, queued: [...s.queued, { text: trimmed, files }] }));
        pump();
      };
      const lane = uploads.current;
      if (attachments.length === 0 && lane.pending === 0) {
        enqueue([]);
        return;
      }
      lane.pending++;
      lane.tail = lane.tail.then(async () => {
        try {
          const files: ChatAttachmentRef[] = [];
          for (const a of attachments) {
            if (!a.upload) throw new Error(a.name);
            const id = await invoke<string>("remote_host_upload", { id: hostId, chatId, upload: a.upload, name: a.name, mime: a.mime });
            files.push({ id, name: a.name, mime: a.mime });
            // Kept staged while the message waits: pulled back into the composer, they are attachments again.
            stagedRef.current.set(id, a);
          }
          enqueue(files);
        } catch (e) {
          // Nothing queued: the files are not wanted any more, uploaded or not.
          attachments.forEach(discardAttachment);
          update((s) => ({ ...s, model: applyLocalError(s.model, t("remoteHosts.attachFailed", { error: String(e) })) }));
        } finally {
          lane.pending--;
        }
      });
    },
    [hostId, chatId, update, pump],
  );
  const cancel = useCallback(() => void sendToHost(hostId, { t: "chatcancel", chatId }), [hostId, chatId]);
  const answerPermission = useCallback((requestId: string, optionId: string | null) => void sendToHost(hostId, { t: "chatpermission", chatId, requestId, optionId }), [hostId, chatId]);
  const answerAsk = useCallback(
    (requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void sendToHost(hostId, { t: "chatask", chatId, requestId, action, content }),
    [hostId, chatId],
  );
  // A delegate's permission or question is answered in its own chat, which the host resolves by id.
  const answerDelegatePermission = useCallback((childChatId: string, requestId: string, optionId: string | null) => void sendToHost(hostId, { t: "chatpermission", chatId: childChatId, requestId, optionId }), [hostId]);
  const answerDelegateAsk = useCallback(
    (childChatId: string, requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => sendToHost(hostId, { t: "chatask", chatId: childChatId, requestId, action, content }).then(() => {}),
    [hostId],
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
  // Pause, resume or clear the goal: the host runs it.
  const canGoal = !!host?.caps.includes("chatGoal");
  const goalAction = useCallback((action: "pause" | "resume" | "clear") => sendToHost(hostId, { t: "chatgoal", chatId, action }).then(() => {}), [hostId, chatId]);
  // The host arms its own chats; only editing or cancelling its scheduled resume is forwarded (when it supports that).
  const canUpdateResume = !!host?.caps.includes("chatResume");
  const updateResume = useCallback((text: string | null) => void sendToHost(hostId, { t: "chatresume", chatId, text }), [hostId, chatId]);
  // The composer takes the message back (and its staged files with it, from `queued`), or throws it away and discards them itself.
  const unqueue = useCallback(
    (index: number) => {
      takeStaged(stagedRef.current, sessionRef.current.queued[index]?.files ?? []);
      update((s) => ({ ...s, queued: s.queued.filter((_, i) => i !== index) }));
    },
    [update],
  );
  const force = useCallback(
    (index: number) => {
      const cancels = forceNeedsCancel(sessionRef.current, chatStatus(infoRef.current, sessionRef.current.model));
      update((s) => forceQueued(s, index));
      if (cancels) cancel();
      else pump();
    },
    [update, pump, cancel],
  );
  // The agent runs on the other PC: its ended session is picked up there as a new tab (`resume`), when that PC can.
  const canResume = !!host?.caps.includes("resume");
  const infoAgent = info?.agent;
  const infoCwd = info?.cwd;
  const infoProfile = info?.profile;
  const restart = useCallback(() => {
    if (!canResume || !sessionKey || !infoAgent || !infoCwd) return;
    expectNewTab(hostId, chatLike(infoAgent, infoCwd, chatId));
    void sendToHost(hostId, { t: "resume", cwd: infoCwd, sessionId: sessionKey, cli: infoAgent, ...(infoProfile ? { profile: infoProfile } : {}), view: "chat" });
  }, [hostId, canResume, sessionKey, infoAgent, infoCwd, infoProfile]);
  // A fresh conversation: "/clear" in that chat's tab, or (once it ended) a new chat of the same agent and folder.
  const canClear = !!host?.caps.includes("chatClear");
  const clear = useCallback(() => {
    sessionRef.current.queued.forEach((q) => takeStaged(stagedRef.current, q.files).forEach(discardAttachment));
    update((s) => ({ ...s, queued: [] }));
    // Most agents keep the tab and just start a new session; the others get a new chat in its place.
    if (infoAgent && infoCwd) expectNewTab(hostId, chatLike(infoAgent, infoCwd, chatId), chatId);
    void sendToHost(hostId, { t: "chatclear", chatId });
  }, [hostId, chatId, update, infoAgent, infoCwd]);
  const newChat = useCallback(() => {
    if (!infoAgent || !infoCwd) return;
    expectNewTab(hostId, chatLike(infoAgent, infoCwd, chatId));
    void sendToHost(hostId, { t: "newchat", cli: infoAgent, cwd: infoCwd, ...(infoProfile != null ? { profile: infoProfile } : {}) });
  }, [hostId, chatId, infoAgent, infoCwd, infoProfile]);
  // The cache lifetime comes from the transcript, which only the host can read.
  const canCacheInfo = !!host?.caps.includes("chatCacheInfo");
  const loadCacheInfo = useMemo(
    () =>
      canCacheInfo
        ? () =>
            new Promise<{ ttlMs: number; lastCallAt: string | null }>((resolve, reject) => {
              const finish = (done: () => void) => {
                clearTimeout(timer);
                stop();
                done();
              };
              const stop = onHostMessages(hostId, (msgs) => {
                for (const m of msgs) {
                  if (m.t !== "chatcacheinfo" || m.chatId !== chatId) continue;
                  finish(() => (typeof m.ttlMs === "number" ? resolve({ ttlMs: m.ttlMs, lastCallAt: m.lastCallAt ?? null }) : reject(new Error("unavailable"))));
                  return;
                }
              });
              const timer = setTimeout(() => finish(() => reject(new Error("timeout"))), 10_000);
              void sendToHost(hostId, { t: "chatcacheinfo", chatId }).then((ok) => ok || finish(() => reject(new Error("offline"))));
            })
        : undefined,
    [canCacheInfo, hostId, chatId],
  );
  // Likewise nothing runs here to close: the remote PC owns the agent.
  const close = useCallback(async () => {}, []);

  const activity = useMemo(() => eventsActivity(session.events), [session.events]);
  const olderHas = session.older.has;
  const olderLoading = session.older.loading;
  const loadOlder = useCallback(async () => {
    const s = sessionRef.current;
    if (!s.older.has || s.older.loading) return;
    update((cur) => ({ ...cur, older: { ...cur.older, loading: true } }));
    const ok = await sendToHost(hostId, { t: "chatolder", chatId, beforeSeq: s.older.firstSeq });
    if (!ok) update((cur) => ({ ...cur, older: { ...cur.older, loading: false } }));
  }, [hostId, chatId, update]);
  const older = useMemo(() => (chatPaging ? { has: olderHas, loading: olderLoading, load: loadOlder } : undefined), [chatPaging, olderHas, olderLoading, loadOlder]);

  useChatCalls((info?.agent ?? "claude") as AgentCli, info ? callTab : undefined, session.model.items, { permission: answerPermission, ask: answerAsk }, false, { parked: false, label: info?.label });

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
    // The files are on the other PC once queued; the staged copies stay here so a message pulled back keeps them as attachments.
    queued: useMemo(() => session.queued.map((q) => ({ text: q.text, attachments: queuedAttachments(q.files, stagedRef.current) })), [session.queued]),
    canAttach,
    resumed: true,
    loaded: true,
    older,
    clearCount,
    sessionId: info?.sessionId,
    lastActivityAt: activity.at,
    usageTokens: activity.tokens,
    send,
    cancel,
    answerPermission,
    answerAsk,
    answerDelegatePermission,
    answerDelegateAsk,
    setMode,
    setModel,
    setThought,
    updateResume: canUpdateResume ? updateResume : undefined,
    unqueue,
    force,
    restart: canResume ? restart : undefined,
    clear: canClear ? clear : undefined,
    goalAction: canGoal ? goalAction : undefined,
    newChat,
    loadCacheInfo,
    close,
  };
}
