import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./terminal.css";
import "./chat.css";
import type { ChatInfo } from "../../shared/remote-types";
import { ChatBody } from "./ChatBody";
import { FrogThinking } from "../../shared/FrogThinking";
import { ChatComposer } from "./ChatComposer";
import { CHAT_VIEW, ChatMenu, TERMINAL_VIEW, type ViewChoice } from "./ChatMenu";
import { PermissionBar } from "./ChatPermission";
import { ChatPluginView } from "./ChatPluginView";
import { defaultModeToApply } from "./chatModeDefaults";
import { chatModels, chatModes, chatStatus, emptySession, pendingPermissions } from "./chatSession";
import { useTwoFingerSwipe } from "./chatSwipe";
import { answerChatPermission, cancelChat, forceChatPrompt, lastChatViews, renameChat, sendChatPrompt, setChatMode, setChatModel, unqueueChatPrompt, useChatInfo, useChatSession, useFollowChat } from "./chats";
import { agentName } from "./common";
import { defaultViewFor } from "./defaultView";
import { t } from "./i18n";
import { AgentLogo, AgentsIcon, BackIcon, ChevronDownIcon } from "./icons";
import { setChatTabShown, showToast, useRemoteSelector, useSupports } from "./remote";
import { TermAgents } from "./TermAgents";
import { openLink, TermLink } from "./TermLink";
import { useTerminalViewport } from "./termViewport";
import { useReadyViews, viewFits, viewLabel } from "./viewCache";
import { useWide } from "./wide";

/** Distance from the end of the thread that still counts as "at the bottom". */
const BOTTOM_SLACK = 80;

/** Playful verbs the thinking line cycles through while no tool runs. */
const THINKING_VERBS = ["chatVerb1", "chatVerb2", "chatVerb3", "chatVerb4", "chatVerb5", "chatVerb6", "chatVerb7", "chatVerb8"] as const;

const folderName = (cwd: string) => cwd.split(/[\\/]+/).filter(Boolean).pop() ?? cwd;

/** `embedded`: the wide layout's main card, whose tab strip already says which chat this is, so there is no back button. `onTerminal` hands the session to a desktop terminal tab (App opens it once it appears). `onSwitch` opens another terminal from the agents drawer. */
/** Chats whose default mode was already tried, so it is applied at most once per chat. */
const defaultModeTried = new Set<string>();

