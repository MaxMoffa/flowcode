import { Suspense } from "react";
import { useI18n } from "../i18n";
import { AGENT_CLIS, CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import type { ChatStatus } from "../chat/chatTypes";
import "../chat/chat.css";
import "../agentViews/builtins";
import { AgentHeader } from "../agentViews/AgentHeader";
import { ChatViewIcon, CopyIcon, SessionMenuHead, StopIcon, TerminalViewIcon, ViewSwitch } from "../agentViews/SessionMenu";
import { agentView, resolveAcpView } from "../agentViews/registry";
import { expectNewTab, selectRemoteKey, sendToHost, useHost, useHostState } from "./remoteHosts";
import { useRemoteChat } from "./useRemoteChat";
import { RemoteChatImageProvider } from "../chat/chatImages";
import { RemoteLinks } from "./RemoteLinks";
import { openRemoteFile } from "./remoteFiles";
import { subagentHeader, useOpenSubagent } from "../chat/useOpenSubagent";

const isAgentCli = (v: string): v is AgentCli => (AGENT_CLIS as readonly string[]).includes(v);

/** A chat of another PC, shown with the default agent view as if it ran here. */
export function RemoteChatView({ hostId, chatId, hidden }: { hostId: string; chatId: string; hidden: boolean }) {
  const { t } = useI18n();
  const host = useHost(hostId);
  const hostChats = useHostState(hostId).chats;
  const info = hostChats.find((c) => c.chatId === chatId);
  const chat = useRemoteChat(hostId, chatId);
  const View = resolveAcpView(undefined).component;
  const { model, sessionId } = chat;
  const nav = useOpenSubagent(model.items, hidden);

  if (!info) return <div className="chat-view remote-empty" style={hidden ? { display: "none" } : undefined}>{t("remoteHosts.chatGone")}</div>;

  const agent: AgentCli = isAgentCli(info.agent) ? info.agent : "claude";
  const label = CLI_INFO[agent].label;
  const status: ChatStatus = model.status;
  const working = status === "busy" || status === "waiting";
  const canTerminal = !!host?.caps.includes("chat");
  const toTerminal = () => {
    // The chat turns into a terminal tab over there: bring that one to the front when it appears.
    expectNewTab(hostId);
    void sendToHost(hostId, { t: "chatterminal", chatId });
  };

  /** A delegate's card: its chat is a tab of that PC, brought to the front when it is there. */
  const openDelegate = (delegate: { childChatId: string }) => {
    if (hostChats.some((c) => c.chatId === delegate.childChatId)) selectRemoteKey(hostId, `chat:${delegate.childChatId}`);
  };

  /** A view asking for another one; the terminal is the other PC's own tab. */
  function switchView(id: string) {
    if (agentView(id)?.transport === "pty" && canTerminal) toTerminal();
  }

  return (
    <RemoteChatImageProvider hostId={hostId} chatId={chatId}>
      <RemoteLinks hostId={hostId} chatId={chatId} cwd={info.cwd}>
      <div className="chat-view" style={hidden ? { display: "none" } : undefined}>
        <AgentHeader icon={agentCliIcon(agent)} title={info.label} subtitle={`${label} · ${basename(info.cwd)} · ${host?.hostName ?? ""}`} status={status} subagent={nav.sub ? subagentHeader(nav.sub, nav.back) : null}>
          {(close) => {
            const menuAction = (action: () => void) => {
              close();
              action();
            };
            return (
              <>
                <SessionMenuHead title={info.label} lines={[`${label} · ${basename(info.cwd)}`, host?.hostName ?? ""]} path={info.cwd} />
                <ViewSwitch
                  label={t("agentViews.viewAs")}
                  options={[
                    { id: "chat", label: t("agentViews.chat"), icon: <ChatViewIcon />, checked: true, onPick: close },
                    { id: "terminal", label: t("agentViews.terminal"), icon: <TerminalViewIcon />, checked: false, disabled: !canTerminal, title: t("remoteHosts.openAsTerminal"), onPick: () => menuAction(toTerminal) },
                  ]}
                />
                <div className="chat-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="chat-menu-item" disabled={!sessionId} onClick={() => menuAction(() => sessionId && void navigator.clipboard.writeText(sessionId).catch(() => {}))}>
                  <CopyIcon />
                  <span>{t("chat.menu.copyId")}</span>
                </button>
                <div className="chat-menu-sep" role="separator" />
                <button type="button" role="menuitem" className="chat-menu-item is-danger" disabled={!working} onClick={() => menuAction(chat.cancel)}>
                  <StopIcon />
                  <span>{t("chat.menu.stop")}</span>
                </button>
              </>
            );
          }}
        </AgentHeader>

        {chat.phase === "ready" ? (
          View && (
            <Suspense fallback={null}>
              <View session={chat} agent={agent} hidden={hidden} cwd={info.cwd} title={info.label} onSwitchView={switchView} onOpenFile={(path) => openRemoteFile({ hostId, path })} openSubagent={nav.sub} onOpenSubagent={nav.open} onOpenDelegate={openDelegate} />
            </Suspense>
          )
        ) : (
          <div className="chat-column">
            <div className="chat-content">
              <div className="chat-state">
                <span className="chat-spinner" aria-hidden="true" />
                <div>{t("remoteHosts.loadingChat")}</div>
              </div>
            </div>
          </div>
        )}
      </div>
      </RemoteLinks>
    </RemoteChatImageProvider>
  );
}
