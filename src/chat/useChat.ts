import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentCli } from "../agents/cliInfo";
import { applyEvent, initialChat, settleChat, type ChatModelState } from "./chatModel";
import type { ChatEvent, ChatModes, ChatStartResult, ChatStatus } from "./chatTypes";

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
  onStatus: (status: ChatStatus) => void;
}

interface ChatEventPayload {
  chatId: string;
  event: ChatEvent;
}

/** Runs one agent behind a chat: starts it on mount, keeps the conversation
 * model fed from the backend's events, closes it on unmount. */
export function useChat({ agent, cwd, profileId, resumeSessionId, strictResume, onSessionId, onStatus }: UseChatOptions) {
  const [model, setModel] = useState<ChatModelState>(initialChat);
  const [phase, setPhase] = useState<ChatPhase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [modes, setModes] = useState<ChatModes | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  const [queued, setQueued] = useState<string[]>([]);
  // Bumped by `restart` to run the start effect again.
  const [attempt, setAttempt] = useState(0);

  const chatIdRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | undefined>(resumeSessionId);
  const modelRef = useRef(model);
  modelRef.current = model;
  const onSessionIdRef = useRef(onSessionId);
  onSessionIdRef.current = onSessionId;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // `lastSeq` when the last message was handed to the agent: until a newer
  // event arrives its turn hasn't started, so the queue must not send another.
  const sentAtSeqRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    let startedId: string | null = null;
    setModel(initialChat());
    setPhase("starting");
    setError(null);
    setQueued([]);
    sentAtSeqRef.current = null;

    // Deferred a tick: React StrictMode mounts, unmounts and mounts again at
    // once, and the first round must not spawn an agent of its own.
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const started = await invoke<ChatStartResult>("chat_start", {
            agent,
            cwd,
            profile: profileId ?? null,
            resumeSessionId: sessionIdRef.current ?? null,
            strictResume: strictResume ?? false,
          });
          startedId = started.chatId;
          if (cancelled) {
            invoke("chat_close", { chatId: started.chatId }).catch(() => {});
            return;
          }
          chatIdRef.current = started.chatId;
          sessionIdRef.current = started.sessionId;
          setChatId(started.chatId);
          setModes(started.modes);
          onSessionIdRef.current(started.sessionId);
          // Subscribe before fetching the replay: an event in between is
          // applied twice at worst, and the model skips it by `seq`.
          const stop = await listen<ChatEventPayload>("chat-event", (e) => {
            if (e.payload.chatId === started.chatId) setModel((m) => applyEvent(m, e.payload.event));
          });
          if (cancelled) {
            stop();
            return;
          }
          unlisten = stop;
          const past = await invoke<ChatEvent[]>("chat_events", { chatId: started.chatId, afterSeq: 0 });
          if (cancelled) return;
          // A resumed session replays its history as if a turn were running.
          setModel((m) => {
            const replayed = past.reduce(applyEvent, m);
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
    onStatusRef.current(status);
  }, [status]);

  /** Hands a message to the agent; a failure shows up as an error in the conversation. */
  const dispatch = useCallback((text: string) => {
    const id = chatIdRef.current;
    if (!id) return;
    sentAtSeqRef.current = modelRef.current.lastSeq;
    invoke("chat_prompt", { chatId: id, text }).catch((err) => {
      sentAtSeqRef.current = null;
      // Fractional so it sorts between the backend's own seq numbers.
      const seq = modelRef.current.lastSeq + 0.5;
      setModel((m) => applyEvent(m, { kind: "error", seq, at: Date.now(), message: String(err) }));
    });
  }, []);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !chatIdRef.current) return;
      if (modelRef.current.status === "idle" && sentAtSeqRef.current === null) dispatch(trimmed);
      else setQueued((q) => [...q, trimmed]);
    },
    [dispatch],
  );

  // The turn is over: send the next queued message.
  useEffect(() => {
    if (model.status !== "idle") return;
    if (sentAtSeqRef.current !== null && model.lastSeq <= sentAtSeqRef.current) return;
    sentAtSeqRef.current = null;
    if (queued.length === 0) return;
    dispatch(queued[0]);
    setQueued((q) => q.slice(1));
  }, [model.status, model.lastSeq, queued, dispatch]);

  const cancel = useCallback(() => {
    if (chatIdRef.current) invoke("chat_cancel", { chatId: chatIdRef.current }).catch(() => {});
  }, []);

  const answerPermission = useCallback((requestId: string, optionId: string | null) => {
    if (chatIdRef.current) invoke("chat_permission", { chatId: chatIdRef.current, requestId, optionId }).catch(() => {});
  }, []);

  const setMode = useCallback((modeId: string) => {
    if (!chatIdRef.current) return;
    invoke("chat_set_mode", { chatId: chatIdRef.current, modeId })
      .then(() => setModes((m) => (m ? { ...m, currentModeId: modeId } : m)))
      .catch(() => {});
  }, []);

  const unqueue = useCallback((index: number) => setQueued((q) => q.filter((_, i) => i !== index)), []);

  /** Starts the agent again - resuming the same session when it had one. */
  const restart = useCallback(() => setAttempt((n) => n + 1), []);

  return { model, phase, error, modes, chatId, queued, sessionId: sessionIdRef.current, send, cancel, answerPermission, setMode, unqueue, restart };
}

/** One running chat session, as `useChat` hands it to an agent view. */
export type ChatSession = ReturnType<typeof useChat>;