export function ChatScreen({ chatId, onBack, onTerminal, onSwitch, embedded }: { chatId: string; onBack: () => void; onTerminal: (chat: ChatInfo) => void; onSwitch?: (ptyId: string) => void; embedded?: boolean }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  /** The thread follows new messages only while the user is at its end. */
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const cancelRename = useRef(false);
  const canRename = useSupports("chatRename");
  const info = useChatInfo(chatId);
  const tabId = info?.tabId;
  // While this screen is up the chat is on the user's screen, so its notifications skip the toast.
  useEffect(() => {
    if (tabId === undefined) return;
    setChatTabShown(tabId, true);
    return () => setChatTabShown(tabId, false);
  }, [tabId]);
  // Counts, not the lists: a message that changes neither re-renders nothing here.
  const othersWaiting = useRemoteSelector((s) => (s.tabs ?? []).filter((x) => x.cli && x.status === "waiting").length + (s.chats ?? []).filter((c) => c.status === "waiting" && c.chatId !== chatId).length);
  const chatsKnown = useRemoteSelector((s) => s.chats !== null);
  const language = useRemoteSelector((s) => s.settings?.resolvedLanguage);
  const stored = useChatSession(chatId);
  const session = useMemo(() => stored ?? emptySession(), [stored]);
  const { model } = session;
  const wide = useWide();
  useFollowChat(chatId);

  const kbOpen = useTerminalViewport(
    screenRef,
    useCallback(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }, []),
  );

  const views = useReadyViews().filter((v) => viewFits(v, wide));
  const [view, setView] = useState(() => lastChatViews.get(chatId) ?? defaultViewFor(wide));
  const pkg = views.find((v) => v.id === view);
  const shown = pkg ? pkg.id : CHAT_VIEW;
  const choices: ViewChoice[] = views.map((v) => ({ id: v.id, label: viewLabel(v, language) }));
  const order = [CHAT_VIEW, ...views.map((v) => v.id), TERMINAL_VIEW];

  const status = info ? chatStatus(info, model) : "idle";
  const exited = status === "exited";
  const working = status === "busy" || status === "waiting";
  // An agent that is gone can't take an answer: no request is offered once the chat has exited.
  const pending = exited ? [] : pendingPermissions(model);
  const answerPermission = useCallback(
    (requestId: string, optionId: string | null) =>
      answerChatPermission(chatId, requestId, optionId).then((ok) => {
        if (!ok) showToast(t("chatPermSendFailed"));
        return ok;
      }),
    [chatId],
  );
  const confirmLinks = useRemoteSelector((s) => s.settings?.confirmLinkOpen);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const closeLink = useCallback(() => setLinkUrl(null), []);
  /** A link was tapped: open it at once when the user opted out of the prompt, else ask in the sheet. */
  const onLink = useCallback(
    (url: string) => {
      if (confirmLinks === false) void openLink(url);
      else setLinkUrl(url);
    },
    [confirmLinks],
  );
  const modes = chatModes(info, model);
  const canSetModel = useSupports("chatModel");
  const models = canSetModel ? chatModels(info, model) : null;
  // A new chat starts in the agent's default mode for this device, once.
  useEffect(() => {
    if (!info || !modes || defaultModeTried.has(chatId)) return;
    const wanted = defaultModeToApply({ agent: info.agent, offered: modes.availableModes.map((m) => m.id), currentModeId: modes.currentModeId, liveModeId: model.currentModeId, itemCount: model.items.length, loaded: session.loaded, ready: status === "idle" });
    if (status === "idle" && session.loaded) defaultModeTried.add(chatId);
    if (wanted) setChatMode(chatId, wanted);
  });

  /** Shows another view; the terminal isn't one the phone draws: the desktop turns the session into a terminal tab and App opens it. */
  const pick = useCallback(
    (id: string) => {
      if (id === TERMINAL_VIEW) {
        if (!info) return;
        showToast(t("chatTerminalWaiting"));
        onTerminal(info);
        return;
      }
      if (id !== CHAT_VIEW && !views.some((v) => v.id === id)) return;
      lastChatViews.set(chatId, id);
      setView(id);
    },
    [chatId, info, onTerminal, views],
  );

  // Two fingers sideways step through the views: chat, the plugins, then the terminal.
  useTwoFingerSwipe(
    screenRef,
    (direction) => {
      const next = order[order.indexOf(shown) + direction];
      if (next) pick(next);
    },
    !menuOpen,
  );

  // The thread follows the conversation while the user is at its end (including when the keyboard resizes it).
  const toEnd = () => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(toEnd, [model.items, model.plan, session.queued.length, shown, pending.length]);
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [shown]);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK;
    stick.current = near;
    setAtBottom(near);
  };

  const copyId = () => {
    if (info?.sessionId) void navigator.clipboard.writeText(info.sessionId).then(() => showToast(t("chatIdCopied")), () => {});
  };

  /** Ends the title edit: Escape sets `cancelRename` before blurring, so it is dropped here. */
  function commitRename() {
    if (cancelRename.current) {
      cancelRename.current = false;
      setEditing(false);
      return;
    }
    const label = draft.trim();
    setEditing(false);
    if (label && label !== info?.label) renameChat(chatId, label);
  }

  const closeAgents = useCallback(() => setAgentsOpen(false), []);

  const stateText = status === "waiting" ? t("termStateWaiting") : status === "busy" ? t("termStateBusy") : status === "starting" ? t("chatStateStarting") : status === "exited" ? t("chatStateExited") : t("termStateIdle");

  /** What the agent is doing right now, for the status line: the title of the step still running. */
  const runningTool = useMemo(() => {
    for (let i = model.items.length - 1; i >= 0; i--) {
      const item = model.items[i];
      if (item.type === "tool" && item.call.status !== "completed" && item.call.status !== "failed") return item.call.title ?? item.call.kind ?? null;
    }
    return null;
  }, [model.items]);

  const back = !embedded && (
    <button type="button" className="tm-back" aria-label={t("back")} onClick={onBack}>
      <BackIcon />
    </button>
  );

  if (!info) {
    return (
      <div className={"screen term-screen chat-screen" + (embedded ? " is-embedded" : "")} ref={screenRef}>
        <header className="term-head">{back}</header>
        <div className="chat-note">{chatsKnown ? t("chatGone") : t("loading")}</div>
      </div>
    );
  }

  return (
    <div className={"screen term-screen chat-screen" + (embedded ? " is-embedded" : "") + (kbOpen ? " kb" : "")} ref={screenRef}>
      <header className="term-head chat-head">
        {back}
        {editing ? (
          <div className="chat-title">
            <span className="chat-title-logo">
              <AgentLogo cli={info.agent} size={18} />
            </span>
            <input
              className="term-title-input"
              value={draft}
              autoFocus
              maxLength={128}
              enterKeyHint="done"
              aria-label={t("rename")}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  cancelRename.current = true;
                  e.currentTarget.blur();
                }
              }}
              onBlur={commitRename}
            />
          </div>
        ) : (
          <button type="button" className="chat-title" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}>
            <span className="chat-title-logo">
              <AgentLogo cli={info.agent} size={18} />
            </span>
            <span className="chat-title-text">
              <span className="chat-title-line">
                <b>{info.label}</b>
                <ChevronDownIcon />
              </span>
              <span className="chat-title-sub">
                {agentName(info.agent)} · {folderName(info.cwd)}
              </span>
            </span>
          </button>
        )}
        <i className={"term-dot chat-dot is-" + status} role="img" aria-label={stateText} title={stateText} />
        {!embedded && onSwitch && (
          <button type="button" className="tm-back chat-agents-btn" aria-label={othersWaiting ? t("agentsWaitingAria", { n: othersWaiting }) : t("agents")} onClick={() => setAgentsOpen(true)}>
            <AgentsIcon />
            {othersWaiting > 0 && <b className="term-pill-badge">{othersWaiting}</b>}
          </button>
        )}
      </header>

      {shown === CHAT_VIEW || !pkg ? (
        <>
          <div className="chat-thread-wrap">
            <div className="chat-thread" ref={scrollRef} onScroll={onScroll}>
              <div className="chat-thread-inner" ref={innerRef}>
                {model.items.length === 0 && <div className="chat-empty">{session.loaded ? t("chatEmpty") : t("loading")}</div>}
                <ChatBody items={model.items} plan={model.plan} onLink={onLink} />
              </div>
            </div>
            {!atBottom && (
              <button
                type="button"
                className="chat-jump"
                onClick={() => {
                  stick.current = true;
                  toEnd();
                  setAtBottom(true);
                }}
              >
                {t("chatJumpToEnd")}
              </button>
            )}
          </div>
          <PermissionBar pending={pending} onAnswer={answerPermission} />
          {status === "busy" && !exited && (
            <div className="chat-status">
              <FrogThinking activity={runningTool} verbs={THINKING_VERBS.map((k) => t(k))} startedAt={model.turn?.startedAt} outChars={model.turn?.outChars} tokensLabel={(n) => t("chatTokens", { n })} tokensTitle={t("chatTokensTitle")} />
            </div>
          )}
          {exited ? (
            <div className="chat-ended" role="status">
              {t("chatExited")}
            </div>
          ) : (
            <ChatComposer chatId={chatId} agent={info?.agent ?? ""} busy={working} queued={session.queued} modes={modes} onMode={(modeId) => setChatMode(chatId, modeId)} models={models} onModel={(modelId) => setChatModel(chatId, modelId)} onSend={(text) => sendChatPrompt(chatId, text)} onStop={() => cancelChat(chatId)} onUnqueue={(i) => unqueueChatPrompt(chatId, i)} onForce={(i) => forceChatPrompt(chatId, i)} />
          )}
        </>
      ) : (
        <>
          <PermissionBar pending={pending} onAnswer={answerPermission} />
          <ChatPluginView key={pkg.id} pkg={pkg} info={info} session={session} onSwitchView={pick} />
          {exited && (
            <div className="chat-ended" role="status">
              {t("chatExited")}
            </div>
          )}
        </>
      )}

      <ChatMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        agent={info.agent}
        agentName={agentName(info.agent)}
        title={info.label}
        cwd={info.cwd}
        views={choices}
        view={shown}
        onView={pick}
        modes={modes}
        onMode={(modeId) => setChatMode(chatId, modeId)}
        onCopyId={info.sessionId ? copyId : undefined}
        onRename={
          canRename
            ? () => {
                setDraft(info.label);
                setEditing(true);
              }
            : undefined
        }
        onStop={working ? () => cancelChat(chatId) : undefined}
      />
      {!embedded && onSwitch && <TermAgents activePty="" open={agentsOpen} onClose={closeAgents} onOpen={onSwitch} />}
      <TermLink url={linkUrl} onClose={closeLink} />
    </div>
  );
}
