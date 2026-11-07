import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent } from "react";
import { useI18n } from "../i18n";
import ChatModeSelect from "./ChatModeSelect";
import ChatModelSelect from "./ChatModelSelect";
import type { AgentViewProps } from "../agentViews/types";
import { AskComposer } from "./AskComposer";
import { useCacheWarning } from "./useCacheWarning";
import { ChatItemView, PaperclipIcon, PermissionCard, SubagentCards, SubagentMarker, SubagentTray, ToolGroup } from "./ChatItems";
import { BackgroundTerminalsCard } from "../../shared/BackgroundTerminalsCard";
import { backgroundTerminals } from "./backgroundTerminals";
import { buildTimeline, isGuardianReview, liveTool, subagentPrompt, subagentState, subagentTimeline } from "./chatTimeline";
import { CLI_INFO, cliName } from "../agents/cliInfo";
import { delegatesOf } from "./chatModel";
import { DelegateCards, DelegateRequests } from "./DelegateCards";
import type { ChatAttachment, ChatCommand } from "./chatTypes";
import { buildMenu, commandText, displayName, type CommandKind, type MenuEntry } from "./commandMenu";
import { CommandChip, KindIcon, UserText } from "./CommandChip";
import { ChatMarkdown } from "./ChatMarkdown";
import { FrogThinking } from "../../shared/FrogThinking";
import { ChatEmptyFrog } from "./ChatEmptyFrog";
import { ChatPondEnd } from "./ChatPondEnd";
import { limitOf } from "./chatLimit";
import { accountBlockedUntil } from "../notifications/limitResetWatcher";
import { sweepDashes } from "../../shared/busySweep";
import { appendDictation, spaceRelease, TRANSCRIBING_MARKER, useDictation } from "./useDictation";
import { getDictationAutoSend, useDictationShortcuts } from "./dictationModels";
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

/** A context size as "118k" (rounded), or the plain number under a thousand. */
function formatCacheTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

