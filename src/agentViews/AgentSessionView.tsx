import { Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useI18n } from "../i18n";
import { CLI_INFO, cliName, type AgentCli } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { FileLinkWslContext } from "../lib/fileLinks";
import { basename } from "../lib/path";
import type { ChatStatus } from "../chat/chatTypes";
import { delegatesOf, type DelegateInfo } from "../chat/chatModel";
import { publishTabDelegation } from "../chat/delegateStore";
import { interruptDelegates, recordDelegates } from "../agents/delegateHistory";
import { useChat } from "../chat/useChat";
import { LocalChatImageProvider } from "../chat/chatImages";
import { subagentHeader, useOpenSubagent } from "../chat/useOpenSubagent";
import "../chat/chat.css";
import "./builtins";
import { AgentHeader } from "./AgentHeader";
import { agentView, resolveAcpView, useAgentViews, viewLabel } from "./registry";
import { isProviderAuthError } from "../../shared/providerAuth";

interface AgentSessionViewProps {
  agent: AgentCli;
  cwd: string;
  profileId?: string;
  /** Resumes this session instead of starting a new one. */
  resumeSessionId?: string;
  /** The resumed session must load: fail rather than start a fresh one (a terminal handing its agent over). */
  strictResume?: boolean;
  /** The shell id the agent runs where (see `ChatTab.shell`); absent = the configured shell. */
  shell?: string;
  /** When the tab's conversation last had real activity (ms epoch), for a resumed chat: the replayed events only carry the load time. */
  lastActiveAt?: number;
  /** Shows a delegated child's chat that already runs (read-only, owned by its orchestrator) instead of starting one; closing the tab only detaches. */
  attachChatId?: string;
  /** The WSL distro the attached chat runs in. */
  attachWslDistro?: string | null;
  /** The tab this session is the shown conversation of: it publishes its delegation state for the agents panel under it. */
  tabId?: string;
  /** The app tab the session lives in, shown or not: pages its agent opens wait for that tab. */
  openTabId?: string;
  /** A delegate card or request asked for its chat: opens its tab, next to this one. */
  onOpenDelegate?: (delegate: DelegateInfo, wslDistro: string | null) => void;
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
  onCloser: (closer: { close: () => Promise<void>; restart: () => void; clear: () => void; compact: () => void } | null) => void;
  /** Opens the session in a terminal tab: resumes `sessionId`, or starts a fresh one when it is null (nothing was said yet, so there is nothing on disk to resume). */
  onSwitchToTerminal: (sessionId: string | null, wslDistro?: string | null) => void;
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
  shell,
  lastActiveAt,
  attachChatId,
  attachWslDistro,
  tabId,
  openTabId,
  onOpenDelegate,
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
  const chat = useChat({ agent, cwd, profileId, resumeSessionId, strictResume, shell, attachChatId, attachWslDistro, openTabId, initialActivityAt: lastActiveAt, onSessionId, onStatus });
  const { model, phase, error, sessionId } = chat;
  // A new chat starting shows the conversation (the frog's pond); a resumed one waits behind the spinner.
  const showView = phase === "ready" || (phase === "starting" && !chat.resumed);
  // Keep the composer mounted while restarting so its unsent draft and attachments survive authentication.
  const mountedViewRef = useRef(false);
  if (showView) mountedViewRef.current = true;
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
  // The agents panel and the History read the delegation state from here.
  const { items: modelItems, delegateRequests, task } = model;
  useEffect(() => {
    if (!tabId) return;
    const delegates = delegatesOf(modelItems);
    publishTabDelegation(tabId, { delegates, requests: delegateRequests, task, wslDistro: chat.wslDistro, ended: status === "exited" });
    if (sessionId && !chat.attached) {
      recordDelegates(sessionId, delegates);
      if (status === "exited") interruptDelegates(sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, modelItems, delegateRequests, task, sessionId, chat.wslDistro, status]);
  useEffect(() => (tabId ? () => publishTabDelegation(tabId, null) : undefined), [tabId]);
  useEffect(() => {
    if (!chat.chatId || !sessionId || chat.attached) return;
    return () => interruptDelegates(sessionId);
  }, [chat.chatId, sessionId, chat.attached]);
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
  // A phone sending "/clear" for this chat.
  const { chatId, clear: clearChat } = chat;
  const clearRef = useRef(clearChat);
  clearRef.current = clearChat;
  useEffect(() => {
    if (!chatId) return;
    const unlisten = getCurrentWebviewWindow().listen<{ chatId: string }>("remote://chat-clear", (e) => {
      if (e.payload.chatId === chatId) clearRef.current();
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [chatId]);
  const { close: closeChat, restart: restartChat, send: sendChat } = chat;
  // The agent panel's "compact": "/compact" goes out as a normal prompt, like the composer's.
  const compactChat = useCallback(() => sendChat("/compact"), [sendChat]);
  useEffect(() => {
    onCloser({ close: closeChat, restart: restartChat, clear: clearChat, compact: compactChat });
    return () => onCloser(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeChat, restartChat, clearChat, compactChat]);
  /** Switching needs the session id only when there is a conversation to resume, and never mid-turn: the terminal would resume a session the agent is still writing. */
  // Not while starting either: the agent is still being spawned (and, resumed, loading the session), and the terminal would race it for the session.
  // Not for an attached delegate: its session is its orchestrator's, there is nothing here to hand to a terminal.
  const canSwitch = !chat.attached && phase !== "starting" && !working && (!talked || !!sessionId);
  const switchToTerminal = () => onSwitchToTerminal(talked ? (sessionId ?? null) : null, chat.wslDistro);

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

  const authRequired = chat.authRequired || (phase === "failed" && !!error && isProviderAuthError(error));

  return (
    <FileLinkWslContext.Provider value={chat.wslDistro ?? null}>
      <LocalChatImageProvider chatId={chat.chatId}>
        <div className="chat-view" style={hidden ? { display: "none" } : undefined} onKeyDown={onViewKeyDown}>
          <AgentHeader icon={agentCliIcon(agent)} title={title} subtitle={subtitle} status={status} subagent={subHeader} tag={model.task ? { text: t("chat.delegate.from", { agent: cliName(model.task.parentAgent) }), title: t("chat.delegate.fromHint") } : null}>
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

          {authRequired && showView && (
            <div className="chat-auth-banner" role="alert">
              <span className="chat-auth-symbol" aria-hidden="true">!</span>
              <div><strong>{t("chat.auth.title", { agent: label })}</strong><p>{t("chat.auth.body", { agent: label })}</p></div>
              <button type="button" className="chat-btn is-primary" onClick={() => onOpenLogin(CLI_INFO[agent].loginCommand)}>{t("chat.auth.open")}</button>
            </div>
          )}
          {mountedViewRef.current && (
            <div style={{ display: showView ? "contents" : "none" }}>
            {View && (
              <Suspense fallback={null}>
                <View session={chat} agent={agent} hidden={hidden || !showView} cwd={cwd} title={title} onSwitchView={switchView} onOpenFile={onOpenFile} openSubagent={nav.sub} onOpenSubagent={nav.open} onOpenDelegate={onOpenDelegate ? (delegate) => onOpenDelegate(delegate, chat.wslDistro) : undefined} />
              </Suspense>
            )}
            </div>
          )}
          {!showView && (
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
                <div className={`chat-state${authRequired ? " chat-auth-callout" : ""}`}>
                  {authRequired ? (
                    <>
                      <div className="chat-state-title">{t("chat.auth.title", { agent: label })}</div>
                      <span className="chat-auth-symbol" aria-hidden="true">!</span>
                      <div>{t("chat.auth.body", { agent: label })}</div>
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
      </LocalChatImageProvider>
    </FileLinkWslContext.Provider>
  );
}
