import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import ChatModeSelect from "./ChatModeSelect";
import ChatModelSelect from "./ChatModelSelect";
import type { AgentViewProps } from "../agentViews/types";
import { ChatItemView, PaperclipIcon, PermissionCard, ToolGroup } from "./ChatItems";
import { buildTimeline, liveTool } from "./chatTimeline";
import type { ChatAttachment } from "./chatTypes";
import { FrogThinking } from "../../shared/FrogThinking";
import { appendDictation, useDictation } from "./useDictation";
import "./chat.css";

/** Playful verbs the thinking line cycles through while no tool runs. */
const THINKING_VERBS = [
  "chat.thinking.verb1",
  "chat.thinking.verb2",
  "chat.thinking.verb3",
  "chat.thinking.verb4",
  "chat.thinking.verb5",
  "chat.thinking.verb6",
  "chat.thinking.verb7",
  "chat.thinking.verb8",
] as const;

/** Pixels from the bottom within which the column keeps following new content. */
const FOLLOW_SLACK_PX = 80;
/** Suggestions listed under a "/" at once. */
const COMMANDS_SHOWN = 8;
/** At most this many attachments per message, each up to this size. */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Heights of the bars of the listening waveform. */
const WAVE_BARS = [7, 14, 20, 11, 18, 8, 16, 10];

/** A bar's height in px: flat-ish while quiet, its full height at the loudest. */
function waveHeight(full: number, level: number): number {
  return Math.round(3 + (full - 3) * Math.min(1, level));
}

/** Reads a file into an attachment: its bytes as base64 (no `data:` prefix). */
function readAttachment(file: File): Promise<ChatAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(file.name));
    reader.onload = () => {
      const url = String(reader.result);
      resolve({ name: file.name || "attachment", mime: file.type || "application/octet-stream", data: url.slice(url.indexOf(",") + 1) });
    };
    reader.readAsDataURL(file);
  });
}

