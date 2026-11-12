import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentCli } from "../agents/cliInfo";
import { createAgentOpenTracker, routeAgentOpen } from "../browser/agentOpen";
import { t } from "../i18n";
import { readAgentToolsConfig } from "../agents/agentToolsSettings";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { readString, writeString } from "../lib/storage";
import { getConfiguredShell } from "../terminal/TerminalSettingsContext";
import { NO_ACTIVITY, resumedActivity, trackActivity, type ChatActivity } from "./cacheWarning";
import { applyEvent, applyLocalError, delegatesOf, forceCancels, initialChat, isAgentBusy, isAgentExited, liveModels, liveThought, mergeReplay, settleAttached, settleChat, type ChatModelState, type GoalAction } from "./chatModel";
import type { ChatAttachment, ChatEvent, ChatModels, ChatModes, ChatStartResult, ChatStatus, ChatThought } from "./chatTypes";
import { isProviderAuthError } from "../../shared/providerAuth";
import { markProviderAuthRequired, PROVIDER_AUTHENTICATED, providerAuthRequired, useProviderAuthRequired, type ProviderAuthenticated } from "../profiles/providerAuth";

/** A message waiting for the agent to be idle. */
export interface QueuedMessage {
  text: string;
  attachments: ChatAttachment[];
}

// The model and thinking level the user picked last, per agent: the next new chat starts with them.
const lastModelKey = (agent: AgentCli) => `flowcode.chatLastModel.${agent}`;
const lastThoughtKey = (agent: AgentCli) => `flowcode.chatLastThought.${agent}`;

type ChatPhase = "starting" | "ready" | "failed";

