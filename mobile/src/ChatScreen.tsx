import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./terminal.css";
import "./chat.css";
import type { ChatInfo } from "../../shared/remote-types";
import { ChatBody } from "./ChatBody";
import { ChatComposer } from "./ChatComposer";
import { CHAT_VIEW, ChatMenu, TERMINAL_VIEW, type ViewChoice } from "./ChatMenu";
import { PermissionBar } from "./ChatPermission";
import { ChatPluginView } from "./ChatPluginView";
import { chatModes, chatStatus, emptySession, pendingPermissions } from "./chatSession";
import { useTwoFingerSwipe } from "./chatSwipe";
import { answerChatPermission, cancelChat, sendChatPrompt, setChatMode, unqueueChatPrompt, useChatInfo, useChatSession, useFollowChat } from "./chats";
import { agentName } from "./common";
import { defaultViewFor } from "./defaultView";
import { t } from "./i18n";
import { AgentLogo, BackIcon, ChevronDownIcon } from "./icons";
import { setChatTabShown, showToast, useRemoteSelector } from "./remote";
import { openLink, TermLink } from "./TermLink";
import { useTerminalViewport } from "./termViewport";
import { useReadyViews, viewFits, viewLabel } from "./viewCache";
import { useWide } from "./wide";

/** The view each chat was last shown with, so leaving a chat and coming back keeps a plugin view. */
const lastViews = new Map<string, string>();
/** Distance from the end of the thread that still counts as "at the bottom". */
const BOTTOM_SLACK = 80;

const folderName = (cwd: string) => cwd.split(/[\\/]+/).filter(Boolean).pop() ?? cwd;

/** `embedded`: the wide layout's main card, whose tab strip already says which chat this is, so there is no back button. `onTerminal` hands the session to a desktop terminal tab (App opens it once it appears). */
export function ChatScreen({ chatId, onBack, onTerminal, embedded }: { chatId: string; onBack: () => void; onTerminal: (chat: ChatInfo) => void; embedded?: boolean }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  /** The thread follows new messages only while the user is at its end. */
  const stick = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const info = useChatInfo(chatId);
  const tabId = info?.tabId;
  // While this screen is up the chat is on the user's screen, so its notifications skip the toast.
  useEffect(() => {
    if (tabId === undefined) return;
    setChatTabShown(tabId, true);
    return () => setChatTabShown(tabId, false);
  }, [tabId]);
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
  const [view, setView] = useState(() => lastViews.get(chatId) ?? defaultViewFor(wide));
  const pkg = views.find((v) => v.id === view);
  const shown = pkg ? pkg.id : CHAT_VIEW;
  const choices: ViewChoice[] = views.map((v) => ({ id: v.id, label: viewLabel(v, language) }));
  const order = [CHAT_VIEW, ...views.map((v) => v.id), TERMINAL_VIEW];

  const status = info ? chatStatus(info, model) : "idle";
  const exited = status === "exited";
  const working = status === "busy" || status === "waiting";
  const pending = pendingPermissions(model);
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
      lastViews.set(chatId, id);
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

  const stateText = status === "waiting" ? t("termStateWaiting") : status === "busy" ? t("termStateBusy") : status === "starting" ? t("chatStateStarting") : status === "exited" ? t("chatStateExited") : t("termStateIdle");

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
        <i className={"term-dot chat-dot is-" + status} role="img" aria-label={stateText} title={stateText} />
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
          <PermissionBar pending={pending} onAnswer={(requestId, optionId) => answerChatPermission(chatId, requestId, optionId)} />
          {exited ? (
            <div className="chat-ended" role="status">
              {t("chatExited")}
            </div>
          ) : (
            <ChatComposer chatId={chatId} busy={working} queued={session.queued} onSend={(text) => sendChatPrompt(chatId, text)} onStop={() => cancelChat(chatId)} onUnqueue={(i) => unqueueChatPrompt(chatId, i)} />
          )}
        </>
      ) : (
        <>
          <PermissionBar pending={pending} onAnswer={(requestId, optionId) => answerChatPermission(chatId, requestId, optionId)} />
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
        onStop={working ? () => cancelChat(chatId) : undefined}
      />
      <TermLink url={linkUrl} onClose={closeLink} />
    </div>
  );
}
