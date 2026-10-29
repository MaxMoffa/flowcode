import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import ChatModeSelect from "./ChatModeSelect";
import ChatModelSelect from "./ChatModelSelect";
import type { AgentViewProps } from "../agentViews/types";
import { ChatItemView, PaperclipIcon, PermissionCard, SubagentRow, ToolGroup } from "./ChatItems";
import { buildTimeline, isGuardianReview, liveTool, subagentPrompt, subagentState, subagentTimeline } from "./chatTimeline";
import { CLI_INFO } from "../agents/cliInfo";
import type { ChatAttachment, ChatCommand } from "./chatTypes";
import { ChatMarkdown } from "./ChatMarkdown";
import { FrogThinking } from "../../shared/FrogThinking";
import { appendDictation, TRANSCRIBING_MARKER, useDictation } from "./useDictation";
import { DictationSetupDialog } from "./DictationSetupDialog";
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
/** Circumference of the download ring around the mic (r = 15 in its 34-unit box). */
const RING_LENGTH = 2 * Math.PI * 15;

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
export default function ChatBody({ session: chat, agent, hidden, openSubagent: sub = null, onOpenSubagent }: AgentViewProps) {
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
  const dictation = useDictation((text) => setDraft((d) => appendDictation(d, text)), !hidden && !sub);
  const listening = dictation.state === "listening";
  const followRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  /** Set while the smooth scroll to the end runs, so its scroll events don't flash the jump button. */
  const glidingRef = useRef(false);

  // Seconds spent listening, for the timer in the composer.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!listening) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [listening]);

  // An open subagent: its own chat replaces the conversation (the composer too).
  const subState = sub ? subagentState(sub) : null;
  const subId = sub ? sub.id : null;
  const savedScroll = useRef<{ top: number; follow: boolean } | null>(null);
  const prevSubId = useRef<string | null>(null);
  // Stable, so the memoised subagent rows don't re-render with every streamed chunk.
  const openSub = useCallback(
    (id: string) => {
      const column = columnRef.current;
      savedScroll.current = column ? { top: column.scrollTop, follow: followRef.current } : null;
      onOpenSubagent?.(id);
    },
    [onOpenSubagent],
  );
  // Entering shows the subagent's end; going back restores where the conversation was.
  useLayoutEffect(() => {
    const column = columnRef.current;
    const was = prevSubId.current;
    prevSubId.current = subId;
    if (!column || was === subId) return;
    if (subId && !was) {
      followRef.current = true;
      column.scrollTop = column.scrollHeight;
      setAtBottom(true);
    } else if (!subId && was && savedScroll.current) {
      followRef.current = savedScroll.current.follow;
      column.scrollTop = savedScroll.current.follow ? column.scrollHeight : savedScroll.current.top;
      setAtBottom(savedScroll.current.follow);
    }
  }, [subId]);

  const mainTimeline = useMemo(() => (sub ? null : buildTimeline(model.items)), [sub, model.items]);
  const subTimeline = useMemo(() => (sub ? subagentTimeline(sub) : null), [sub]);
  const timeline = subTimeline ?? mainTimeline ?? [];
  const pending = model.items.filter((i): i is Extract<typeof i, { type: "permission" }> => i.type === "permission" && i.resolved === undefined);
  const lastSegment = timeline[timeline.length - 1];
  const liveGroup = (sub ? !!subState?.running : model.turnActive) && lastSegment?.type === "group" ? lastSegment : null;
  const running = liveTool(sub ? sub.children : model.items);
  const showLive = (sub ? !!subState?.running : working) && !notice && pending.length === 0;
  const liveText = running && isGuardianReview(running) ? t("chat.guardian.checking") : (running?.title ?? running?.kind ?? null);

  // Follow the conversation while the reader is at its end.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (column && followRef.current && !hidden) column.scrollTop = column.scrollHeight;
  }, [model.lastSeq, queued.length, phase, hidden, pending.length, subId]);
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
  }, [draft, phase, hidden, subId]);

  useEffect(() => {
    if (!hidden && !subId) inputRef.current?.focus();
  }, [hidden, phase, subId]);

  // The "/" menu: client-side commands first (ours wins over an agent command of the same name), then the agent's.
  const builtins: ChatCommand[] = chat.clear ? [{ name: "clear", description: t("chat.cmd.clear") }] : [];
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();
  const suggestions =
    draft.startsWith("/") && !/\s/.test(draft) && dismissedFor !== draft
      ? [...builtins, ...model.commands.filter((c) => !builtins.some((b) => b.name === c.name))]
          .filter((c) => c.name.startsWith(draft.slice(1)))
          .slice(0, COMMANDS_SHOWN)
      : [];
  const menuOpen = suggestions.length > 0;
  const suggestionKey = suggestions.map((c) => c.name).join("\n");
  const active = Math.min(activeIndex, Math.max(0, suggestions.length - 1));
  useEffect(() => {
    setActiveIndex(0);
  }, [suggestionKey]);
  useEffect(() => {
    if (menuOpen) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, active, listId]);

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

  /** "/clear": a new conversation in this tab (the running turn, if any, ends with the old agent). */
  function runClear() {
    if (!chat.clear) return;
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    dictation.discard();
    chat.clear();
    followRef.current = true;
    setAtBottom(true);
  }

  function jumpToEnd() {
    const column = columnRef.current;
    followRef.current = true;
    glidingRef.current = true;
    setAtBottom(true);
    column?.scrollTo({ top: column.scrollHeight, behavior: "smooth" });
    window.setTimeout(() => {
      glidingRef.current = false;
    }, 900);
  }

  function submit() {
    if (!draft.trim() && attachments.length === 0) return;
    if (chat.clear && attachments.length === 0 && draft.trim() === "/clear") {
      runClear();
      return;
    }
    // The dictation session is disowned before the draft clears, so a phrase
    // it flushes late can't land in the next draft; what it was still hearing
    // goes out with this message.
    chat.send(appendDictation(draft, dictation.discard()), attachments);
    setDraft("");
    setAttachments([]);
    setAttachError(null);
    followRef.current = true;
    setAtBottom(true);
  }

  /** Takes a queued message back into the composer: its text ahead of the draft, its files among the attachments. */
  function editQueued(i: number) {
    const item = queued[i];
    if (!item) return;
    chat.unqueue(i);
    setDraft((d) => (d.trim() ? `${item.text}\n${d}` : item.text));
    setAttachments((a) => [...item.attachments, ...a].slice(0, MAX_ATTACHMENTS));
    inputRef.current?.focus();
  }

  function insertCommand(name: string) {
    setDraft(`/${name} `);
    inputRef.current?.focus();
  }

  /** Picks a suggestion. `run` (Enter) executes what needs no input: the built-in "clear", or an agent command taking none; otherwise it fills the draft in. */
  function pickCommand(command: ChatCommand, run: boolean) {
    if (command.name === "clear" && builtins.length > 0) {
      if (run) runClear();
      else insertCommand(command.name);
      return;
    }
    if (run && command.input == null) {
      dictation.discard();
      chat.send(`/${command.name}`);
      setDraft("");
      followRef.current = true;
      setAtBottom(true);
      return;
    }
    insertCommand(command.name);
  }

  function onComposerKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && !e.nativeEvent.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((active + step + suggestions.length) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || (e.key === "Tab" && !e.shiftKey)) {
        e.preventDefault();
        pickCommand(suggestions[active], e.key === "Enter");
        return;
      }
      if (e.key === "Escape" && !listening) {
        e.preventDefault();
        setDismissedFor(draft);
        return;
      }
    }
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
      <div className="chat-column-wrap">
      <div
        className="chat-column"
        ref={columnRef}
        {...dropHandlers}
        onScroll={(e) => {
          const el = e.currentTarget;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX;
          if (glidingRef.current) {
            if (near) glidingRef.current = false;
            else return;
          }
          followRef.current = near;
          setAtBottom(near);
        }}
      >
        <div className="chat-content" ref={contentRef}>
          {sub && (
            <div className="chat-user is-task">
              <span className="chat-task-label">{t("chat.subagent.task", { agent: CLI_INFO[agent].label })}</span>
              {subagentPrompt(sub.call) ? <ChatMarkdown text={subagentPrompt(sub.call)} /> : sub.call.title}
            </div>
          )}
          {!sub && model.plan && model.plan.length > 0 && (
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
            segment.type === "subagent" ? (
              <SubagentRow key={segment.item.id} item={segment.item} onOpen={onOpenSubagent ? openSub : undefined} />
            ) : segment.type === "group" ? (
              <ToolGroup key={segment.id} steps={segment.steps} live={segment === liveGroup} />
            ) : (
              <ChatItemView key={segment.item.id} item={segment.item} onAnswer={chat.answerPermission} />
            ),
          )}
          {showLive && (
            <div className="chat-working">
              <FrogThinking
                activity={liveText}
                verbs={THINKING_VERBS.map((k) => t(k))}
                startedAt={model.turn?.startedAt}
                outChars={model.turn?.outChars}
                tokensLabel={(n) => t("chat.thinking.tokens", { n })}
                tokensTitle={t("chat.thinking.tokensTitle")}
                stopHint={t("chat.thinking.stop")}
              />
            </div>
          )}
          {!sub && queued.length > 0 && (
            <>
              <div className="chat-pending-sep">{t("chat.queue.waiting")}</div>
              {queued.map(({ text, attachments: files }, i) => (
                <div key={i} className="chat-pending">
                  <div className="chat-user is-pending">
                    {text}
                    {files.length > 0 && (
                      <div className="chat-user-files">
                        {files.map((file, j) => (
                          <span key={j} className="chat-file" title={file.name}>
                            <PaperclipIcon size={11} />
                            <span className="chat-chip-text">{file.name}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="chat-pending-meta">
                    <span className="chat-pending-pos">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" />
                        <path d="M8 4.5V8l2.2 1.5" />
                      </svg>
                      {i === 0 ? t("chat.queue.next") : t("chat.queue.nth", { n: i + 1 })}
                    </span>
                    <button type="button" className="chat-pending-btn" aria-label={t("chat.forceSend")} title={`${t("chat.forceSend")} (Ctrl+Enter)`} onClick={() => chat.force(i)}>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                      </svg>
                    </button>
                    <button type="button" className="chat-pending-btn" aria-label={t("chat.queue.edit")} title={t("chat.queue.edit")} onClick={() => editQueued(i)}>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M11 2.5 13.5 5 5.5 13H3v-2.5z" />
                      </svg>
                    </button>
                    <button type="button" className="chat-pending-btn" aria-label={t("chat.unqueue")} title={t("chat.unqueue")} onClick={() => chat.unqueue(i)}>
                      {"×"}
                    </button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className={"chat-jump" + (working ? " is-busy" : "")} aria-label={t("chat.jumpToEnd")} title={t("chat.jumpToEnd")} onClick={jumpToEnd}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
        </button>
      )}
      </div>

      <div className="chat-footer" onKeyDown={onFooterKeyDown} {...dropHandlers}>
        {sub ? (
          <div className="chat-composer-wrap">
            {pending.map((item) => (
              <PermissionCard key={item.id} item={item} onAnswer={chat.answerPermission} />
            ))}
            <div className="chat-sub-footer">
              <span>{t("chat.subagent.readOnly", { agent: CLI_INFO[agent].label })}</span>
              <button type="button" className="chat-btn" onClick={() => onOpenSubagent?.(null)}>
                {t("chat.subagent.back")}
              </button>
            </div>
          </div>
        ) : phase === "ready" && status === "exited" ? (
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
            {suggestions.length > 0 && (
              <div className="chat-commands" role="listbox">
                {suggestions.map((command, i) => (
                  <button
                    key={command.name}
                    id={`${listId}-${i}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={i === active}
                    className={`chat-command${i === active ? " is-active" : ""}`}
                    onMouseMove={() => i !== active && setActiveIndex(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickCommand(command, command.name === "clear" && builtins.length > 0)}
                  >
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
            {dictation.noVoice && (
              <div className="chat-notice" role="alert">
                <span className="chat-notice-text">{t("chat.dictate.noVoice")}</span>
                <button type="button" className="chat-chip-remove" aria-label={t("chat.dictate.dismiss")} title={t("chat.dictate.dismiss")} onClick={dictation.dismissNoVoice}>
                  {"×"}
                </button>
              </div>
            )}
            {dictation.readyNotice && (
              <div className="chat-notice" role="status">
                <span className="chat-notice-text">{t("chat.dictate.ready")}</span>
                <button type="button" className="chat-chip-remove" aria-label={t("chat.dictate.dismiss")} title={t("chat.dictate.dismiss")} onClick={dictation.dismissReady}>
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
                  {dictation.partial && (
                    <span className="chat-listening-text">{dictation.partial === TRANSCRIBING_MARKER ? t("chat.dictate.transcribing") : dictation.partial}</span>
                  )}
                </div>
              )}
              <textarea
                ref={inputRef}
                className="chat-input"
                rows={1}
                aria-label={t("chat.composer.label")}
                aria-activedescendant={menuOpen ? `${listId}-${active}` : undefined}
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
                    title={
                      dictation.downloadProgress !== null
                        ? t("chat.dictate.downloadingTip", { percent: dictation.downloadProgress })
                        : t(listening ? "chat.dictate.stop" : "chat.dictate", { keys: "Ctrl+Shift+Space" })
                    }
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
                    {dictation.downloadProgress !== null && (
                      <svg className="chat-mic-ring" viewBox="0 0 34 34" aria-hidden="true">
                        <circle className="chat-mic-ring-track" cx="17" cy="17" r="15" />
                        <circle
                          className="chat-mic-ring-value"
                          cx="17"
                          cy="17"
                          r="15"
                          transform="rotate(-90 17 17)"
                          strokeDasharray={RING_LENGTH}
                          strokeDashoffset={RING_LENGTH * (1 - dictation.downloadProgress / 100)}
                        />
                      </svg>
                    )}
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
      {dictation.setupOpen && <DictationSetupDialog onClose={dictation.closeSetup} />}
    </>
  );
}