interface UseChatOptions {
  agent: AgentCli;
  cwd: string;
  profileId?: string;
  /** Resumes this agent session instead of starting a fresh one. */
  resumeSessionId?: string;
  /** The resumed session must load: fail rather than start a fresh one (a terminal handing its agent over). */
  strictResume?: boolean;
  /** The shell id the agent runs where (`wsl`, `wsl:<distro>`, `host`); absent = the configured shell. */
  shell?: string;
  /** When the resumed conversation last had real activity (ms epoch); unknown (absent) counts as long ago. Read once per start. */
  initialActivityAt?: number;
  /** Attach mode: shows a chat that already runs (a delegated child, owned by its orchestrator) instead of starting one. Nothing is started, resumed or closed here: the chat is read-only for this hook, and closing its tab only detaches. */
  attachChatId?: string;
  /** Attach mode: the WSL distro the attached chat runs in (the orchestrator's), for its Linux paths. */
  attachWslDistro?: string | null;
  /** The app tab this chat lives in: pages the agent opens wait for it instead of popping over another tab. */
  openTabId?: string;
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
export function useChat({ agent, cwd, profileId, resumeSessionId, strictResume, shell, attachChatId, attachWslDistro, openTabId, initialActivityAt, onSessionId, onStatus }: UseChatOptions) {
  const confirmOpen = useConfirmDialog();
  const confirmOpenRef = useRef(confirmOpen);
  confirmOpenRef.current = confirmOpen;
  const openTabIdRef = useRef(openTabId);
  openTabIdRef.current = openTabId;
  const [model, setModelState] = useState<ChatModelState>(initialChat);
  const [phase, setPhase] = useState<ChatPhase>("starting");
  const [error, setError] = useState<string | null>(null);
  const [modes, setModes] = useState<ChatModes | null>(null);
  // The models announced at the start; the live list and current one come from the conversation's events (`model.models`).
  const [announcedModels, setAnnouncedModels] = useState<ChatModels | null>(null);
  // The thinking levels announced at the start; the live ones come from the conversation's events (`model.thought`).
  const [announcedThought, setAnnouncedThought] = useState<ChatThought | null>(null);
  const [chatId, setChatId] = useState<string | null>(null);
  // The WSL distro the agent runs in (its paths are Linux ones); null for a Windows chat.
  const [wslDistro, setWslDistro] = useState<string | null>(null);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const authRequired = useProviderAuthRequired(agent, profileId);
  const authRequiredRef = useRef(authRequired);
  authRequiredRef.current = authRequired;
  const authQueuePausedRef = useRef(false);
  if (authRequired) authQueuePausedRef.current = true;
  const needsAuthRestartRef = useRef(false);
  const reportAuthError = useCallback((message: string) => {
    if (attachChatId || !isProviderAuthError(message)) return;
    needsAuthRestartRef.current = true;
    authQueuePausedRef.current = true;
    markProviderAuthRequired(agent, profileId);
  }, [agent, profileId, attachChatId]);
  // The agent loaded the session asked for (false for a fresh one, or a resume that fell back to a new session).
  const [loaded, setLoaded] = useState(false);
  // Bumped by `restart` to run the start effect again.
  const [attempt, setAttempt] = useState(0);
  /** How many times the conversation was cleared: the empty chat's frog plays its clear scene for each. */
  const [clearCount, setClearCount] = useState(0);

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
  // Attach mode: the chat belongs to its orchestrator, so this hook neither writes to it nor closes it.
  const attachedRef = useRef(false);
  attachedRef.current = !!attachChatId;
  const onSessionIdRef = useRef(onSessionId);
  onSessionIdRef.current = onSessionId;
  // The start in flight (resolves once the agent is up or failed): `close` waits for it, so an agent still starting is never left behind.
  const startRef = useRef<Promise<void> | null>(null);
  // The previous agent being closed (a restart, /clear, a changed agent or folder): the next start waits for it, so two agents never start or end side by side on the same state (Codex's sqlite store, a session).
  const teardownRef = useRef<Promise<void>>(Promise.resolve());
  // `close` ended the agent for good (a terminal takes the session over): what is sent meanwhile waits in the queue, for a restart.
  const closedRef = useRef(false);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // `lastSeq` when the last message was handed to the agent: until a newer
  // event arrives its turn hasn't started, so the queue must not send another.
  const sentAtSeqRef = useRef<number | null>(null);
  // When the chat last did anything and how big the agent says its context is, from the raw events (the model keeps neither). Read at render: the model changes with it.
  const activityRef = useRef<ChatActivity>(NO_ACTIVITY);
  const initialActivityRef = useRef(initialActivityAt);
  initialActivityRef.current = initialActivityAt;

  useEffect(() => {
    let cancelled = false;
    activityRef.current = NO_ACTIVITY;
    let unlisten: (() => void) | null = null;
    let startedId: string | null = null;
    // Messages queued before a restart stay queued: they go out once the new agent is idle.
    const resumeId = talkedRef.current ? sessionIdRef.current : undefined;
    closedRef.current = false;
    setModelState(initialChat());
    setPhase("starting");
    setError(null);
    setLoaded(false);
    sentAtSeqRef.current = null;

    // An agent that opens a page or artifact (live events only, never a replay): shown in the Browser panel as the settings say.
    const trackOpen = createAgentOpenTracker(cwd);
    let distro: string | null = null;
    const followOpen = (ev: ChatEvent) => {
      if (ev.kind === "error") reportAuthError(ev.message);
      // An attached child's opens are routed by its orchestrator's chat, whether or not this tab exists.
      if (attachChatId) return;
      const open = trackOpen(ev);
      if (open) void routeAgentOpen(open, distro, confirmOpenRef.current, openTabIdRef.current);
    };

    // Deferred a tick: React StrictMode mounts, unmounts and mounts again at
    // once, and the first round must not spawn an agent of its own.
    const timer = setTimeout(() => {
      startRef.current = (async () => {
        try {
          await teardownRef.current;
          if (cancelled) return;
          // Attach mode joins a running chat instead of starting one; its id and distro are known already.
          const started: ChatStartResult = attachChatId
            ? { chatId: attachChatId, sessionId: "", modes: null, models: null, thought: null, loaded: false, wslDistro: attachWslDistro ?? null }
            : await invoke<ChatStartResult>("chat_start", {
                agent,
                cwd,
                profile: profileId ?? null,
                resumeSessionId: resumeId ?? null,
                strictResume: strictResume ?? false,
                // The chat runs where the user's terminal runs (inside WSL when the default shell is WSL).
                shell: shell ?? getConfiguredShell(),
                // What the agent may do through Flowcode's own tools, as the settings say now.
                tools: await readAgentToolsConfig(),
              });
          // Only a chat started here is this hook's to close.
          if (!attachChatId) startedId = started.chatId;
          // Cancelled meanwhile: the cleanup closes it (it waits for this start).
          if (cancelled) return;
          chatIdRef.current = started.chatId;
          if (!attachChatId) sessionIdRef.current = started.sessionId;
          // A resume that fell back to a new session (`loaded: false`) has nothing on disk yet either.
          talkedRef.current = started.loaded;
          setLoaded(started.loaded);
          setChatId(started.chatId);
          distro = started.wslDistro ?? null;
          setWslDistro(distro);
          setModes(started.modes);
          setAnnouncedModels(started.models ?? null);
          setAnnouncedThought(started.thought ?? null);
          // An attached chat's session is its owner's business: no tab saves it.
          if (!attachChatId) onSessionIdRef.current(started.sessionId);
          // Subscribe before fetching the replay, and hold what arrives
          // meanwhile: applied first, a live event would raise `lastSeq` past
          // the replay, whose events would then be skipped as already seen.
          let buffer: ChatEvent[] | null = [];
          const stop = await listen<ChatEventPayload>("chat-event", (e) => {
            if (e.payload.chatId !== started.chatId) return;
            if (buffer) buffer.push(e.payload.event);
            else {
              activityRef.current = trackActivity(activityRef.current, e.payload.event);
              setModelState((m) => applyEvent(m, e.payload.event));
              followOpen(e.payload.event);
            }
          });
          if (cancelled) {
            stop();
            return;
          }
          unlisten = stop;
          let past: ChatEvent[];
          try {
            past = await invoke<ChatEvent[]>("chat_events", { chatId: started.chatId, afterSeq: 0 });
          } catch (err) {
            if (cancelled) return;
            if (!attachChatId || !String(err).includes("unknown chat")) throw err;
            // The attached chat is gone (its child was closed): the tab shows it as ended, not as a failed start.
            buffer = null;
            setModelState((m) => applyEvent(m, { kind: "exit", seq: Number.MAX_SAFE_INTEGER, at: Date.now(), code: null }));
            setPhase("ready");
            return;
          }
          if (cancelled) return;
          const events = mergeReplay(past, buffer);
          buffer = null;
          const replayedActivity = events.reduce(trackActivity, activityRef.current);
          // A loaded session replays old history stamped with the load time: its real time is the one known from before.
          activityRef.current = started.loaded ? resumedActivity(replayedActivity, initialActivityRef.current) : replayedActivity;
          // A resumed session replays its history with no turn running; settling leaves "starting".
          setModelState((m) => {
            const replayed = events.reduce(applyEvent, m);
            // An attached chat may be mid-turn: leaving "starting" must keep the turn it is in.
            if (attachChatId) return replayed.status === "starting" ? settleAttached(replayed) : replayed;
            return started.loaded || replayed.status === "starting" ? settleChat(replayed) : replayed;
          });
          setPhase("ready");
        } catch (err) {
          if (cancelled) return;
          reportAuthError(String(err));
          setError(String(err));
          setPhase("failed");
        }
      })();
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      unlisten?.();
      // An agent still starting is closed once it is up; the next start waits for that.
      const pending = startRef.current;
      startRef.current = null;
      const closing = (async () => {
        await pending?.catch(() => {});
        if (startedId) await invoke("chat_close", { chatId: startedId }).catch(() => {});
      })();
      teardownRef.current = closing;
      chatIdRef.current = null;
      setChatId(null);
      setWslDistro(null);
    };
  }, [agent, cwd, profileId, attachChatId, attempt]);

  const status: ChatStatus = phase === "failed" ? "exited" : model.status;
  useEffect(() => {
    onStatusRef.current(status, error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  /** Hands a message to the agent; a failure shows up as an error in the conversation. */
  const dispatch = useCallback((text: string, attachments: ChatAttachment[]) => {
    if (providerAuthRequired(agent, profileId)) return;
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
        reportAuthError(message);
        setModelState((m) => applyLocalError(m, message));
      },
    );
  }, [agent, profileId, reportAuthError]);

  const send = useCallback(
    (text: string, attachments: ChatAttachment[] = []) => {
      if (attachedRef.current) return;
      if (authRequiredRef.current || providerAuthRequired(agent, profileId)) return;
      authQueuePausedRef.current = false;
      const trimmed = text.trim();
      if ((!trimmed && attachments.length === 0) || (!chatIdRef.current && !closedRef.current)) return;
      if (closedRef.current) setQueued((q) => [...q, { text: trimmed, attachments }]);
      else if (modelRef.current.status === "idle" && sentAtSeqRef.current === null) dispatch(trimmed, attachments);
      else setQueued((q) => [...q, { text: trimmed, attachments }]);
    },
    [dispatch, agent, profileId],
  );

  // The turn is over: send the next queued message.
  useEffect(() => {
    if (model.status !== "idle") return;
    if (authRequired || providerAuthRequired(agent, profileId)) return;
    if (authQueuePausedRef.current) return;
    if (closedRef.current) return;
    if (sentAtSeqRef.current !== null && model.lastSeq <= sentAtSeqRef.current) return;
    sentAtSeqRef.current = null;
    if (queued.length === 0) return;
    dispatch(queued[0].text, queued[0].attachments);
    setQueued((q) => q.slice(1));
  }, [model.status, model.lastSeq, queued, dispatch, authRequired, agent, profileId]);

  const cancel = useCallback(() => {
    // A delegated child is stopped through its task, so the orchestrator hears of it (status `cancelled`).
    const taskId = modelRef.current.task?.taskId;
    if (attachedRef.current) {
      if (taskId) invoke("delegate_cancel", { taskId }).catch(() => {});
      return;
    }
    if (chatIdRef.current) invoke("chat_cancel", { chatId: chatIdRef.current }).catch(() => {});
  }, []);

  /** "Send now": moves the queued message first and interrupts a running turn; the idle effect above then sends it. */
  const force = useCallback((index: number) => {
    if (authRequiredRef.current) return;
    authQueuePausedRef.current = false;
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

  const answerAsk = useCallback((requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => {
    const id = chatIdRef.current;
    if (id) invoke("chat_ask", { chatId: id, requestId, action, content }).catch((err) => failed(id, err));
  }, [failed]);

  /** Answers a permission request one of this chat's delegates asked, in the child's own chat. */
  const answerDelegatePermission = useCallback((childChatId: string, requestId: string, optionId: string | null) => {
    invoke("chat_permission", { chatId: childChatId, requestId, optionId }).catch((err) => failed(chatIdRef.current ?? "", err));
  }, [failed]);

  /** Answers a question one of this chat's delegates asked. */
  const answerDelegateAsk = useCallback((childChatId: string, requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => {
    invoke("chat_ask", { chatId: childChatId, requestId, action, content }).catch((err) => failed(chatIdRef.current ?? "", err));
  }, [failed]);

  // The pages this chat's delegates open (their own events reach no one when their tab is closed): live events only, from the chat's own window.
  const wslDistroRef = useRef(wslDistro);
  wslDistroRef.current = wslDistro;
  useEffect(() => {
    if (attachChatId) return;
    let off: (() => void) | null = null;
    let gone = false;
    const track = createAgentOpenTracker(cwd);
    void listen<ChatEventPayload>("chat-event", (e) => {
      if (!delegatesOf(modelRef.current.items).some((d) => d.childChatId === e.payload.chatId)) return;
      const open = track(e.payload.event);
      if (open) void routeAgentOpen(open, wslDistroRef.current, confirmOpenRef.current, openTabIdRef.current);
    }).then((stop) => (gone ? stop() : (off = stop)));
    return () => {
      gone = true;
      off?.();
    };
  }, [attachChatId, cwd]);

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
    writeString(lastModelKey(agent), modelId);
    setModelState((m) => ({ ...m, currentModelId: modelId }));
    invoke("chat_set_model", { chatId: id, modelId }).catch((err) => {
      if (chatIdRef.current !== id) return;
      // Only undo our own guess: an event may have moved the model since.
      setModelState((m) => applyLocalError(m.currentModelId === modelId ? { ...m, currentModelId: before } : m, t("chat.model.failed", { error: String(err) })));
    });
  }, [agent]);

  /** Pause, resume or stop the chat's goal; the backend's `_flowcode/goal` event shows the outcome. */
  const goalAction = useCallback((action: GoalAction) => {
    const id = chatIdRef.current;
    if (!id) return Promise.resolve();
    return invoke("chat_goal", { chatId: id, action }).then(
      () => undefined,
      (err) => {
        if (chatIdRef.current !== id) return;
        setModelState((m) => applyLocalError(m, t("chat.goal.failed", { error: String(err) })));
      },
    );
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
    writeString(lastThoughtKey(agent), value);
    setModelState((m) => ({ ...m, thought: { ...before, currentId: value } }));
    invoke("chat_set_thought", { chatId: id, value }).catch((err) => {
      if (chatIdRef.current !== id) return;
      // Only undo our own guess: an event may have moved the level since.
      setModelState((m) => applyLocalError(m.thought?.currentId === value ? { ...m, thought: before } : m, t("chat.thought.failed", { error: String(err) })));
    });
  }, [agent]);

  // A brand-new chat starts with the model and thinking level picked last for this agent, once. The level follows
  // the model (a switch can reset it), so it goes second, when the wanted model is the live one.
  const restoredRef = useRef<{ chatId: string; model: boolean; thought: boolean } | null>(null);
  useEffect(() => {
    if (!chatId || phase !== "ready" || resumedRef.current || loaded || attachChatId) return;
    if (restoredRef.current?.chatId !== chatId) restoredRef.current = { chatId, model: false, thought: false };
    const done = restoredRef.current;
    const wantedModel = readString(lastModelKey(agent));
    const switchModel = !!wantedModel && !!models && wantedModel !== models.currentModelId && models.availableModels.some((m) => m.modelId === wantedModel);
    if (!done.model) {
      if (!models && !thought) return;
      done.model = true;
      if (switchModel) {
        setModel(wantedModel!);
        return;
      }
    }
    if (done.thought || !thought || switchModel) return;
    done.thought = true;
    const wantedThought = readString(lastThoughtKey(agent));
    if (wantedThought && wantedThought !== thought.currentId && thought.available.some((l) => l.id === wantedThought)) setThought(wantedThought);
  }, [chatId, phase, loaded, attachChatId, agent, models, thought, setModel, setThought]);

  const unqueue = useCallback((index: number) => setQueued((q) => q.filter((_, i) => i !== index)), []);

  /** Starts the agent again - resuming the same session when it had a conversation. */
  const restart = useCallback(() => setAttempt((n) => n + 1), []);
  useEffect(() => {
    const authenticated = (event: Event) => {
      const detail = (event as CustomEvent<ProviderAuthenticated>).detail;
      if (attachChatId || detail?.cli !== agent || (detail.profile || null) !== (profileId || null)) return;
      if (needsAuthRestartRef.current || authRequiredRef.current) {
        needsAuthRestartRef.current = false;
        restart();
      }
    };
    window.addEventListener(PROVIDER_AUTHENTICATED, authenticated);
    return () => window.removeEventListener(PROVIDER_AUTHENTICATED, authenticated);
  }, [agent, profileId, attachChatId, restart]);

  /** "/clear": a fresh conversation in this tab. The queue is dropped and the
   * session forgotten, so the start effect runs a `session/new` (and reports
   * its id); the old agent is closed by the effect's cleanup, mid-turn or not. */
  const clear = useCallback(() => {
    setQueued([]);
    talkedRef.current = false;
    sessionIdRef.current = undefined;
    resumedRef.current = false;
    setClearCount((n) => n + 1);
    setAttempt((n) => n + 1);
  }, []);

  /** Ends the agent now and resolves once the backend has killed it: a terminal
   * about to resume the same session must never run beside it. */
  const close = useCallback(async () => {
    if (attachedRef.current) return;
    await startRef.current;
    await teardownRef.current;
    const id = chatIdRef.current;
    if (!id) return;
    closedRef.current = true;
    chatIdRef.current = null;
    await invoke("chat_close", { chatId: id }).catch(() => {});
  }, []);

  return { model, phase, error, modes, models, thought, chatId, wslDistro, authRequired, profileId: profileId ?? null, queued, canAttach: true, resumed: resumedRef.current, loaded, clearCount, sessionId: sessionIdRef.current, lastActivityAt: activityRef.current.at, usageTokens: activityRef.current.tokens, send, cancel, answerPermission, answerAsk, answerDelegatePermission, answerDelegateAsk, attached: !!attachChatId, setMode, setModel, setThought, goalAction, unqueue, force, restart, clear, close };
}

/** One running chat session, as `useChat` hands it to an agent view. */
export type ChatSession = Omit<ReturnType<typeof useChat>, "clear" | "answerDelegatePermission" | "answerDelegateAsk" | "attached" | "authRequired" | "goalAction"> & {
  /** Pause, resume or stop the goal; absent for a chat running on another PC. */
  goalAction?: (action: GoalAction) => Promise<void>;
  /** Starts a fresh conversation in the same tab; absent for a chat running on another PC. */
  clear?: () => void;
  /** Answer a permission request or question one of the chat's delegates asked (in the child's own chat); absent for a chat running on another PC, whose delegates are not shown. */
  answerDelegatePermission?: (childChatId: string, requestId: string, optionId: string | null) => void;
  answerDelegateAsk?: (childChatId: string, requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
  /** This provider needs authentication before sending another message. */
  authRequired?: boolean;
  /** A delegated child's chat shown read-only (see `useChat`'s `attachChatId`). */
  attached?: boolean;
};
