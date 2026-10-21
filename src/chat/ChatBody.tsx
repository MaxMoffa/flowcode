import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import type { AgentViewProps } from "../agentViews/types";
import { ChatItemView } from "./ChatItems";
import { appendDictation, useDictation } from "./useDictation";
import "./chat.css";

/** Pixels from the bottom within which the column keeps following new content. */
const FOLLOW_SLACK_PX = 80;
/** Suggestions listed under a "/" at once. */
const COMMANDS_SHOWN = 8;

/** The built-in "chat" view: the conversation, tool calls and permission
 * requests in a column, and a composer under it. */
export default function ChatBody({ session: chat, hidden }: AgentViewProps) {
  const { t } = useI18n();
  const { model, phase, queued } = chat;
  const status = model.status;
  const working = status === "busy" || status === "waiting";
  const notice = model.notice;
  const noticeText = notice
    ? t("chat.notice.retrying", {
        reason: notice.category === "rate_limited" ? t("chat.notice.rateLimited") : notice.category,
      }) + (notice.detail ? ` (${notice.detail})` : "")
    : "";

  const [draft, setDraft] = useState("");
  const columnRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation((text) => setDraft((d) => appendDictation(d, text)), !hidden);
  const listening = dictation.state === "listening";
  const followRef = useRef(true);

  // Follow the conversation while the reader is at its end.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (column && followRef.current && !hidden) column.scrollTop = column.scrollHeight;
  }, [model.lastSeq, queued.length, phase, hidden]);

  // Grow the composer with its text, up to the CSS max-height.
  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft, phase, hidden]);

  useEffect(() => {
    if (!hidden) inputRef.current?.focus();
  }, [hidden, phase]);

  const suggestions =
    draft.startsWith("/") && !/\s/.test(draft)
      ? model.commands.filter((c) => c.name.startsWith(draft.slice(1))).slice(0, COMMANDS_SHOWN)
      : [];

  function submit() {
    if (!draft.trim()) return;
    chat.send(draft);
    dictation.stop();
    setDraft("");
    followRef.current = true;
  }

  function insertCommand(name: string) {
    setDraft(`/${name} `);
    inputRef.current?.focus();
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && listening) {
      e.preventDefault();
      dictation.stop();
    } else if (e.key === "Escape" && working) {
      e.preventDefault();
      chat.cancel();
    } else if (e.key === "Tab" && !e.shiftKey && suggestions.length > 0) {
      e.preventDefault();
      insertCommand(suggestions[0].name);
    }
  }

  function onFooterKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (dictation.supported && e.ctrlKey && e.shiftKey && e.code === "Space") {
      e.preventDefault();
      dictation.toggle();
    }
  }

  const mic = dictation.supported && (
    <button
      type="button"
      className={`chat-icon-btn is-mic${draft.trim() ? "" : " is-prominent"}${listening ? " is-listening" : ""}`}
      title={t(listening ? "chat.dictate.stop" : "chat.dictate", { keys: "Ctrl+Shift+Space" })}
      aria-label={t("chat.dictate.label")}
      aria-pressed={listening}
      disabled={phase !== "ready"}
      onClick={dictation.toggle}
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <line x1="12" y1="18" x2="12" y2="21" />
      </svg>
    </button>
  );

  return (
    <>
      <div
        className="chat-column"
        ref={columnRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
        }}
      >
        <div className="chat-content">
          {model.plan && model.plan.length > 0 && (
            <details className="chat-plan" open>
              <summary>
                <span className="chat-plan-title">{t("chat.plan.title")}</span>
                <span className="chat-plan-progress">
                  {t("chat.plan.progress", { done: model.plan.filter((p) => p.status === "completed").length, total: model.plan.length })}
                </span>
              </summary>
              <ul>
                {model.plan.map((entry, i) => (
                  <li key={i} className={`is-${entry.status}`}>
                    <span className="chat-plan-mark" aria-hidden="true" />
                    {entry.content}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {model.items.map((item) => (
            <ChatItemView key={item.id} item={item} onAnswer={chat.answerPermission} />
          ))}
        </div>
      </div>

      <div className="chat-footer" onKeyDown={onFooterKeyDown}>
        {phase === "ready" && status === "exited" ? (
          <div className="chat-exited">
            <span>{t("chat.exited")}</span>
            <button type="button" className="chat-btn is-primary" onClick={chat.restart}>
              {t("chat.restart")}
            </button>
          </div>
        ) : (
          <div className="chat-composer-wrap">
            {notice && (
              <div className="chat-notice" role="status">
                <span className="chat-spinner" aria-hidden="true" />
                <span>{noticeText}</span>
              </div>
            )}
            {queued.length > 0 && (
              <div className="chat-queue">
                {queued.map((text, i) => (
                  <span key={i} className="chat-chip" title={text}>
                    <span className="chat-chip-text">{t("chat.queued", { text })}</span>
                    <button type="button" className="chat-chip-remove" aria-label={t("chat.unqueue")} title={t("chat.unqueue")} onClick={() => chat.unqueue(i)}>
                      {"×"}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {suggestions.length > 0 && (
              <div className="chat-commands" role="listbox">
                {suggestions.map((command) => (
                  <button key={command.name} type="button" role="option" aria-selected={false} className="chat-command" onClick={() => insertCommand(command.name)}>
                    <span className="chat-command-name">/{command.name}</span>
                    {command.description && <span className="chat-command-desc">{command.description}</span>}
                  </button>
                ))}
              </div>
            )}
            {dictation.error && (
              <div className="chat-notice" role="alert">
                <span className="chat-notice-text">{dictation.error}</span>
                <button type="button" className="chat-chip-remove" aria-label={t("chat.dictate.dismiss")} title={t("chat.dictate.dismiss")} onClick={dictation.dismissError}>
                  {"×"}
                </button>
              </div>
            )}
            {listening && (
              <div className="chat-listening" aria-live="polite">
                <span className="chat-listening-label">{t("chat.dictate.listening")}</span>
                {dictation.partial && <span className="chat-listening-text">{dictation.partial}</span>}
              </div>
            )}
            <div className="chat-composer">
              <textarea
                ref={inputRef}
                className="chat-input"
                rows={1}
                aria-label={t("chat.composer.label")}
                placeholder={t("chat.composer.placeholder")}
                value={draft}
                disabled={phase !== "ready"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
              />
              {working && (
                <button type="button" className="chat-icon-btn is-stop" title={t("chat.stop")} aria-label={t("chat.stop")} onClick={chat.cancel}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              )}
              {mic}
              {(draft.trim() || !dictation.supported) && (
                <button
                  type="button"
                  className="chat-icon-btn is-send"
                  title={t("chat.send")}
                  aria-label={t("chat.send")}
                  disabled={phase !== "ready" || !draft.trim()}
                  onClick={submit}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
