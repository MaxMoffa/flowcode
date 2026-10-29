import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { shortCwd } from "./common";
import { t } from "./i18n";
import { AgentLogo, ChatIcon, CheckIcon, CloseIcon, CopyIcon, PencilIcon, StopIcon, TerminalIcon } from "./icons";

/** A way to look at the session: the built-in chat, a plugin's view or the terminal. */
export interface ViewChoice {
  id: string;
  label: string;
}

export const CHAT_VIEW = "chat";
export const TERMINAL_VIEW = "terminal";

/** The session sheet behind the header's title button: how to view the session, its id, and stopping the agent. */
export function ChatMenu(props: {
  open: boolean;
  onClose: () => void;
  agent: string;
  agentName: string;
  title: string;
  cwd: string;
  /** The plugin views offered besides the chat and the terminal. */
  views: ViewChoice[];
  view: string;
  onView: (id: string) => void;
  /** Greys out the choices other than the current view (the desktop can't switch this session). */
  viewsDisabled?: boolean;
  onRename?: () => void;
  onCopyId?: () => void;
  onStop?: () => void;
  /** The stop button's label, when "Stop the agent" doesn't fit (a terminal interrupts). */
  stopLabel?: string;
  /** Whether to mention the two-finger swipe (a terminal has none). */
  swipeHint?: boolean;
}) {
  const { open, onClose } = props;
  useEscape(open, onClose);
  useBackHandler(open, onClose);

  const choices: (ViewChoice & { icon: React.ReactNode })[] = [
    { id: CHAT_VIEW, label: t("chat"), icon: <ChatIcon size={18} /> },
    ...props.views.map((v) => ({ ...v, icon: <ChatIcon size={18} /> })),
    { id: TERMINAL_VIEW, label: t("chatViewTerminal"), icon: <TerminalIcon /> },
  ];
  const close = (action?: () => void) => () => {
    onClose();
    action?.();
  };

  return (
    <AdaptiveSheet open={open} onClose={onClose} variant="drawer" side="right" label={t("chatMenuTitle")}>
      <div className="tm-grabber" />
      <header className="tm-sheet-head">
        <span className="chat-menu-logo">
          <AgentLogo cli={props.agent} size={18} />
        </span>
        <div className="tm-sheet-titles">
          <h2>{props.title}</h2>
          <p className="mono">
            {props.agentName} · {shortCwd(props.cwd)}
          </p>
        </div>
        <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="chat-menu-body">
        <div className="chat-menu-label">{t("chatViewAs")}</div>
        <div className="chat-menu-group" role="radiogroup" aria-label={t("chatViewAs")}>
          {choices.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === props.view}
              className={c.id === props.view ? "on" : ""}
              disabled={props.viewsDisabled && c.id !== props.view}
              onClick={close(() => c.id !== props.view && props.onView(c.id))}
            >
              {c.icon}
              <span>{c.label}</span>
              {c.id === props.view && <CheckIcon />}
            </button>
          ))}
        </div>
        <div className="chat-menu-group">
          {props.onRename && (
            <button type="button" onClick={close(props.onRename)}>
              <PencilIcon />
              <span>{t("rename")}</span>
            </button>
          )}
          {props.onCopyId && (
            <button type="button" onClick={close(props.onCopyId)}>
              <CopyIcon />
              <span>{t("chatCopyId")}</span>
            </button>
          )}
          <button type="button" className="danger" disabled={!props.onStop} onClick={close(props.onStop)}>
            <StopIcon />
            <span>{props.stopLabel ?? t("chatStopAgent")}</span>
          </button>
        </div>
        {props.swipeHint !== false && <p className="chat-menu-hint">{t("chatSwipeHint")}</p>}
      </div>
    </AdaptiveSheet>
  );
}
