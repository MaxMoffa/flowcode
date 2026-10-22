import { Suspense, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import { CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import { useOutsideClose } from "../hooks/useOutsideClose";
import type { ChatStatus } from "../chat/chatTypes";
import { useChat } from "../chat/useChat";
import "../chat/chat.css";
import "./builtins";
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
  onStatus: (status: ChatStatus) => void;
  onViewChange: (viewId: string) => void;
  /** Opens the same session in a terminal tab. */
  onSwitchToTerminal: (sessionId: string) => void;
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
  onSwitchToTerminal,
  onOpenFile,
  onOpenLogin,
}: AgentSessionViewProps) {
  const { t, language } = useI18n();
  const views = useAgentViews();
  const chat = useChat({ agent, cwd, profileId, resumeSessionId, strictResume, onSessionId, onStatus });
  const { model, phase, error, modes, sessionId } = chat;
  const label = CLI_INFO[agent].label;
  const folder = basename(cwd);
  const subtitle = title === label ? folder : `${label} · ${folder}`;
  const status: ChatStatus = phase === "failed" ? "exited" : model.status;
  const working = status === "busy" || status === "waiting";
  const current = resolveAcpView(viewId);
  const View = current.component;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useOutsideClose(menuOpen, [menuRef], () => setMenuOpen(false), { escape: true });

  const currentModeId = model.currentModeId ?? modes?.currentModeId ?? null;

  function onViewKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.ctrlKey && e.key === "`" && sessionId) {
      e.preventDefault();
      onSwitchToTerminal(sessionId);
    }
  }

  /** A view asking for another one; the terminal is a tab of its own. */
  function switchView(id: string) {
    const target = agentView(id);
    if (!target) return;
    if (target.transport === "pty") {
      if (sessionId) onSwitchToTerminal(sessionId);
    } else {
      onViewChange(id);
    }
  }

  function menuAction(action: () => void) {
    setMenuOpen(false);
    action();
  }

  const authRequired = phase === "failed" && !!error?.startsWith(AUTH_PREFIX);

  return (
    <div className="chat-view" style={hidden ? { display: "none" } : undefined} onKeyDown={onViewKeyDown}>
      <div className="chat-header">
        <div className="chat-menu-anchor" ref={menuRef}>
          <button
            type="button"
            className="chat-session"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t("chat.menu.label")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span className="chat-session-icon">{agentCliIcon(agent)}</span>
            <span className="chat-session-title">{title}</span>
            <span className="chat-session-agent">{subtitle}</span>
            <svg className="chat-session-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {menuOpen && (
            <div className="chat-menu" role="menu">
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
                      disabled={!sessionId}
                      onClick={() => menuAction(() => sessionId && onSwitchToTerminal(sessionId))}
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
              {modes && modes.availableModes.length > 0 && (
                <>
                  <div className="chat-menu-caption">{t("chat.menu.mode")}</div>
                  {modes.availableModes.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={mode.id === currentModeId}
                      className="chat-menu-item"
                      title={mode.description}
                      onClick={() => menuAction(() => chat.setMode(mode.id))}
                    >
                      <span className="chat-menu-check">{mode.id === currentModeId ? "✓" : ""}</span>
                      <span>{mode.name}</span>
                    </button>
                  ))}
                </>
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
            </div>
          )}
        </div>
        <span className="chat-status-text">{t(`chat.status.${status}`)}</span>
        <span className={`chat-status-dot is-${status}`} aria-hidden="true" />
      </div>

      {phase === "ready" ? (
        View && (
          <Suspense fallback={null}>
            <View session={chat} agent={agent} hidden={hidden} cwd={cwd} title={title} onSwitchView={switchView} onOpenFile={onOpenFile} />
          </Suspense>
        )
      ) : (
        <div className="chat-column">
          <div className="chat-content">
          {phase === "starting" && (
            <div className="chat-state">
              <span className="chat-spinner" aria-hidden="true" />
              <div>{t("chat.starting", { agent: label })}</div>
              <div className="chat-state-hint">{t("chat.starting.hint")}</div>
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
