import "./terminal.css";
import "./chat.css";
import "./session-top.css";
import { t } from "./i18n";
import { BackIcon } from "./icons";

/** Shimmering ghost bubbles shown before a chat has anything to show. */
export function ChatSkeleton() {
  return (
    <div className="chat-skeleton" role="status" aria-label={t("loading")}>
      {[false, true, false, true, false].map((user, i) => (
        <div key={i} className={"chat-sk-bub" + (user ? " is-user" : "")} aria-hidden="true">
          <div className="chat-sk-line" />
          {!user && <div className="chat-sk-line is-short" />}
        </div>
      ))}
    </div>
  );
}

/** Phone: a new chat asked of the desktop, shown as its chat page (ghost bubbles, glowing edge) until the desktop lists it and the real one replaces it. */
export function ChatOpening({ label, onBack }: { label: string; onBack: () => void }) {
  const text = t("opening", { name: label });
  return (
    <div className="screen term-screen chat-screen has-floating-top">
      <div className="chat-screen-load" role="progressbar" aria-busy="true" aria-label={text} />
      <header className="st-top is-floating">
        <button type="button" className="st-btn" aria-label={t("back")} onClick={onBack}>
          <BackIcon />
        </button>
        <div className="st-capsule" title={text}>
          <i className="st-dot is-starting" aria-hidden="true" />
          <b>{label}</b>
        </div>
      </header>
      <div className="chat-thread-wrap">
        <div className="chat-thread">
          <div className="chat-thread-inner">
            <ChatSkeleton />
          </div>
        </div>
      </div>
    </div>
  );
}
