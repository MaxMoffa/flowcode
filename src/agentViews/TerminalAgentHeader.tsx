import { useI18n } from "../i18n";
import { CLI_INFO, type AgentCli } from "../agents/cliInfo";
import type { AgentSession } from "../agents/agentSessions";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import type { ChatStatus } from "../chat/chatTypes";
import { AgentHeader } from "./AgentHeader";
import { useAgentViews, viewLabel } from "./registry";

interface TerminalAgentHeaderProps {
  cli: AgentCli;
  session: AgentSession;
  /** The tab's name. */
  title: string;
  cwd: string;
  /** Resumes the session in a chat tab shown with this view. */
  onSwitchToChat: (viewId: string) => void;
  /** Interrupts the agent (Esc to its terminal). */
  onStop: () => void;
}

/** The chat's header on top of a terminal tab running an agent, so the user
 * can switch to a chat from the terminal as from the chat to the terminal. */
export function TerminalAgentHeader({ cli, session, title, cwd, onSwitchToChat, onStop }: TerminalAgentHeaderProps) {
  const { t, language } = useI18n();
  const views = useAgentViews();
  const label = CLI_INFO[cli].label;
  const folder = basename(cwd);
  // The CLI's own title leads with a status glyph ("✳ Claude Code", a braille spinner...): the header has its icon and status already.
  const name = title.replace(/^[^\p{L}\p{N}]+/u, "").trim() || label;
  const subtitle = name.toLowerCase() === label.toLowerCase() ? folder : `${label} · ${folder}`;
  const status: ChatStatus = session.status === "busy" || session.status === "waiting" ? session.status : "idle";
  const working = status === "busy" || status === "waiting";
  // The same conditions `switchTerminalToChat` (App.tsx) enforces.
  const chatBlock = session.wsl_distro
    ? t("agentViews.noWsl")
    : !session.session_id
      ? t("agentViews.needsSession")
      : session.status === "busy"
        ? t("agentViews.busy")
        : undefined;

  return (
    <AgentHeader icon={agentCliIcon(cli)} title={name} subtitle={subtitle} status={status} keepFocus>
      {(close) => {
        const act = (action: () => void) => {
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
                  <button key={view.id} type="button" role="menuitemradio" aria-checked className="chat-menu-item" onClick={close}>
                    <span className="chat-menu-check">✓</span>
                    <span>{viewLabel(view, t, language)}</span>
                  </button>
                ) : (
                  <button
                    key={view.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={false}
                    className="chat-menu-item"
                    disabled={!!chatBlock}
                    title={chatBlock}
                    onClick={() => act(() => onSwitchToChat(view.id))}
                  >
                    <span className="chat-menu-check" />
                    <span>{viewLabel(view, t, language)}</span>
                    {view.id === "chat" && <kbd>Ctrl+`</kbd>}
                  </button>
                ),
              )}
            <button
              type="button"
              role="menuitem"
              className="chat-menu-item"
              disabled={!session.session_id}
              onClick={() => act(() => session.session_id && void navigator.clipboard.writeText(session.session_id).catch(() => {}))}
            >
              <span>{t("chat.menu.copyId")}</span>
            </button>
            <div className="chat-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="chat-menu-item is-danger" disabled={!working} onClick={() => act(onStop)}>
              <span>{t("chat.menu.stop")}</span>
            </button>
          </>
        );
      }}
    </AgentHeader>
  );
}
