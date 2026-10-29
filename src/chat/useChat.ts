import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentCli } from "../agents/cliInfo";
import { t } from "../i18n";
import { applyEvent, applyLocalError, forceCancels, initialChat, isAgentBusy, isAgentExited, liveModels, liveThought, mergeReplay, settleChat, type ChatModelState } from "./chatModel";
import type { ChatAttachment, ChatEvent, ChatModels, ChatModes, ChatStartResult, ChatStatus, ChatThought } from "./chatTypes";

/** A message waiting for the agent to be idle. */
export interface QueuedMessage {
  text: string;
  attachments: ChatAttachment[];
}

type ChatPhase = "starting" | "ready" | "failed";

interface UseChatOptions {
  agent: AgentCli;
  cwd: string;
  profileId?: string;
  /** Resumes this agent session instead of starting a fresh one. */
  resumeSessionId?: string;
  /** The resumed session must load: fail rather than start a fresh one (a terminal handing its agent over). */
  strictResume?: boolean;
  /** The agent's session id, once it is up (the terminal can resume it). */
  onSessionId: (sessionId: string) => void;
  /** The chat's status; `error` is why it failed to start, when it did. */
  onStatus: (status: ChatStatus, error?: string | null) => void;
}

interface ChatEventPayload {
  chatId: string;
  event: ChatEvent;
}

/** Runs one agent behind a chat: starts it on mount, keeps the conversation
 * model fed from the backend's events, closes it on unmount. */
