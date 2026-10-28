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
  /** A subagent's chat is open: the header shows a back arrow and its breadcrumb. */
  subagent?: { label: string; state: "running" | "done" | "failed"; onBack: () => void } | null;
}

/** The header of an agent session - icon, name, status - with its discreet
 * session menu. Shared by the chat and by a terminal tab running an agent. */
export function AgentHeader({ icon, title, subtitle, status, children, keepFocus, subagent }: AgentHeaderProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useOutsideClose(menuOpen, [menuRef], () => setMenuOpen(false), { escape: true });

  return (
    <div className="chat-header" onMouseDown={keepFocus ? (e) => e.preventDefault() : undefined}>
      {subagent && (
        <button type="button" className="chat-back" title={`${t("chat.subagent.back")} (Esc)`} aria-label={t("chat.subagent.back")} onClick={subagent.onBack}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M19 12H5M11 6l-6 6 6 6" />
          </svg>
        </button>
      )}
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
          {!subagent && <span className="chat-session-agent">{subtitle}</span>}
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
      {subagent && (
        <span className="chat-crumb" title={subagent.label}>
          <span className="chat-crumb-sep" aria-hidden="true">{"›"}</span>
          <span className="chat-crumb-label">{subagent.label}</span>
          {subagent.state === "running" ? (
            <span className="chat-spinner" aria-hidden="true" />
          ) : (
            <span className={subagent.state === "failed" ? "chat-sub-mark is-failed" : "chat-sub-mark"} title={t(subagent.state === "failed" ? "chat.subagent.failed" : "chat.subagent.done")}>
              {subagent.state === "failed" ? "✕" : "✓"}
            </span>
          )}
        </span>
      )}
      <span className="chat-status-text">{t(`chat.status.${status}`)}</span>
      <span className={`chat-status-dot is-${status}`} aria-hidden="true" />
    </div>
  );
}
