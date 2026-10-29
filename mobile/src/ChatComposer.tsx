import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type { ChatModels, ChatModes, ChatThought } from "../../src/chat/chatTypes";
import { AdaptiveSheet } from "./AdaptiveSheet";
import { useBackHandler, useEscape } from "./back";
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
}

/**
 * The message card: the text field first, then one row of actions - the mode
 * pill on the left (it opens the list of modes) and the model pill beside it, the mic and the send button
 * (the stop button while a turn runs and the box is empty) on the right, both
 * round and 56px for the thumb. While dictating, a waveform and a timer sit
 * where the placeholder was.
 */
export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({
  chatId,
  agent,
  busy,
  modes,
  onMode,
  models = null,
  thought = null,
  onModel,
  onThought,
  onSend,
  onStop,
}, ref) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(chatId) ?? "");
  const [modeOpen, setModeOpen] = useState(false);
  const [defaultMode, setDefault] = useState(() => getDefaultMode(agent));
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
  const send = () => {
    if (!text.trim()) return;
    tapFeedback();
    dictation.cancel();
    onSend(text);
    change("");
  };
  const current = modes?.availableModes.find((m) => m.id === modes.currentModeId);

  return (
    <div className="chat-composer">
      {dictation.error && (
        <div className="chat-notice" role="alert">
          <span className="chat-notice-text">{dictation.error}</span>
          <button type="button" aria-label={t("dictateDismiss")} onClick={dictation.dismissError}>
            <CloseIcon />
          </button>
        </div>
      )}
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
        <textarea
          ref={box}
          className="chat-input"
          rows={1}
          value={text}
          placeholder={listening ? "" : t("chatPlaceholder")}
          aria-label={t("chatPlaceholder")}
          autoCapitalize="sentences"
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && hasKeyboard()) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="chat-actions">
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
          <div className="chat-actions-end">
            {dictation.supported && (
              <button type="button" {...keepFocus} className={"chat-round chat-mic" + (listening ? " is-listening" : "")} aria-label={t("dictate")} aria-pressed={listening} onClick={dictate}>
                <MicIcon />
              </button>
            )}
            {busy && !text.trim() ? (
              <button type="button" {...keepFocus} className="chat-round is-stop" aria-label={t("chatStopTurn")} onClick={onStop}>
                <StopIcon />
              </button>
            ) : (
              <button type="button" {...keepFocus} className="chat-round is-send" aria-label={t("chatSend")} disabled={!text.trim()} onClick={send}>
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