export function useChat({ agent, cwd, profileId, resumeSessionId, strictResume, onSessionId, onStatus }: UseChatOptions) {
  const [model, setModelState] = useState<ChatModelState>(initialChat);
  const [phase, setPhase] = useState<ChatPhase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [modes, setModes] = useState<ChatModes | null>(null);
  // The models announced at the start; the live list and current one come from the conversation's events (`model.models`).
  const [announcedModels, setAnnouncedModels] = useState<ChatModels | null>(null);
  // The thinking levels announced at the start; the live ones come from the conversation's events (`model.thought`).
  const [announcedThought, setAnnouncedThought] = useState<ChatThought | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  // The agent loaded the session asked for (false for a fresh one, or a resume that fell back to a new session).
  const [loaded, setLoaded] = useState(false);
  // Bumped by `restart` to run the start effect again.
  const [attempt, setAttempt] = useState(0);

  const chatIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | undefined>(resumeSessionId);
  // Whether this chat continues an existing session (never a fresh one).
  const resumedRef = useRef(!!resumeSessionId);
  // Whether the current session has a conversation on disk to resume: it was
  // loaded, or a prompt reached the agent. A fresh `session/new` nobody spoke
  // to is not saved by the agent, so a restart must not try to resume it.
  const talkedRef = useRef(!!resumeSessionId);
  const modelRef = useRef(model);
  modelRef.current = model;
  const onSessionIdRef = useRef(onSessionId);
  onSessionIdRef.current = onSessionId;
  // The start in flight (resolves once the agent is up or failed): `close` waits for it, so an agent still starting is never left behind.
  const startRef = useRef<Promise<void> | null>(null);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // `lastSeq` when the last message was handed to the agent: until a newer
  // event arrives its turn hasn't started, so the queue must not send another.
  const sentAtSeqRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let startedId: string | null = null;
    // Messages queued before a restart stay queued: they go out once the new agent is idle.
    const resumeId = talkedRef.current ? sessionIdRef.current : undefined;
    setModelState(initialChat());
    setPhase("starting");
    setError(null);
    setLoaded(false);
    sentAtSeqRef.current = null;

    // Deferred a tick: React StrictMode mounts, unmounts and mounts again at
    // once, and the first round must not spawn an agent of its own.
    const timer = setTimeout(() => {
      startRef.current = (async () => {
        try {
          const started = await invoke<ChatStartResult>("chat_start", {
            agent,
            cwd,
            profile: profileId ?? null,
            resumeSessionId: resumeId ?? null,
            strictResume: strictResume ?? false,
          });
          startedId = started.chatId;
          if (cancelled) {
            invoke("chat_close", { chatId: started.chatId }).catch(() => {});
            return;
          }
          chatIdRef.current = started.chatId;
          sessionIdRef.current = started.sessionId;
          // A resume that fell back to a new session (`loaded: false`) has nothing on disk yet either.
          talkedRef.current = started.loaded;
          setLoaded(started.loaded);
          setChatId(started.chatId);
          setModes(started.modes);
          setAnnouncedModels(started.models ?? null);
          setAnnouncedThought(started.thought ?? null);
          onSessionIdRef.current(started.sessionId);
          // Subscribe before fetching the replay, and hold what arrives
          // meanwhile: applied first, a live event would raise `lastSeq` past
          // the replay, whose events would then be skipped as already seen.
          let buffer: ChatEvent[] | null = [];
          const stop = await listen<ChatEventPayload>("chat-event", (e) => {
            if (e.payload.chatId !== started.chatId) return;
            if (buffer) buffer.push(e.payload.event);
            else setModelState((m) => applyEvent(m, e.payload.event));
          });
          if (cancelled) {
            stop();
            return;
          }
          unlisten = stop;
          const past = await invoke<ChatEvent[]>("chat_events", { chatId: started.chatId, afterSeq: 0 });
          if (cancelled) return;
          const events = mergeReplay(past, buffer);
          buffer = null;
          // A resumed session replays its history with no turn running; settling leaves "starting".
          setModelState((m) => {
            const replayed = events.reduce(applyEvent, m);
            return started.loaded || replayed.status === "starting" ? settleChat(replayed) : replayed;
          });
          setPhase("ready");
        } catch (err) {
          if (cancelled) return;
          setError(String(err));
          setPhase("failed");
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unlisten?.();
      if (startedId) invoke("chat_close", { chatId: startedId }).catch(() => {});
      chatIdRef.current = null;
      setChatId(null);
    };
  }, [agent, cwd, profileId, attempt]);

  const status: ChatStatus = phase === "failed" ? "exited" : model.status;
  useEffect(() => {
    onStatusRef.current(status, error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  /** Hands a message to the agent; a failure shows up as an error in the conversation. */
  const dispatch = useCallback((text: string, attachments: ChatAttachment[]) => {
    const id = chatIdRef.current;
    if (!id) return;
    sentAtSeqRef.current = modelRef.current.lastSeq;
    invoke("chat_prompt", { chatId: id, text, attachments }).then(
      () => {
        if (chatIdRef.current === id) talkedRef.current = true;
      },
      (err) => {
        // The chat closed or restarted meanwhile: this answer is about an agent that is gone.
        if (chatIdRef.current !== id) return;
        const message = String(err);
        if (isAgentBusy(message) || isAgentExited(message)) {
          // Never sent: back to the front of the queue. It waits for an event
          // newer than now (the running turn's end), so a busy agent isn't
          // asked again in a loop; after an exit, a restart sends it.
          sentAtSeqRef.current = modelRef.current.lastSeq;
          setQueued((q) => [{ text, attachments }, ...q]);
          return;
        }
        sentAtSeqRef.current = null;
        setModelState((m) => applyLocalError(m, message));
      },
    );
  }, []);

  const send = useCallback(
    (text: string, attachments: ChatAttachment[] = []) => {
      const trimmed = text.trim();
      if ((!trimmed && attachments.length === 0) || !chatIdRef.current) return;
      if (modelRef.current.status === "idle" && sentAtSeqRef.current === null) dispatch(trimmed, attachments);
      else setQueued((q) => [...q, { text: trimmed, attachments }]);
    },
    [dispatch],
  );

  // The turn is over: send the next queued message.
  useEffect(() => {
    if (model.status !== "idle") return;
    if (sentAtSeqRef.current !== null && model.lastSeq <= sentAtSeqRef.current) return;
    sentAtSeqRef.current = null;
    if (queued.length === 0) return;
    dispatch(queued[0].text, queued[0].attachments);
    setQueued((q) => q.slice(1));
  }, [model.status, model.lastSeq, queued, dispatch]);

  const cancel = useCallback(() => {
    if (chatIdRef.current) invoke("chat_cancel", { chatId: chatIdRef.current }).catch(() => {});
  }, []);

  /** "Send now": moves the queued message first and interrupts a running turn; the idle effect above then sends it. */
  const force = useCallback((index: number) => {
    // A prompt sent whose turn hasn't started yet is about to run: interrupt it too.
    const inFlight = sentAtSeqRef.current !== null;
    // The previous prompt may not have started its turn yet; its guard must not hold this one back.
    sentAtSeqRef.current = null;
    setQueued((q) => (index < 0 || index >= q.length ? q : [q[index], ...q.filter((_, i) => i !== index)]));
    if (forceCancels(modelRef.current.status, inFlight)) cancel();
  }, [cancel]);

  /** Shows a failed call in the conversation, unless the chat it was about is gone. */
  const failed = useCallback((id: string, err: unknown) => {
    if (chatIdRef.current === id) setModelState((m) => applyLocalError(m, String(err)));
  }, []);

  const answerPermission = useCallback((requestId: string, optionId: string | null) => {
    const id = chatIdRef.current;
    if (id) invoke("chat_permission", { chatId: id, requestId, optionId }).catch((err) => failed(id, err));
  }, [failed]);

  const setMode = useCallback((modeId: string) => {
    const id = chatIdRef.current;
    if (!id) return;
    invoke("chat_set_mode", { chatId: id, modeId })
      .then(() => {
        if (chatIdRef.current === id) setModes((m) => (m ? { ...m, currentModeId: modeId } : m));
      })
      .catch((err) => failed(id, err));
  }, [failed]);

  // The agent's events (`_flowcode/model`, `config_option_update`) say the list once it changes; until then, the one announced at the start.
  const offered = model.models !== undefined ? model.models : announcedModels;
  const models = useMemo(() => liveModels(offered, model.currentModelId), [offered, model.currentModelId]);
  const modelsRef = useRef(models);
  modelsRef.current = models;

  /** Switches the agent's model (from its next message on, if a turn runs): shown at once, put back if the backend refuses. */
  const setModel = useCallback((modelId: string) => {
    const id = chatIdRef.current;
    const before = modelsRef.current?.currentModelId ?? null;
    if (!id || modelId === before) return;
    setModelState((m) => ({ ...m, currentModelId: modelId }));
    invoke("chat_set_model", { chatId: id, modelId }).catch((err) => {
      if (chatIdRef.current !== id) return;
      // Only undo our own guess: an event may have moved the model since.
      setModelState((m) => applyLocalError(m.currentModelId === modelId ? { ...m, currentModelId: before } : m, t("chat.model.failed", { error: String(err) })));
    });
  }, []);

  // Likewise the thinking levels: `_flowcode/thought` says them once they change (they follow the model).
  const offeredThought = model.thought !== undefined ? model.thought : announcedThought;
  const thought = useMemo(() => liveThought(offeredThought), [offeredThought]);
  const thoughtRef = useRef(thought);
  thoughtRef.current = thought;

  /** Switches the agent's thinking level (from its next message on, if a turn runs): shown at once, put back if the backend refuses. */
  const setThought = useCallback((value: string) => {
    const id = chatIdRef.current;
    const before = thoughtRef.current;
    if (!id || !before || value === before.currentId) return;
    setModelState((m) => ({ ...m, thought: { ...before, currentId: value } }));
    invoke("chat_set_thought", { chatId: id, value }).catch((err) => {
      if (chatIdRef.current !== id) return;
      // Only undo our own guess: an event may have moved the level since.
      setModelState((m) => applyLocalError(m.thought?.currentId === value ? { ...m, thought: before } : m, t("chat.thought.failed", { error: String(err) })));
    });
  }, []);

  const unqueue = useCallback((index: number) => setQueued((q) => q.filter((_, i) => i !== index)), []);

  /** Starts the agent again - resuming the same session when it had a conversation. */
  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  /** "/clear": a fresh conversation in this tab. The queue is dropped and the
   * session forgotten, so the start effect runs a `session/new` (and reports
   * its id); the old agent is closed by the effect's cleanup, mid-turn or not. */
  const clear = useCallback(() => {
    setQueued([]);
    talkedRef.current = false;
    sessionIdRef.current = undefined;
    resumedRef.current = false;
    setAttempt((n) => n + 1);
  }, []);

  /** Ends the agent now and resolves once the backend has killed it: a terminal
   * about to resume the same session must never run beside it. */
  const close = useCallback(async () => {
    await startRef.current;
    const id = chatIdRef.current;
    if (!id) return;
    chatIdRef.current = null;
    await invoke("chat_close", { chatId: id }).catch(() => {});
  }, []);

  return { model, phase, error, modes, models, thought, chatId, queued, canAttach: true, resumed: resumedRef.current, loaded, sessionId: sessionIdRef.current, send, cancel, answerPermission, setMode, setModel, setThought, unqueue, force, restart, clear, close };
}

/** One running chat session, as `useChat` hands it to an agent view. */
export type ChatSession = Omit<ReturnType<typeof useChat>, "clear"> & {
  /** Starts a fresh conversation in the same tab; absent for a chat running on another PC. */
  clear?: () => void;
};
