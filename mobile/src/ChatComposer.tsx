import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatCommand, ChatModels, ChatModes, ChatThought } from "../../src/chat/chatTypes";
import { buildMenu, commandText, displayName, type MenuEntry } from "../../src/chat/commandMenu";
import { goalEnded, type ChatGoal as Goal, type ChatItem, type GoalAction } from "../../src/chat/chatModel";
import { CommandChip } from "../../src/chat/CommandChip";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { ChatGoal } from "./ChatGoal";
import { ChatCommands } from "./ChatCommands";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { ModeIcon, StarIcon } from "./ChatModeIcons";
import { ChatModelPicker } from "./ChatModelPicker";
import { getDefaultMode, isRiskyKind, modeKind, setDefaultMode } from "./chatModeDefaults";
import { BackIcon, CloseIcon, SendIcon, StopIcon, Svg } from "./icons";
import { appendDictation, useDictation } from "./useDictation";

/** Tallest the box grows before it scrolls. */
const MAX_HEIGHT = 140;

/** Unsent text per chat, so leaving a chat and coming back keeps it. */
const drafts = new Map<string, string>();

/** The picked command per chat, kept like the text. */
const pickedDrafts = new Map<string, MenuEntry>();

/** Keeps the keyboard where it is while a button is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
};

/** A hardware keyboard sends on Enter (Shift+Enter breaks the line); a touch keyboard's Enter always breaks it. */
const hasKeyboard = () => typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches;

const MicIcon = () => (
  <Svg size={24}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

/** m:ss since dictation began. */
function useElapsed(running: boolean): string {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!running) return;
    setSecs(0);
    const id = setInterval(() => setSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running]);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

/** Heights of the waveform bars; the animation swells and shrinks them. */
const WAVE = [7, 14, 20, 11, 18, 8];

/** What the thread can ask of the composer: take a message back into the draft. */
export interface ChatComposerHandle {
  insertDraft: (text: string) => void;
}

interface ChatComposerProps {
  compact?: boolean;
  expanded?: boolean;
  onClose?: () => void;
  onOpen?: () => void;
  onDraftChange?: (hasDraft: boolean) => void;
  chatId: string;
  /** The agent CLI, which the default mode is kept per. */
  agent: string;
  busy: boolean;
  modes: ChatModes | null;
  onMode: (modeId: string) => void;
  /** Null when there is no model to choose (one model, or a desktop that can't switch). */
  models?: ChatModels | null;
  onModel?: (modelId: string) => void;
  /** The thinking levels the agent offers (more than one), shown in the model drawer. */
  thought?: ChatThought | null;
  onThought?: (value: string) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  subagentTray?: ReactNode;
  /** What the agent offers on "/". */
  commands: ChatCommand[];
  /** The agent hasn't said its commands yet. */
  commandsLoading: boolean;
  /** Whether the desktop can run "/clear". */
  canClear: boolean;
  /** The chat's goal (`/goal`), shown as a chip on the card; null without one. */
  goal?: Goal | null;
  goalActions?: GoalAction[];
  /** The conversation, so the chip knows when an ended goal is old news. */
  goalItems?: ChatItem[];
  onGoal?: (action: GoalAction) => Promise<void> | void;
}

