import { useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { useOutsideClose } from "../hooks/useOutsideClose";
import type { ChatStatus } from "../chat/chatTypes";
import "../chat/chat.css";

interface AgentHeaderProps {
  icon: ReactNode;
  title: string;
  subtitle: string;
  status: ChatStatus;
  /** The session menu's content (`chat-menu-*` items); `close` shuts the menu. */
  children: (close: () => void) => ReactNode;
  /** Clicking the header must not pull focus away (a terminal below it). */
  keepFocus?: boolean;
}

/** The header of an agent session - icon, name, status - with its discreet
 * session menu. Shared by the chat and by a terminal tab running an agent. */
export function AgentHeader({ icon, title, subtitle, status, children, keepFocus }: AgentHeaderProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useOutsideClose(menuOpen, [menuRef], () => setMenuOpen(false), { escape: true });

  return (
    <div className="chat-header" onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}>
      <div className="chat-menu-anchor" ref={menuRef}>
        <button
          type="button"
          className="chat-session"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t("chat.menu.label")}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="chat-session-icon">{icon}</span>
          <span className="chat-session-title">{title}</span>
          <span className="chat-session-agent">{subtitle}</span>
          <svg className="chat-session-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
        {menuOpen && (
          <div className="chat-menu" role="menu">
            {children(() => setMenuOpen(false))}
          </div>
        )}
      </div>
      <span className="chat-status-text">{t(`chat.status.${status}`)}</span>
      <span className={`chat-status-dot is-${status}`} aria-hidden="true" />
    </div>
  );
}