function formatTimer(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** `text` with the characters at `hits` (indices into the whole display name, `offset` being where `text` starts in it) marked. */
function HitText({ text, hits, offset }: { text: string; hits: Set<number>; offset: number }) {
  const runs: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(offset + i);
    const last = runs[runs.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return <>{runs.map((r, i) => (r.hit ? <mark key={i}>{r.text}</mark> : r.text))}</>;
}

/** A menu row's name: "/" and sigil, the namespace faint, the matched characters marked. */
function CommandName({ entry, hits }: { entry: MenuEntry; hits: number[] }) {
  const marked = new Set(hits);
  const nsLength = entry.namespace ? entry.namespace.length + 1 : 0;
  return (
    <span className="chat-command-name">
      {"/"}
      {entry.sigil}
      {entry.namespace && (
        <span className="chat-command-ns">
          <HitText text={`${entry.namespace}:`} hits={marked} offset={0} />
        </span>
      )}
      <HitText text={entry.base} hits={marked} offset={nsLength} />
    </span>
  );
}

/** Two arcs running round the composer while the last words are transcribed: the tabs' busy sweep (shared/busySweep.ts), doubled and slower. */
const COMPOSER_SWEEP = sweepDashes(28, 16);
function ComposerSweep() {
  return (
    <svg className="chat-composer-sweep" aria-hidden="true">
      {[0, 1].map((arc) =>
        COMPOSER_SWEEP.map((d, i) => (
          <rect key={`${arc}-${i}`} width="100%" height="100%" rx="24.75" pathLength="100" className={arc ? "is-second" : undefined} style={{ strokeDasharray: d.dasharray, opacity: d.opacity }} />
        )),
      )}
    </svg>
  );
}

/** A delegate card in a view that cannot open tabs does nothing. */
const NO_OPEN = () => {};
const NO_REQUESTS: never[] = [];

/** The built-in "chat" view: the conversation as a timeline (messages, tool
 * activity on a rail, permission requests) and a floating composer under it. */
export default function ChatBody({ session: chat, agent, hidden, cwd, openSubagent: sub = null, onOpenSubagent, onOpenDelegate }: AgentViewProps) {
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

  // The frog plays its clear scene when the conversation was cleared since this view last saw it filled (or opened).
  const clearSeen = useRef(chat.clearCount);
  const cleared = chat.clearCount > clearSeen.current;
  const filled = model.items.length > 0 || working || queued.length > 0;
  const prevCount = useRef(chat.clearCount);
  useEffect(() => {
    // The render of a clear still holds the old conversation: that is not "seen filled".
    if (prevCount.current !== chat.clearCount) {
      prevCount.current = chat.clearCount;
      return;
    }
    if (filled) clearSeen.current = chat.clearCount;
  }, [filled, chat.clearCount]);

  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const [footerH, setFooterH] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Set when a dictation ended with auto-send on; the effect below sends once the final phrase is in the draft.
  const autoSendRef = useRef(false);
  // Whether the current dictation put any words in the draft (a cough or a filtered hallucination doesn't).
  const dictatedRef = useRef(false);
  const dictation = useDictation(
    (text) => {
      if (text.trim()) dictatedRef.current = true;
      setDraft((d) => appendDictation(d, text));
    },
    !hidden && !sub && !chat.attached,
    () => {
      // Not when the session ended because this view was hidden or a subagent opened over it.
      if (dictatedRef.current && getDictationAutoSend() && !hidden && !sub) autoSendRef.current = true;
    },
    // The project's folder name: a hint for the recognizer (names of this project's tech).
    cwd.split(/[\\/]/).filter(Boolean).pop(),
  );
  const dictationStateRef = useRef(dictation.state);
  dictationStateRef.current = dictation.state;
  // Set once a Space press was taken for dictation, so its auto-repeats type nothing either.
  const spaceHeldRef = useRef(false);
  const spaceShortcuts = useDictationShortcuts();
  const shortcutsRef = useRef(spaceShortcuts);
  shortcutsRef.current = spaceShortcuts;
  // The Space press that started (or is running) a dictation, and its key-up listeners.
  const spaceRef = useRef<{ downAt: number; mode: "pending" | "tap" } | null>(null);
  const spaceCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => spaceCleanupRef.current?.(), []);
  // A session ended some other way (mic, Esc, send) leaves no stale tap mode.
  useEffect(() => {
    if (dictation.state !== "listening" && spaceRef.current?.mode === "tap") spaceRef.current = null;
    // A new session starts with nothing dictated yet.
    if (dictation.state === "listening") dictatedRef.current = false;
  }, [dictation.state]);
  const listening = dictation.state === "listening";
  useEffect(() => {
    if (dictation.state === "listening") autoSendRef.current = false;
    else if (autoSendRef.current && dictation.state === "idle") {
      autoSendRef.current = false;
      submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictation.state, draft]);
  const transcribing = dictation.state === "transcribing";
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

  // A delegated child's chat: read-only, owned by its orchestrator.
  const attached = !!chat.attached;
  const mainTimeline = useMemo(() => (sub ? null : buildTimeline(model.items)), [sub, model.items, agent]);
  const subTimeline = useMemo(() => (sub ? subagentTimeline(sub) : null), [sub]);
  const timeline = subTimeline ?? mainTimeline ?? [];
  const pending = model.items.filter((i): i is Extract<typeof i, { type: "permission" }> => i.type === "permission" && i.resolved === undefined);
  // The agent's open question: it takes the composer's place until answered.
  const openAsk = model.items.find((i): i is Extract<typeof i, { type: "ask" }> => i.type === "ask" && i.resolved === undefined);
  // The plan's usage limit, reached in this turn: the frog's pond stands in for the composer until the reset (or "write anyway").
  const limit = useMemo(() => (sub || attached ? null : limitOf(model.items)), [sub, attached, model.items]);
  const [dismissedLimitId, setDismissedLimitId] = useState<string | null>(null);
  const limitResetAt = limit ? (limit.at ?? accountBlockedUntil(CLI_INFO[agent].pluginId, chat.profileId ?? undefined) ?? null) : null;
  const [limitNow, setLimitNow] = useState(() => Date.now());
  useEffect(() => {
    if (!limit) return;
    setLimitNow(Date.now());
    const id = window.setInterval(() => setLimitNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [limit]);
  const showLimit =
    !!limit && phase === "ready" && status === "idle" && !working && pending.length === 0 && !openAsk && limit.id !== dismissedLimitId && (limitResetAt === null || limitResetAt > limitNow);
  const lastSegment = timeline[timeline.length - 1];
  // In the main chat, the subagents still running, for the tray behind the composer.
  const runningSubs = sub ? [] : timeline.flatMap((s) => (s.type === "subagents" ? s.items.filter((i) => subagentState(i).running) : []));
  const liveGroup = (sub ? !!subState?.running : model.turnActive) && lastSegment?.type === "group" ? lastSegment : null;
  const running = liveTool(sub ? sub.children : model.items);
  const showLive = (sub ? !!subState?.running : working) && !notice && pending.length === 0 && !openAsk;
  const liveText = running && isGuardianReview(running) ? t("chat.guardian.checking") : (running?.title ?? running?.kind ?? null);

  // A Claude chat idle past the prompt cache's lifetime: the next message re-reads everything uncached.
  const cacheWarning = useCacheWarning({
    agent,
    idle: !sub && !attached && phase === "ready" && status === "idle" && pending.length === 0 && !openAsk && queued.length === 0,
    items: model.items,
    lastActivityAt: chat.lastActivityAt,
    usageTokens: chat.usageTokens,
    sessionId: chat.sessionId,
    profileId: chat.profileId,
    wslDistro: chat.wslDistro,
    local: !!chat.clear,
    chatId: chat.chatId ?? "",
  });
  const showCacheCard = cacheWarning.show && !draft;

  // The delegates' open requests take the composer's place, like the agent's own question (which goes first).
  const delegateRequests = attached || !chat.answerDelegatePermission || !chat.answerDelegateAsk ? NO_REQUESTS : model.delegateRequests;
  const delegateAsk = delegateRequests.length > 0 && !openAsk;
  // The delegate behind a request, for its "open the chat" button.
  const openDelegateOf = useCallback(
    (taskId: string) => {
      const delegate = delegatesOf(model.items).find((d) => d.taskId === taskId);
      if (delegate) onOpenDelegate?.(delegate);
    },
    [model.items, onOpenDelegate],
  );

  // Follow the conversation while the reader is at its end.
  useLayoutEffect(() => {
    const column = columnRef.current;
    if (column && followRef.current && !hidden) column.scrollTop = column.scrollHeight;
  }, [model.lastSeq, queued.length, phase, hidden, pending.length, subId]);
  // ...and when the content grows later, with no new event: an expanded
  // step, a link preview or a code block laid out after the render above.
  // The composer sits inside the scroller: its growth pins the view too, and
  // its height (measured here) floats the jump button above it.
  useLayoutEffect(() => {
    const column = columnRef.current;
    const content = contentRef.current;
    const footer = footerRef.current;
    if (!column || !content || hidden || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      if (footer) setFooterH(footer.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(() => {
      measure();
      if (followRef.current) column.scrollTop = column.scrollHeight;
    });
    ro.observe(column);
    ro.observe(content);
    if (footer) ro.observe(footer);
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
    // Not while the Browser panel's page has the focus: the keys would stop scrolling it.
    if (!hidden && !subId && document.activeElement?.tagName !== "IFRAME") inputRef.current?.focus();
  }, [hidden, phase, subId]);

  // The "/" menu: client-side commands first (ours wins over an agent command of the same name), then the agent's.
  const builtins = useMemo<ChatCommand[]>(() => (chat.clear ? [{ name: "clear", description: t("chat.cmd.clear") }] : []), [chat.clear, t]);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  // The picked command waits as a chip in the composer for the instructions to follow it.
  const [pickedCommand, setPickedCommand] = useState<MenuEntry | null>(null);
  const [chipSelected, setChipSelected] = useState(false);
  const listId = useId();
  const menuQuery = !pickedCommand && draft.startsWith("/") && !/\s/.test(draft) && dismissedFor !== draft ? draft.slice(1) : null;
  const menu = useMemo(() => (menuQuery === null ? null : buildMenu(model.commands, builtins, menuQuery)), [menuQuery, model.commands, builtins]);
  const suggestions = menu?.entries ?? [];
  const menuOpen = suggestions.length > 0;
  const suggestionKey = suggestions.map((x) => x.entry.command.name).join("\n");
  const active = Math.min(activeIndex, Math.max(0, suggestions.length - 1));
  useEffect(() => {
    setActiveIndex(0);
  }, [suggestionKey]);

  // Arrow keys in the composer walk the subagent tray (up) and the background terminals under it (down).
  const terminals = useMemo(() => (sub ? [] : backgroundTerminals(model.items, agent).filter((term) => term.running)), [sub, model.items]);
  const [navZone, setNavZone] = useState<"input" | "sub" | "term">("input");
  const [navIndex, setNavIndex] = useState(0);
  const [subsOpen, setSubsOpen] = useState(false);
  const foldSubs = useCallback(() => setSubsOpen(false), []);
  const [termsOpen, setTermsOpen] = useState(false);
  const [termOutId, setTermOutId] = useState<string | null>(null);
  useEffect(() => {
    if (navZone === "sub" && runningSubs.length === 0) setNavZone("input");
    if (terminals.length === 0) {
      if (navZone === "term") setNavZone("input");
      setTermsOpen(false);
      setTermOutId(null);
    }
  }, [navZone, runningSubs.length, terminals.length]);
  const termLabels = useMemo(
    () => ({
      count: (count: number) => t(count === 1 ? "chat.term.count.one" : "chat.term.count.other", { count }),
      hint: t("chat.term.hint"),
      hintOpen: t("chat.term.hintOpen"),
      noOutput: t("chat.term.noOutput"),
    }),
    [t],
  );
  const closeSubs = () => {
    setSubsOpen(false);
    setNavZone((zone) => (zone === "sub" ? "input" : zone));
  };
  const closeTerms = () => {
    setTermsOpen(false);
    setTermOutId(null);
    setNavZone((zone) => (zone === "term" ? "input" : zone));
  };
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
    chat.clear?.();
  }
  // The old conversation melts away: this runs in the clear's commit, while the DOM still shows it,
  // so a copy of the column is laid over it and fades out on its own.
  const dissolveSeen = useRef(chat.clearCount);
  useLayoutEffect(() => {
    if (dissolveSeen.current === chat.clearCount) return;
    dissolveSeen.current = chat.clearCount;
    const column = columnRef.current;
    const wrap = column?.parentElement;
    if (!column || !wrap || model.items.length === 0 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const copy = column.cloneNode(true) as HTMLElement;
    copy.removeAttribute("id");
    copy.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
    copy.classList.add("chat-dissolve");
    copy.setAttribute("aria-hidden", "true");
    copy.inert = true;
    wrap.appendChild(copy);
    copy.scrollTop = column.scrollTop;
    const remove = () => copy.remove();
    copy.addEventListener("animationend", remove, { once: true });
    window.setTimeout(remove, 700);
  }, [chat.clearCount, model.items.length]);
  // Whoever clears the conversation (the composer, the sidebar, the phone), the composer starts over.
  const clearReset = useRef(chat.clearCount);
  useEffect(() => {
    if (clearReset.current === chat.clearCount) return;
    clearReset.current = chat.clearCount;
    setDraft("");
    setPickedCommand(null);
    setChipSelected(false);
    setAttachments([]);
    setAttachError(null);
    dictation.discard();
    followRef.current = true;
    setAtBottom(true);
  }, [chat.clearCount, dictation]);

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
    autoSendRef.current = false;
    if (phase !== "ready" || chat.authRequired) return;
    if (!draft.trim() && attachments.length === 0 && !pickedCommand) return;
    const isClear = pickedCommand ? pickedCommand.kind === "flowcode" && pickedCommand.command.name === "clear" : draft.trim() === "/clear";
    if (chat.clear && attachments.length === 0 && isClear) {
      runClear();
      return;
    }
    // The dictation session is disowned before the draft clears, so a phrase
    // it flushes late can't land in the next draft; what it was still hearing
    // goes out with this message.
    const text = appendDictation(draft, dictation.discard());
    chat.send(pickedCommand ? commandText(pickedCommand) + (text.trim() ? ` ${text}` : "") : text, attachments);
    setDraft("");
    setPickedCommand(null);
    setChipSelected(false);
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

  /** Picks a suggestion: it becomes the chip ahead of the input, to send with or without instructions. */
  function pickCommand(entry: MenuEntry) {
    setPickedCommand(entry);
    setChipSelected(false);
    setDraft("");
    inputRef.current?.focus();
  }

  /** Takes the chip off. `restoreText` (a second Backspace) puts it back as editable "/name" text ahead of the draft. */
  function removeChip(restoreText: boolean) {
    const entry = pickedCommand;
    setPickedCommand(null);
    setChipSelected(false);
    if (restoreText && entry) {
      setDismissedFor(null);
      setDraft((d) => (d ? `${commandText(entry)} ${d}` : commandText(entry)));
    }
    inputRef.current?.focus();
  }

  /** Space in the empty composer dictates (tap to start/stop, hold to talk).
   * Returns whether the key was consumed. */
  function spaceDictation(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (e.code !== "Space" || e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || e.nativeEvent.isComposing) return false;
    // The repeats of a press taken for dictation (held to talk, or held on the tap that stopped it): no spaces typed.
    if (e.repeat && spaceHeldRef.current) {
      e.preventDefault();
      return true;
    }
    if (!e.repeat) spaceHeldRef.current = false;
    if (!dictation.supported || phase !== "ready" || menuOpen) return false;
    const session = spaceRef.current;
    if (dictation.state === "listening" && session?.mode === "tap" && spaceShortcuts.tap) {
      e.preventDefault();
      spaceHeldRef.current = true;
      dictation.stop();
      spaceRef.current = null;
      return true;
    }
    if (dictation.state === "transcribing" && draft === "" && !pickedCommand) {
      e.preventDefault();
      return true;
    }
    if (draft !== "" || pickedCommand || (dictation.state !== "idle" && dictation.state !== "error") || !(spaceShortcuts.tap || spaceShortcuts.hold)) return false;
    e.preventDefault();
    if (e.repeat) return true;
    spaceHeldRef.current = true;
    spaceRef.current = { downAt: performance.now(), mode: "pending" };
    void dictation.start();
    spaceCleanupRef.current?.();
    const release = () => {
      spaceCleanupRef.current?.();
      const current = spaceRef.current;
      if (!current || current.mode !== "pending") return;
      const { tap, hold } = shortcutsRef.current;
      // It never got to listen (the model setup dialog opened, or it failed): no tap mode to leave behind.
      if (dictationStateRef.current !== "listening") {
        spaceRef.current = null;
        return;
      }
      if (spaceRelease(performance.now() - current.downAt, tap, hold) === "stop") {
        dictation.stop();
        spaceRef.current = null;
      } else {
        current.mode = "tap";
      }
    };
    const onKeyUp = (k: globalThis.KeyboardEvent) => {
      if (k.code === "Space") release();
    };
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", release);
    spaceCleanupRef.current = () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", release);
      spaceCleanupRef.current = null;
    };
    return true;
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
        pickCommand(suggestions[active].entry);
        return;
      }
      if (e.key === "Escape" && !listening) {
        e.preventDefault();
        setDismissedFor(draft);
        return;
      }
    }
    if (!e.nativeEvent.isComposing && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && !listening && !transcribing) {
      if (navZone === "sub") {
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Escape") e.preventDefault();
        if (e.key === "ArrowUp") setNavIndex(Math.max(0, navIndex - 1));
        else if (e.key === "ArrowDown") {
          if (navIndex + 1 >= runningSubs.length) closeSubs();
          else setNavIndex(navIndex + 1);
        } else if (e.key === "Enter") {
          const target = runningSubs[navIndex];
          closeSubs();
          if (target && onOpenSubagent) openSub(target.id);
        } else if (e.key === "Escape") closeSubs();
        else closeSubs(); // any other key goes back to typing
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Escape") return;
      } else if (navZone === "term") {
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Escape") e.preventDefault();
        if (e.key === "ArrowDown") setNavIndex(Math.min(terminals.length - 1, navIndex + 1));
        else if (e.key === "ArrowUp") {
          if (navIndex === 0) closeTerms();
          else setNavIndex(navIndex - 1);
        } else if (e.key === "Enter") {
          const target = terminals[navIndex];
          if (target) setTermOutId(termOutId === target.id ? null : target.id);
        } else if (e.key === "Escape") {
          if (termOutId) setTermOutId(null);
          else closeTerms();
        } else setNavZone("input");
        if (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Enter" || e.key === "Escape") return;
      } else if (e.key === "ArrowUp" && runningSubs.length > 0 && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
        e.preventDefault();
        setSubsOpen(true);
        setNavZone("sub");
        setNavIndex(runningSubs.length - 1);
        return;
      } else if (e.key === "ArrowDown" && terminals.length > 0 && e.currentTarget.selectionStart === draft.length && e.currentTarget.selectionEnd === draft.length) {
        e.preventDefault();
        setTermsOpen(true);
        setNavZone("term");
        setNavIndex(0);
        return;
      }
    }
    if (pickedCommand && !e.nativeEvent.isComposing) {
      // Backspace at the very start: the first press selects the chip, the second takes it back to text.
      if (e.key === "Backspace" && e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0) {
        e.preventDefault();
        if (chipSelected) removeChip(true);
        else setChipSelected(true);
        return;
      }
      if (chipSelected && !["Shift", "Control", "Alt", "Meta"].includes(e.key)) setChipSelected(false);
    }
    if (spaceDictation(e)) return;
    if (e.key === "Enter" && e.ctrlKey && working && (draft.trim() || attachments.length > 0 || pickedCommand) && !e.nativeEvent.isComposing) {
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
  const canStop = working && draft.trim() === "" && attachments.length === 0 && !pickedCommand;

  return (
    <>
      <div className="chat-column-wrap" style={{ "--chat-footer-h": `${footerH}px` } as CSSProperties}>
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
          {attached && model.task && (
            <div className="chat-user is-task">
              <span className="chat-task-label">{t("chat.delegate.task", { agent: cliName(model.task.parentAgent) })}</span>
              <ChatMarkdown text={model.task.prompt} />
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
            segment.type === "subagents" ? (
              sub ? (
                <SubagentCards key={segment.id} items={segment.items} onOpen={onOpenSubagent ? openSub : undefined} />
              ) : (
                <SubagentMarker key={segment.id} items={segment.items} onOpen={onOpenSubagent ? openSub : undefined} />
              )
            ) : segment.type === "delegates" ? (
              <DelegateCards key={segment.id} items={segment.items} onOpen={onOpenDelegate ?? NO_OPEN} />
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
                  <div className="chat-user is-pending" title={t("chat.queue.edit")} onDoubleClick={() => editQueued(i)}>
                    <UserText text={text} />
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
                    <span className="chat-pending-pos">
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="8" cy="8" r="6" />
                        <path d="M8 4.5V8l2.2 1.5" />
                      </svg>
                      {i === 0 ? t("chat.queue.next") : t("chat.queue.nth", { n: i + 1 })}
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

      {/* Inside the scroller and sticky, so messages slide behind the composer. */}
      <div className="chat-footer" ref={footerRef} onKeyDown={onFooterKeyDown}>
        {attached ? (
          <div className="chat-composer-wrap">
            {/* Its own permissions and questions are answered here as in any chat; the orchestrator's composer shows the same ones. */}
            {pending.map((item) => (
              <PermissionCard key={item.id} item={item} onAnswer={chat.answerPermission} />
            ))}
            {openAsk && <AskComposer key={openAsk.id} item={openAsk} onAnswer={chat.answerAsk} autoFocus={!hidden} />}
            <div className="chat-sub-footer">
              <span className="lock">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                </svg>
                <span>{t(working ? "chat.delegate.locked" : "chat.delegate.lockedDone").split("**").map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))}</span>
              </span>
              {working && model.task && (
                <span className="acts">
                  <button type="button" className="chat-btn is-danger" onClick={chat.cancel}>
                    {t("chat.delegate.stop")}
                  </button>
                </span>
              )}
            </div>
          </div>
        ) : sub ? (
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
          <ChatPondEnd kind="ended" resetAt={null} hidden={hidden}>
            <button type="button" className="chat-btn is-primary" onClick={chat.restart}>
              {t("chat.pond.ended.restart")}
            </button>
          </ChatPondEnd>
        ) : showLimit ? (
          <ChatPondEnd kind="limit" resetAt={limitResetAt} hidden={hidden}>
            <button type="button" className="chat-btn" onClick={() => setDismissedLimitId(limit.id)}>
              {t("chat.pond.limit.write")}
            </button>
          </ChatPondEnd>
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
            {menu && menuOpen && (
              <div className="chat-commands">
                <div className="chat-commands-scroll" role="listbox">
                  {suggestions.map(({ entry, hits }, i) => {
                    // Grouped by kind with no query; one "best matches" header once there is one.
                    const group: CommandKind | "best" | null = menu.grouped ? entry.kind : i === 0 ? "best" : null;
                    const first = group !== null && (!menu.grouped || suggestions[i - 1]?.entry.kind !== entry.kind);
                    return (
                      <Fragment key={entry.command.name}>
                        {first && group && (
                          <div className="chat-commands-group" role="presentation">
                            {t(`chat.cmd.group.${group}`)}
                            <span>{group === "best" ? suggestions.length : suggestions.filter((x) => x.entry.kind === group).length}</span>
                          </div>
                        )}
                        <button
                          id={`${listId}-${i}`}
                          type="button"
                          role="option"
                          tabIndex={-1}
                          aria-selected={i === active}
                          className={`chat-command${i === active ? " is-active" : ""}`}
                          onMouseMove={() => i !== active && setActiveIndex(i)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pickCommand(entry)}
                        >
                          <KindIcon kind={entry.kind} />
                          <CommandName entry={entry} hits={hits} />
                          <span className="chat-command-desc">{entry.command.description}</span>
                          {entry.hint && <span className="chat-command-hint">{entry.hint}</span>}
                          {entry.also.length > 0 && <span className="chat-command-badge">{`+ ${entry.also.join(", ")}`}</span>}
                        </button>
                      </Fragment>
                    );
                  })}
                </div>
                <div className="chat-commands-foot">
                  <span>
                    <kbd>{"↑"}</kbd>
                    <kbd>{"↓"}</kbd>
                    {t("chat.cmd.navigate")}
                  </span>
                  <span>
                    <kbd>{"↵"}</kbd>
                    {t("chat.cmd.use")}
                  </span>
                  <span>
                    <kbd>Esc</kbd>
                    {t("chat.cmd.close")}
                  </span>
                  <span className="chat-commands-count">{t("chat.cmd.count", { n: suggestions.length })}</span>
                </div>
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
            <SubagentTray
              items={runningSubs}
              onOpen={
                onOpenSubagent
                  ? (id) => {
                      closeSubs();
                      openSub(id);
                    }
                  : undefined
              }
              selectedId={navZone === "sub" ? (runningSubs[navIndex]?.id ?? null) : null}
              expanded={subsOpen}
              onToggle={() => {
                if (subsOpen) closeSubs();
                else {
                  setSubsOpen(true);
                  setNavZone("sub");
                  setNavIndex(runningSubs.length - 1);
                  inputRef.current?.focus();
                }
              }}
              onUngrouped={foldSubs}
            />
            {/* The textarea stays mounted (hidden) so a half-typed message survives the question. */}
            {openAsk && <AskComposer key={openAsk.id} item={openAsk} onAnswer={chat.answerAsk} autoFocus={!hidden} />}
            {delegateAsk && (
              <DelegateRequests
                requests={delegateRequests}
                onPermission={chat.answerDelegatePermission!}
                onAsk={chat.answerDelegateAsk!}
                onOpen={(request) => openDelegateOf(request.taskId)}
                autoFocus={!hidden}
              />
            )}
            {/* The expired-cache card takes the composer's place (the composer stays mounted, hidden). */}
            {showCacheCard && !openAsk && !delegateAsk && (
              <div className="chat-cache-card" role="status">
                <button type="button" className="chat-cache-x" aria-label={t("chat.dictate.dismiss")} title={t("chat.dictate.dismiss")} onClick={cacheWarning.dismiss}>
                  {"✕"}
                </button>
                <span className="chat-cache-ico" aria-hidden="true">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                    <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9M9.5 4.5 12 7l2.5-2.5M9.5 19.5 12 17l2.5 2.5" />
                  </svg>
                </span>
                <div className="chat-cache-title">{t("chat.cache.title")}</div>
                <div className="chat-cache-text">
                  {t(cacheWarning.tokens === null ? "chat.cache.bodyNoTokens" : "chat.cache.body", {
                    min: Math.max(1, Math.round(cacheWarning.idleMs / 60_000)),
                    tokens: cacheWarning.tokens === null ? "" : formatCacheTokens(cacheWarning.tokens),
                  })
                    .split("**")
                    .map((part, i) => (i % 2 === 1 ? <b key={i}>{part}</b> : part))}
                </div>
                <div className="chat-cache-actions">
                  {chat.clear && (
                    <button type="button" className="chat-cache-btn is-main" onClick={runClear}>
                      {t("chat.cache.clear")}
                    </button>
                  )}
                  <button type="button" className="chat-cache-btn" onClick={cacheWarning.dismiss}>
                    {t("chat.cache.keep")}
                  </button>
                </div>
              </div>
            )}
            <div className={`chat-composer${openAsk || delegateAsk || showCacheCard ? " is-ask-hidden" : ""}${listening ? " is-listening" : ""}${transcribing ? " is-transcribing" : ""}${dragOver ? " is-dragover" : ""}`} data-drop-label={t("chat.attach.drop")}>
              {transcribing && <ComposerSweep />}
              {(listening || transcribing) && (
                <div className="chat-listening" aria-live="polite">
                  {transcribing ? (
                    <span className="chat-listening-meta">{t("chat.dictate.transcribingLabel")}</span>
                  ) : (
                    <>
                      <span className="chat-wave" aria-hidden="true">
                        {WAVE_BARS.map((h, i) => (
                          <span key={i} className="chat-wave-bar" style={{ height: waveHeight(h, dictation.level) }} />
                        ))}
                      </span>
                      <span className="chat-listening-meta">
                        {formatTimer(seconds)} {"·"} {t("chat.dictate.escHint")}
                      </span>
                    </>
                  )}
                  {dictation.partial && !(transcribing && dictation.partial === TRANSCRIBING_MARKER) && (
                    <span className="chat-listening-text">{dictation.partial === TRANSCRIBING_MARKER ? t("chat.dictate.transcribing") : dictation.partial}</span>
                  )}
                </div>
              )}
              <div className="chat-input-row">
                {pickedCommand && (
                  <CommandChip
                    kind={pickedCommand.kind}
                    name={displayName(pickedCommand)}
                    title={pickedCommand.command.description}
                    selected={chipSelected}
                    onRemove={() => removeChip(false)}
                    removeLabel={t("chat.cmd.remove")}
                  />
                )}
                <textarea
                  ref={inputRef}
                  className="chat-input"
                  rows={1}
                  aria-label={t("chat.composer.label")}
                  aria-activedescendant={menuOpen ? `${listId}-${active}` : navZone === "term" && termsOpen ? `${listId}-term-${navIndex}` : undefined}
                  placeholder={
                    listening || transcribing
                      ? ""
                      : pickedCommand
                        ? pickedCommand.hint
                          ? `${pickedCommand.hint} · ${t("chat.cmd.optional")}`
                          : t("chat.cmd.addInstructions")
                        : dictation.supported && draft === "" && dictation.state === "idle" && (spaceShortcuts.tap || spaceShortcuts.hold)
                        ? t("chat.composer.placeholderSpace")
                        : t("chat.composer.placeholder")
                  }
                  value={draft}
                  disabled={phase !== "ready"}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setChipSelected(false);
                  }}
                  onKeyDown={onComposerKeyDown}
                  onPaste={onPaste}
                />
              </div>
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
                    className={`chat-icon-btn is-mic${listening ? " is-listening" : ""}${transcribing ? " is-transcribing" : ""}`}
                    title={
                      transcribing
                        ? t("chat.dictate.transcribingLabel")
                        : dictation.downloadProgress !== null
                          ? t("chat.dictate.downloadingTip", { percent: dictation.downloadProgress })
                          : t(listening ? "chat.dictate.stop" : "chat.dictate", { keys: "Ctrl+Shift+Space" })
                    }
                    aria-label={t("chat.dictate.label")}
                    aria-pressed={listening}
                    aria-busy={transcribing}
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
                    disabled={phase !== "ready" || chat.authRequired || (!draft.trim() && attachments.length === 0 && !pickedCommand)}
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
            <BackgroundTerminalsCard
              terminals={terminals}
              expanded={termsOpen}
              onToggle={() => (termsOpen ? closeTerms() : setTermsOpen(true))}
              selected={navZone === "term" ? navIndex : -1}
              openId={termOutId}
              onRow={(i) => {
                setNavZone("term");
                setNavIndex(i);
                setTermOutId(termOutId === terminals[i]?.id ? null : (terminals[i]?.id ?? null));
                inputRef.current?.focus();
              }}
              idPrefix={listId}
              labels={termLabels}
            />
          </div>
        )}
      </div>
      </div>
      {!sub && !attached && (phase === "ready" || phase === "starting") && status !== "exited" && !working && model.items.length === 0 && queued.length === 0 && !model.plan?.length && (
        <ChatEmptyFrog key={chat.clearCount} hidden={hidden} starting={phase === "starting"} cleared={cleared} />
      )}
      {!atBottom && (
        <button type="button" className={"chat-jump" + (working ? " is-busy" : "")} aria-label={t("chat.jumpToEnd")} title={t("chat.jumpToEnd")} onClick={jumpToEnd}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M8 3v10M3.5 8.5 8 13l4.5-4.5" />
          </svg>
        </button>
      )}
      </div>
      {dictation.setupOpen && <DictationSetupDialog onClose={dictation.closeSetup} />}
    </>
  );
}
