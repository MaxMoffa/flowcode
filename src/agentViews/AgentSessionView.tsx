import { Suspense, useEffect, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useI18n } from "../i18n";
import { CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import type { ChatStatus } from "../chat/chatTypes";
import { useChat } from "../chat/useChat";
import { subagentHeader, useOpenSubagent } from "../chat/useOpenSubagent";
import "../chat/chat.css";
import "./builtins";
import { AgentHeader } from "./AgentHeader";
import { agentView, resolveAcpView, useAgentViews, viewLabel } from "./registry";

const AUTH_PREFIX = "auth_required:";

interface AgentSessionViewProps {
  agent: AgentCli;
  cwd: string;
  profileId?: string;
  /** Resumes this session instead of starting a new one. */
  resumeSessionId?: string;
  /** The resumed session must load: fail rather than start a fresh one (a terminal handing its agent over). */
  strictResume?: boolean;
  /** The registered view the session is shown with (absent: the default). */
  viewId?: string;
  /** Another tab is in front: the view stays mounted (the agent keeps running). */
  hidden: boolean;
  /** The tab's name, shown in the header. */
  title: string;
  onSessionId: (id: string) => void;
  onStatus: (status: ChatStatus, error?: string | null) => void;
  onViewChange: (viewId: string) => void;
  /** Whether the session has a conversation to resume: true once the first prompt was sent, false when a resume fell back to a fresh session. */
  onTalked: (talked: boolean) => void;
  /** The view hands over how to end its agent (null when it goes): the terminal taking the session over waits for it. */
  onCloser: (closer: { close: () => Promise<void>; restart: () => void } | null) => void;
  /** Opens the session in a terminal tab: resumes `sessionId`, or starts a fresh one when it is null (nothing was said yet, so there is nothing on disk to resume). */
  onSwitchToTerminal: (sessionId: string | null) => void;
  /** Opens a file of the project in an editor tab. */
  onOpenFile: (path: string) => void;
  /** Runs the agent's sign-in command in a terminal. */
  onOpenLogin: (command: string) => void;
}

/** Hosts a session with a coding agent: owns the session and the header with
 * its discreet session menu, and shows the conversation through the
 * registered view picked for it (see src/agentViews). */
export function AgentSessionView({
  agent,
  cwd,
  profileId,
  resumeSessionId,
  strictResume,
  viewId,
  hidden,
  title,
  onSessionId,
  onStatus,
  onViewChange,
  onTalked,
  onCloser,
  onSwitchToTerminal,
  onOpenFile,
  onOpenLogin,
}: AgentSessionViewProps) {
  const { t, language } = useI18n();
  const views = useAgentViews();
  const chat = useChat({ agent, cwd, profileId, resumeSessionId, strictResume, onSessionId, onStatus });
  const { model, phase, error, sessionId } = chat;
  const label = CLI_INFO[agent].label;
  const folder = basename(cwd);
  const subtitle = title === label ? folder : `${label} · ${folder}`;
  const status: ChatStatus = phase === "failed" ? "exited" : model.status;
  const working = status === "busy" || status === "waiting";
  // The first start downloads the adapter only when Flowcode has none installed yet.
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (phase !== "starting") return;
    let live = true;
    invoke<boolean>("chat_adapter_ready", { agent })
      .then((ready) => live && setDownloading(!ready))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [phase, agent]);
  const nav = useOpenSubagent(model.items, hidden);
  const subHeader = nav.sub ? subagentHeader(nav.sub, nav.back) : null;
  const current = resolveAcpView(viewId);
  const View = current.component;

  // A conversation exists once a prompt was sent, or when the chat resumed one
  // (`chat.resumed`: `resumeSessionId` at mount - it also fills in later with
  // the new session's own id). A resume whose load failed fell back to a new,
  // empty session: nothing to resume there.
  const talked = (chat.resumed && (phase !== "ready" || chat.loaded)) || model.items.some((item) => item.type === "user");
  useEffect(() => {
    onTalked(talked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [talked]);
  const { close: closeChat, restart: restartChat } = chat;
  useEffect(() => {
    onCloser({ close: closeChat, restart: restartChat });
    return () => onCloser(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeChat, restartChat]);
  /** Switching needs the session id only when there is a conversation to resume, and never mid-turn: the terminal would resume a session the agent is still writing. */
  // Not while starting either: the agent is still being spawned (and, resumed, loading the session), and the terminal would race it for the session.
  const canSwitch = phase !== "starting" && !working && (!talked || !!sessionId);
  const switchToTerminal = () => onSwitchToTerminal(talked ? (sessionId ?? null) : null);

  function onViewKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey && e.key === "`" && canSwitch) {
      e.preventDefault();
      switchToTerminal();
    }
  }

  /** A view asking for another one; the terminal is a tab of its own. */
  function switchView(id: string) {
    const target = agentView(id);
    if (!target) return;
    if (target.transport === "pty") {
      if (canSwitch) switchToTerminal();
    } else {
      onViewChange(id);
    }
  }

  const authRequired = phase === "failed" && !!error?.startsWith(AUTH_PREFIX);

  return (
    <div className="chat-view" style={hidden ? { display: "none" } : undefined} onKeyDown={onViewKeyDown}>
      <AgentHeader icon={agentCliIcon(agent)} title={title} subtitle={subtitle} status={status} subagent={subHeader}>
        {(close) => {
          const menuAction = (action: () => void) => {
            close();
            action();
          };
          return (
            <>
              <div className="chat-menu-caption">{t("agentViews.viewAs")}</div>
              {views
                .filter((view) => view.devices.includes("desktop"))
                .map((view) =>
                  view.transport === "pty" ? (
                    <button
                      key={view.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={false}
                      className="chat-menu-item"
                      disabled={!canSwitch}
                      title={working ? t("chat.menu.stopFirst") : undefined}
                      onClick={() => menuAction(switchToTerminal)}
                    >
                      <span className="chat-menu-check" />
                      <span>{viewLabel(view, t, language)}</span>
                      <kbd>Ctrl+`</kbd>
                    </button>
                  ) : (
                    <button
                      key={view.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={view.id === current.id}
                      className="chat-menu-item"
                      onClick={() => menuAction(() => onViewChange(view.id))}
                    >
                      <span className="chat-menu-check">{view.id === current.id ? "✓" : ""}</span>
                      <span>{viewLabel(view, t, language)}</span>
                    </button>
                  ),
                )}
              <button
                type="button"
                role="menuitem"
                className="chat-menu-item"
                disabled={!sessionId}
                onClick={() => menuAction(() => sessionId && void navigator.clipboard.writeText(sessionId).catch(() => {}))}
              >
                <span>{t("chat.menu.copyId")}</span>
              </button>
              <div className="chat-menu-sep" role="separator" />
              <button type="button" role="menuitem" className="chat-menu-item is-danger" disabled={!working} onClick={() => menuAction(chat.cancel)}>
                <span>{t("chat.menu.stop")}</span>
              </button>
            </>
          );
        }}
      </AgentHeader>

      {phase === "ready" ? (
        View && (
          <Suspense fallback={null}>
            <View session={chat} agent={agent} hidden={hidden} cwd={cwd} title={title} onSwitchView={switchView} onOpenFile={onOpenFile} openSubagent={nav.sub} onOpenSubagent={nav.open} />
          </Suspense>
        )
      ) : (
        <div className="chat-column">
          <div className="chat-content">
          {phase === "starting" && (
            <div className="chat-state">
              <span className="chat-spinner" aria-hidden="true" />
              <div>{t("chat.starting", { agent: label })}</div>
              {downloading && <div className="chat-state-hint">{t("chat.starting.hint")}</div>}
            </div>
          )}
          {phase === "failed" && (
            <div className="chat-state">
              {authRequired ? (
                <>
                  <div className="chat-state-title">{t("chat.auth.title", { agent: label })}</div>
                  <div>{t("chat.auth.body", { agent: label, command: CLI_INFO[agent].loginCommand })}</div>
                  <div className="chat-state-actions">
                    <button type="button" className="chat-btn is-primary" onClick={() => onOpenLogin(CLI_INFO[agent].loginCommand)}>
                      {t("chat.auth.open")}
                    </button>
                    <button type="button" className="chat-btn" onClick={chat.restart}>
                      {t("chat.retry")}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="chat-state-title">{t("chat.failed")}</div>
                  <div className="chat-error" role="alert">
                    {error}
                  </div>
                  <div className="chat-state-actions">
                    <button type="button" className="chat-btn is-primary" onClick={chat.restart}>
                      {t("chat.retry")}
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          </div>
        </div>
      )}
    </div>
  );
}
