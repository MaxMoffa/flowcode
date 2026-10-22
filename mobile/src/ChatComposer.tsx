import { useLayoutEffect, useRef, useState } from "react";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";
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
  <Svg>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
  </Svg>
);

/**
 * The message box: it grows with the text, sends, stops a running turn,
 * dictates by voice (the mic sits inside the pill, right of the text), and lists
 * the messages waiting for the agent. The round button sends, or stops the turn while one runs and the box is empty.
 */
export function ChatComposer({ chatId, busy, queued, onSend, onStop, onUnqueue }: { chatId: string; busy: boolean; queued: string[]; onSend: (text: string) => void; onStop: () => void; onUnqueue: (index: number) => void }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(() => drafts.get(chatId) ?? "");

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
  const dictation = useDictation((spoken) => change(appendDictation(latest.current, spoken)), true);
  const listening = dictation.state === "listening";
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

  return (
    <div className="chat-composer">
      {queued.length > 0 && (
        <div className="chat-queue" role="list" aria-label={t("chatQueued")}>
          {queued.map((q, i) => (
            <span key={i} className="chat-queued" role="listitem">
              <span className="chat-queued-text">{q}</span>
              <button type="button" aria-label={t("chatUnqueue")} onClick={() => onUnqueue(i)}>
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      {dictation.error && (
        <div className="chat-notice" role="alert">
          <span className="chat-notice-text">{dictation.error}</span>
          <button type="button" aria-label={t("dictateDismiss")} onClick={dictation.dismissError}>
            <CloseIcon />
          </button>
        </div>
      )}
      {listening && (
        <div className="chat-listening" aria-live="polite">
          <b>{t("dictateListening")}</b>
          {dictation.partial && <span className="chat-listening-text">{dictation.partial}</span>}
        </div>
      )}
      <div className="chat-compose-row">
        <div className="chat-input-pill">
          <textarea
            ref={box}
            className="chat-input"
            rows={1}
            value={text}
            placeholder={t("chatPlaceholder")}
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
          {dictation.supported && (
            <button type="button" {...keepFocus} className={"chat-mic" + (listening ? " is-listening" : "")} aria-label={t("dictate")} aria-pressed={listening} onClick={dictate}>
              <MicIcon />
            </button>
          )}
        </div>
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
  );
}
