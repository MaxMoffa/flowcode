import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatCommand, ChatModels, ChatModes, ChatThought } from "../../src/chat/chatTypes";
import { buildMenu, commandText, displayName, type MenuEntry } from "../../src/chat/commandMenu";
import { CommandChip } from "../../src/chat/CommandChip";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
import { ChatCommands } from "./ChatCommands";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
import { ModeIcon, StarIcon } from "./ChatModeIcons";
import { ChatModelPicker } from "./ChatModelPicker";
import { getDefaultMode, isRiskyKind, modeKind, setDefaultMode } from "./chatModeDefaults";
import { CloseIcon, SendIcon, StopIcon, Svg } from "./icons";
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
}, ref) {
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
  useEscape(modeOpen, closeMode);
  useBackHandler(modeOpen, closeMode);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [text]);

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
      box.current?.focus();
    },
  }));
  const dictation = useDictation((spoken) => change(appendDictation(latest.current, spoken)), true);
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
    if (!forced) change("");
    setForced(false);
    pick(entry);
    box.current?.focus();
  };
  /** Starts the "/" the keyboard often hides on its second layer; pressed again it closes. */
  const toggleMenu = () => {
    tapFeedback();
    pick(null);
    setDismissedFor(null);
    if (forced) setForced(false);
    else if (!text) change("/");
    else if (text === "/") change("");
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
    <div className="chat-composer" ref={root}>
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
      <div className={"chat-card" + (listening ? " is-listening" : "")}>
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
          ref={box}
          className="chat-input"
          rows={1}
          value={text}
          placeholder={listening ? "" : picked ? (picked.hint ? `${picked.hint} · ${t("chatCmdOptional")}` : t("chatCmdAddInstructions")) : t("chatPlaceholder")}
          aria-label={t("chatPlaceholder")}
          autoCapitalize="sentences"
          onChange={(e) => {
            setForced(false);
            change(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && hasKeyboard()) {
              e.preventDefault();
              const top = menu?.entries[0]?.entry;
              if (top) pickCommand(top);
              else send();
            }
          }}
        />
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