/**
 * The message card: the text field first, then one row of actions - the mode
 * pill on the left (it opens the list of modes) and the model pill beside it, the "/" button
 * (it goes when the row has no room for it), the mic and the send button
 * (the stop button while a turn runs and the box is empty) on the right, both
 * round and 56px for the thumb. While dictating, a waveform and a timer sit
 * where the placeholder was.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({
  compact = false,
  expanded = false,
  onClose,
  onOpen,
  onDraftChange,
  chatId,
  agent,
  busy,
  subagentTray,
  modes,
  onMode,
  models = null,
  thought = null,
  onModel,
  onThought,
  onSend,
  onStop,
  commands,
  commandsLoading,
  canClear,
  goal = null,
  goalActions = [],
  goalItems = [],
  onGoal,
}, ref) {
  const fullscreen = compact && expanded;
  /** The goal chip sits collapsed at the card's top right: the text keeps clear of it. */
  const [goalChip, setGoalChip] = useState(false);
  const goalLive = !!goal && !goalEnded(goal);
  const goalTone = goal && goalLive ? (goal.status === "active" ? " is-goal-active" : " is-goal-paused") : "";
  const inputId = useId();
  // Register before the command/mode layers so Android Back closes the top layer first.
  useBackHandler(fullscreen, () => closeComposer());
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(chatId) ?? "");
  const [modeOpen, setModeOpen] = useState(false);
  const [defaultMode, setDefault] = useState(() => getDefaultMode(agent));
  const [picked, setPicked] = useState<MenuEntry | null>(() => pickedDrafts.get(chatId) ?? null);
  /** The "/" button over a draft that already has text: the list opens and the text stays, as the instructions. */
  const [forced, setForced] = useState(false);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const builtins = useMemo<ChatCommand[]>(() => (canClear ? [{ name: "clear", description: t("chatCmdClear") }] : []), [canClear]);
  const query = picked ? null : forced ? "" : text.startsWith("/") && !/\s/.test(text) && dismissedFor !== text ? text.slice(1) : null;
  const menu = useMemo(() => (query === null ? null : buildMenu(commands, builtins, query)), [query, commands, builtins]);
  const closeMenu = () => {
    setForced(false);
    setDismissedFor(text);
  };
  const menuOpen = menu !== null;
  useEscape(menuOpen, closeMenu);
  useBackHandler(menuOpen, closeMenu);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) closeMenu();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen, text]);
  const closeMode = () => setModeOpen(false);
  const closeComposer = () => {
    closeMenu();
    setModeOpen(false);
    onClose?.();
  };
  useEscape(modeOpen, closeMode);
  useBackHandler(modeOpen, closeMode);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (fullscreen) {
      el.style.height = "";
      el.style.overflowY = "";
      return;
    }
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text, fullscreen]);

  useEffect(() => {
    onDraftChange?.(!!text.trim() || !!picked);
  }, [text, picked, onDraftChange]);

  useEffect(() => {
    if (!fullscreen) return;
    const screen = root.current?.closest(".chat-screen");
    const previous = screen?.querySelector<HTMLElement>(".chat-write") ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const siblings = Array.from(screen?.children ?? []).filter((el): el is HTMLElement => el instanceof HTMLElement && !el.contains(root.current));
    const wasInert = siblings.map(el => el.inert);
    siblings.forEach(el => { el.inert = true; });
    box.current?.focus({ preventScroll: true });
    return () => {
      siblings.forEach((el, i) => { el.inert = wasInert[i]; });
      // Closing also dismisses the soft keyboard before returning to the reading layout.
      if (root.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, [fullscreen]);

  const change = (value: string) => {
    setText(value);
    if (value) drafts.set(chatId, value);
    else drafts.delete(chatId);
  };
  const latest = useRef(text);
  latest.current = text;
  useImperativeHandle(ref, () => ({
    insertDraft: (added) => {
      change(latest.current.trim() ? `${added}
${latest.current}` : added);
      if (compact) onOpen?.();
      else box.current?.focus();
    },
  }));
  const dictation = useDictation((spoken) => change(appendDictation(latest.current, spoken)), !compact || expanded);
  const listening = dictation.state === "listening";
  const elapsed = useElapsed(listening);
  const dictate = () => {
    tapFeedback();
    dictation.toggle();
  };
  const pick = (entry: MenuEntry | null) => {
    setPicked(entry);
    if (entry) pickedDrafts.set(chatId, entry);
    else pickedDrafts.delete(chatId);
  };
  const pickCommand = (entry: MenuEntry) => {
    tapFeedback();
    if (!forced || text.startsWith("/")) change("");
    setForced(false);
    pick(entry);
    box.current?.focus();
  };
  /** Opens the command list ("/" is often hidden on the keyboard's second layer); pressed while it is open, closes it. */
  const toggleMenu = () => {
    tapFeedback();
    pick(null);
    if (menuOpen) {
      if (text === "/") change("");
      if (forced) setForced(false);
      else if (text !== "/") setDismissedFor(text);
    } else if (!text) change("/");
    else if (text === "/") setDismissedFor(null);
    else setForced(true);
    box.current?.focus();
  };
  const send = () => {
    if (!text.trim() && !picked) return;
    tapFeedback();
    dictation.cancel();
    // Flowcode's own commands take no instructions.
    onSend(picked ? commandText(picked) + (text.trim() && picked.kind !== "flowcode" ? ` ${text}` : "") : text);
    change("");
    pick(null);
    setForced(false);
  };
  const current = modes?.availableModes.find((m) => m.id === modes.currentModeId);

  return (
    <div
      className={"chat-composer" + (fullscreen ? " is-fullscreen" : "")}
      ref={root}
      hidden={compact && !expanded}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen ? true : undefined}
      aria-label={fullscreen ? t("chatComposeTitle") : undefined}
      onKeyDown={(e) => {
        if (!fullscreen || e.nativeEvent.isComposing || !root.current?.contains(e.target as Node)) return;
        if (e.key === "Escape" && !menuOpen && !modeOpen) {
          e.preventDefault();
          e.stopPropagation();
          closeComposer();
        }
        if (e.key === "Tab") {
          const items = Array.from(root.current.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, select, [tabindex="0"]')).filter(el => el.getClientRects().length > 0);
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
      }}
    >
      {fullscreen && (
        <header className="chat-compose-head">
          <button type="button" className="tm-btn" aria-label={t("chatComposeBack")} onClick={closeComposer}><BackIcon /></button>
          <h2>{t("chatComposeTitle")}</h2>
          {(text.trim() || picked) && <small>{t("chatDraftKept")}</small>}
        </header>
      )}
      {menu && query !== null && <ChatCommands {...keepFocus} menu={menu} query={query} loading={commandsLoading} onPick={pickCommand} />}
      {dictation.error && (
        <div className="chat-notice" role="alert">
          <span className="chat-notice-text">{dictation.error}</span>
          <button type="button" aria-label={t("dictateDismiss")} onClick={dictation.dismissError}>
            <CloseIcon />
          </button>
        </div>
      )}
      {subagentTray}
      <div className={"chat-card" + (listening ? " is-listening" : "") + goalTone + (goalChip && !fullscreen ? " has-goal-chip" : "")}>
        {goal && !fullscreen && <ChatGoal chatId={chatId} goal={goal} actions={goalActions} items={goalItems} onAction={onGoal} onChipChange={setGoalChip} />}
        <div className="chat-editor-field">
        {fullscreen && <label className="chat-compose-label" htmlFor={inputId}>{t("chatPlaceholder")}</label>}
        {listening && (
          <div className="chat-listening" aria-live="polite">
            <span className="chat-wave" role="img" aria-label={t("dictateListening")}>
              {WAVE.map((h, i) => (
                <i key={i} style={{ height: h, animationDelay: `${i * 0.08}s` }} />
              ))}
            </span>
            <span className="chat-listening-time">{elapsed}</span>
            {dictation.partial && <span className="chat-listening-text">{dictation.partial}</span>}
          </div>
        )}
        {picked && (
          <div className="chat-cmd-row">
            <CommandChip kind={picked.kind} name={displayName(picked)} title={picked.command.description} onRemove={() => { pick(null); box.current?.focus(); }} removeLabel={t("chatCmdRemove")} />
          </div>
        )}
        <textarea
          id={inputId}
          ref={box}
          className="chat-input"
          rows={1}
          value={text}
          placeholder={listening ? "" : picked ? (picked.hint ? `${picked.hint} · ${t("chatCmdOptional")}` : t("chatCmdAddInstructions")) : goalLive && !fullscreen ? t("chatGoalPlaceholder") : t("chatPlaceholder")}
          aria-label={t("chatPlaceholder")}
          autoCapitalize="sentences"
          onChange={(e) => {
            setForced(false);
            change(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && (fullscreen ? (e.ctrlKey || e.metaKey || (!!menu?.entries.length && hasKeyboard())) : hasKeyboard())) {
              e.preventDefault();
              const top = menu?.entries[0]?.entry;
              if (top) pickCommand(top);
              else send();
            }
          }}
        />
        {fullscreen && <small className="chat-compose-hint">{t("chatComposeHint")}</small>}
        </div>
        <div className="chat-actions">
          <div className="chat-actions-fit">
          <div className="chat-actions-start">
            {modes && current ? (
              <div className="chat-mode">
                <AdaptiveSheet open={modeOpen} onClose={closeMode} variant="drawer" side="right" portal label={t("chatModeCaption")}>
                  <div className="tm-grabber" />
                  <header className="tm-sheet-head">
                    <h2>{t("chatModeCaption")}</h2>
                    <button type="button" className="tm-btn" aria-label={t("closeViewer")} onClick={closeMode}>
                      <CloseIcon />
                    </button>
                  </header>
                  <div className="chat-pick-body" role="radiogroup" aria-label={t("chatModes")}>
                    {modes.availableModes.map((m) => {
                      const kind = modeKind(m);
                      const isDefault = defaultMode === m.id;
                      return (
                        <div key={m.id} className={"chat-mode-row" + (m.id === current.id ? " on" : "") + (isRiskyKind(kind) ? " risky" : "")}>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={m.id === current.id}
                            className="chat-mode-pick"
                            onClick={() => {
                              tapFeedback();
                              closeMode();
                              if (m.id !== current.id) onMode(m.id);
                            }}
                          >
                            <span className="chat-mode-ico">
                              <ModeIcon kind={kind} />
                            </span>
                            <span className="chat-mode-text">
                              <span className="chat-mode-name">{m.name}</span>
                              {m.description && <span className="chat-mode-desc">{m.description}</span>}
                            </span>
                          </button>
                          <button
                            type="button"
                            className={"chat-mode-star" + (isDefault ? " on" : "")}
                            aria-pressed={isDefault}
                            aria-label={isDefault ? t("chatModeClearDefault", { name: m.name }) : t("chatModeSetDefault", { name: m.name })}
                            onClick={() => {
                              tapFeedback();
                              const next = isDefault ? null : m.id;
                              setDefaultMode(agent, next);
                              setDefault(next);
                            }}
                          >
                            <StarIcon filled={isDefault} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </AdaptiveSheet>
                <button type="button" {...keepFocus} className={"chat-mode-pill chat-mode-icon" + (isRiskyKind(modeKind(current)) ? " risky" : "")} aria-haspopup="dialog" aria-expanded={modeOpen} aria-label={t("chatModeAria", { name: current.name })} title={current.name} onClick={() => setModeOpen(!modeOpen)}>
                  <ModeIcon kind={modeKind(current)} size={18} />
                </button>
              </div>
            ) : null}
            {onModel && onThought && <ChatModelPicker models={models} thought={thought} busy={busy} onModel={onModel} onThought={onThought} />}
          </div>
          <button type="button" {...keepFocus} tabIndex={-1} className={"chat-slash" + (menu ? " on" : "")} aria-label={t("chatCmdTitle")} aria-expanded={menu !== null} onClick={toggleMenu}>/</button>
          </div>
          <div className="chat-actions-end">
            {dictation.supported && (
              <button type="button" {...keepFocus} className={"chat-round chat-mic" + (listening ? " is-listening" : "")} aria-label={t("dictate")} aria-pressed={listening} onClick={dictate}>
                <MicIcon />
              </button>
            )}
            {busy && !text.trim() && !picked ? (
              <button type="button" {...keepFocus} className="chat-round is-stop" aria-label={t("chatStopTurn")} onClick={onStop}>
                <StopIcon />
              </button>
            ) : (
              <button type="button" {...keepFocus} className="chat-round is-send" aria-label={t("chatSend")} disabled={!text.trim() && !picked} onClick={send}>
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