function formatTimer(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The built-in "chat" view: the conversation as a timeline (messages, tool
 * activity on a rail, permission requests) and a floating composer under it. */
export default function ChatBody({ session: chat, agent, hidden }: AgentViewProps) {
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
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation((text) => setDraft((d) => appendDictation(d, text)), !hidden);
  const listening = dictation.state === "listening";
  const followRef = useRef(true);

  // Seconds spent listening, for the timer in the composer.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!listening) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [listening]);

  const timeline = buildTimeline(model.items);
  const pending = model.items.filter((i): i is Extract<typeof i, { type: "permission" }> => i.type === "permission" && i.resolved === undefined);
  const lastSegment = timeline[timeline.length - 1];
  const liveGroup = model.turnActive && lastSegment?.type === "group" ? lastSegment : null;
  const running = liveTool(model.items);
  const showLive = working && !notice && pending.length === 0;
  const liveText = running?.title ?? running?.kind ?? null;

  // Follow the conversation while the reader is at its end.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (column && followRef.current && !hidden) column.scrollTop = column.scrollHeight;
  }, [model.lastSeq, queued.length, phase, hidden, pending.length]);
  // ...and when the content grows later, with no new event: an expanded
  // step, a link preview or a code block laid out after the render above.
  useEffect(() => {
    const column = columnRef.current;
    const content = contentRef.current;
    if (!column || !content || hidden || typeof ResizeObserver === "undefined") return;
    const follow = () => {
      if (followRef.current) column.scrollTop = column.scrollHeight;
    };
    const ro = new ResizeObserver(follow);
    ro.observe(column);
    ro.observe(content);
    return () => ro.disconnect();
  }, [hidden, phase]);

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

  /** Reads the files into attachments, refusing the ones past the caps with a notice. */
  async function addFiles(files: File[]) {
    if (files.length === 0 || !chat.canAttach) return;
    let room = MAX_ATTACHMENTS - attachments.length;
    const accepted: File[] = [];
    let error: string | null = null;
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) error = t("chat.attach.tooBig", { name: file.name });
      else if (room <= 0) error = t("chat.attach.tooMany");
      else {
        accepted.push(file);
        room--;
      }
    }
    setAttachError(error);
    try {
      const read = await Promise.all(accepted.map(readAttachment));
      setAttachments((a) => [...a, ...read].slice(0, MAX_ATTACHMENTS));
    } catch (err) {
      setAttachError(String(err));
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.files);
    if (files.length === 0 || !chat.canAttach) return;
    e.preventDefault();
    void addFiles(files);
  }

  const dropHandlers = chat.canAttach
    ? {
        onDragOver: (e: DragEvent<HTMLElement>) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(true);
        },
        onDragLeave: (e: DragEvent<HTMLElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        },
        onDrop: (e: DragEvent<HTMLElement>) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragOver(false);
          void addFiles(Array.from(e.dataTransfer.files));
        },
      }
    : {};

  function submit() {
    if (!draft.trim() && attachments.length === 0) return;
    // The dictation session is disowned before the draft clears, so a phrase
    // it flushes late can't land in the next draft; what it was still hearing
    // goes out with this message.
    chat.send(appendDictation(draft, dictation.discard()), attachments);
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    followRef.current = true;
  }

  function insertCommand(name: string) {
    setDraft(`/${name} `);
    inputRef.current?.focus();
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && e.ctrlKey && working && (draft.trim() || attachments.length > 0) && !e.nativeEvent.isComposing) {
      // Send now: queue the draft and force it, interrupting the turn.
      e.preventDefault();
      const index = queued.length;
      submit();
      chat.force(index);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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

  // While the agent works an empty composer offers to stop it; with text it queues the message.
  const canStop = working && draft.trim() === "" && attachments.length === 0;

  return (
    <>
      <div
        className="chat-column"
        ref={columnRef}
        {...dropHandlers}
        onScroll={(e) => {
          const el = e.currentTarget;
          followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
        }}
      >
        <div className="chat-content" ref={contentRef}>
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
          {timeline.map((segment) =>
            segment.type === "group" ? (
              <ToolGroup key={segment.id} steps={segment.steps} live={segment === liveGroup} />
            ) : (
              <ChatItemView key={segment.item.id} item={segment.item} onAnswer={chat.answerPermission} />
            ),
          )}
        </div>
      </div>

      <div className="chat-footer" onKeyDown={onFooterKeyDown} {...dropHandlers}>
        {phase === "ready" && status === "exited" ? (
          <div className="chat-exited">
            <span>{t("chat.exited")}</span>
            <button type="button" className="chat-btn is-primary" onClick={chat.restart}>
              {t("chat.restart")}
            </button>
          </div>
        ) : (
          <div className="chat-composer-wrap">
            {pending.map((item) => (
              <PermissionCard key={item.id} item={item} onAnswer={chat.answerPermission} />
            ))}
            {notice && (
              <div className="chat-live" role="status">
                <span className="chat-spinner" aria-hidden="true" />
                <span className="chat-live-text">{noticeText}</span>
              </div>
            )}
            {showLive && (
              <FrogThinking
                activity={liveText}
                verbs={THINKING_VERBS.map((k) => t(k))}
                startedAt={model.turn?.startedAt}
                outChars={model.turn?.outChars}
                tokensLabel={(n) => t("chat.thinking.tokens", { n })}
                tokensTitle={t("chat.thinking.tokensTitle")}
                stopHint={t("chat.thinking.stop")}
              />
            )}
            {queued.length > 0 && (
              <div className="chat-queue">
                {queued.map(({ text, attachments: files }, i) => (
                  <span key={i} className="chat-chip" title={text}>
                    <span className="chat-chip-text">{t("chat.queued", { text: files.length > 0 ? `${text} (+${files.length})` : text })}</span>
                    <button type="button" className="chat-chip-remove" aria-label={t("chat.forceSend")} title={`${t("chat.forceSend")} (Ctrl+Enter)`} onClick={() => chat.force(i)}>
                      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                      </svg>
                    </button>
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
            {attachError && (
              <div className="chat-notice" role="alert">
                <span className="chat-notice-text">{attachError}</span>
                <button type="button" className="chat-chip-remove" aria-label={t("chat.dictate.dismiss")} title={t("chat.dictate.dismiss")} onClick={() => setAttachError(null)}>
                  {"×"}
                </button>
              </div>
            )}
            {attachments.length > 0 && (
              <div className="chat-queue">
                {attachments.map((file, i) => (
                  <span key={i} className="chat-chip" title={file.name}>
                    {file.mime.startsWith("image/") ? (
                      <img className="chat-chip-thumb" src={`data:${file.mime};base64,${file.data}`} alt="" />
                    ) : (
                      <PaperclipIcon size={11} />
                    )}
                    <span className="chat-chip-text">{file.name}</span>
                    <button type="button" className="chat-chip-remove" aria-label={t("chat.attach.remove")} title={t("chat.attach.remove")} onClick={() => setAttachments((a) => a.filter((_, j) => j !== i))}>
                      {"×"}
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className={`chat-composer${listening ? " is-listening" : ""}${dragOver ? " is-dragover" : ""}`} data-drop-label={t("chat.attach.drop")}>
              {listening && (
                <div className="chat-listening" aria-live="polite">
                  <span className="chat-wave" aria-hidden="true">
                    {WAVE_BARS.map((h, i) => (
                      <span key={i} className="chat-wave-bar" style={{ height: waveHeight(h, dictation.level) }} />
                    ))}
                  </span>
                  <span className="chat-listening-meta">
                    {formatTimer(seconds)} {"·"} {t("chat.dictate.escHint")}
                  </span>
                  {dictation.partial && <span className="chat-listening-text">{dictation.partial}</span>}
                </div>
              )}
              <textarea
                ref={inputRef}
                className="chat-input"
                rows={1}
                aria-label={t("chat.composer.label")}
                placeholder={listening ? "" : t("chat.composer.placeholder")}
                value={draft}
                disabled={phase !== "ready"}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onComposerKeyDown}
                onPaste={onPaste}
              />
              <div className="chat-composer-actions">
                <ChatModeSelect chat={chat} agent={agent} />
                <ChatModelSelect chat={chat} />
                <span className="chat-actions-spacer" />
                {chat.canAttach && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(e) => {
                        void addFiles(Array.from(e.target.files ?? []));
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      className="chat-icon-btn"
                      title={t("chat.attach")}
                      aria-label={t("chat.attach")}
                      disabled={phase !== "ready"}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <PaperclipIcon size={19} />
                    </button>
                  </>
                )}
                {dictation.supported && (
                  <button
                    type="button"
                    className={`chat-icon-btn is-mic${listening ? " is-listening" : ""}`}
                    title={t(listening ? "chat.dictate.stop" : "chat.dictate", { keys: "Ctrl+Shift+Space" })}
                    aria-label={t("chat.dictate.label")}
                    aria-pressed={listening}
                    disabled={phase !== "ready"}
                    onClick={dictation.toggle}
                  >
                    <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="3" width="6" height="11" rx="3" />
                      <path d="M5 11a7 7 0 0 0 14 0" />
                      <line x1="12" y1="18" x2="12" y2="21" />
                    </svg>
                  </button>
                )}
                {canStop ? (
                  <button type="button" className="chat-icon-btn is-send is-stop" title={t("chat.stop")} aria-label={t("chat.stop")} onClick={chat.cancel}>
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none" aria-hidden="true">
                      <rect x="6" y="6" width="12" height="12" rx="2" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="button"
                    className="chat-icon-btn is-send"
                    title={t("chat.send")}
                    aria-label={t("chat.send")}
                    disabled={phase !== "ready" || (!draft.trim() && attachments.length === 0)}
                    onClick={submit}
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
