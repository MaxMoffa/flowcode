import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { buildAskContent, type AskAnswer, type AskOption, type AskQuestion } from "./askQuestions";
import type { ChatItem } from "./chatModel";

type AskItem = Extract<ChatItem, { type: "ask" }>;
type Answer = (requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;

interface AskComposerProps {
  item: AskItem;
  onAnswer: Answer;
  /** Take the keyboard when it appears (not when the chat is behind another view). */
  autoFocus: boolean;
  /** Replaces the "agent asks" tag: a delegate's request says who asks, and may carry a way through the queue. */
  head?: ReactNode;
  /** More buttons beside "Skip" (a delegate's "open its chat"). */
  actions?: ReactNode;
  /** The free-text "Other..." row; off for a permission request, whose answer is one of its options. */
  allowOther?: boolean;
}

/** What the pieces below share with the composer. */
interface AskLook {
  head?: ReactNode;
  actions?: ReactNode;
  allowOther: boolean;
}

/** The composer turned into the agent's question(s): a list for one, a stepper with a review for several. Keys: arrows move, 1-9 pick, Enter confirms, Esc skips. */
export function AskComposer({ item, onAnswer, autoFocus, head, actions, allowOther = true }: AskComposerProps) {
  const look: AskLook = { head, actions, allowOther };
  // A question the schema couldn't be read for still shows its message, with a way to skip it.
  const questions: AskQuestion[] = item.questions.length ? item.questions : [{ key: "question_0", text: item.message, multi: false, options: [] }];
  // The first answer wins: a second one (double click, Enter then click) would reach the backend as an unknown request.
  const answered = useRef(false);
  const answer: Answer = (requestId, action, content) => {
    if (answered.current) return;
    answered.current = true;
    onAnswer(requestId, action, content);
  };
  const skip = () => answer(item.requestId, "decline");
  return questions.length === 1 ? (
    <AskList question={questions[0]} autoFocus={autoFocus} look={look} onSkip={skip} onSend={(a) => answer(item.requestId, "accept", buildAskContent(questions, [a]))} />
  ) : (
    <AskSteps questions={questions} autoFocus={autoFocus} look={look} onSkip={skip} onSend={(a) => answer(item.requestId, "accept", buildAskContent(questions, a))} />
  );
}

function OptionText({ option }: { option: AskOption }) {
  const { t } = useI18n();
  return (
    <>
      <b>{option.label}</b>
      {option.recommended && <span className="chat-ask-badge">{t("chat.ask.recommended")}</span>}
      {option.description && <small>{option.description}</small>}
    </>
  );
}

/** Whether a key press belongs to the free-text input (typing), not to the shortcuts. */
function inInput(e: KeyboardEvent) {
  return e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
}

/** Variant for one question: numbered rows, the last one "Other..." with a text input. */
function AskList({ question, autoFocus, look, onSkip, onSend }: { question: AskQuestion; autoFocus: boolean; look: AskLook; onSkip: () => void; onSend: (a: AskAnswer) => void }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const [cur, setCur] = useState(0);
  const [picked, setPicked] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const n = question.options.length;
  const total = n + (look.allowOther ? 1 : 0);
  const multi = question.multi;
  const canSend = picked.length > 0 || custom.trim() !== "";

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus]);
  // Moving onto "Other" types there; moving off it gives the keys back.
  useEffect(() => {
    if (cur === n) otherRef.current?.focus();
    else if (document.activeElement === otherRef.current) rootRef.current?.focus();
  }, [cur, n]);

  const toggle = (i: number) => setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
  /** Single choice answers at once; a multi choice ticks the row. */
  const choose = (i: number) => {
    setCur(i);
    if (i === n) return otherRef.current?.focus();
    if (multi) toggle(i);
    else onSend({ picked: [i], custom: "" });
  };
  const send = () => onSend({ picked: multi ? picked : [], custom });

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.nativeEvent.isComposing) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape") return handled(), onSkip();
    if (e.key === "ArrowDown") return handled(), setCur((cur + 1) % total);
    if (e.key === "ArrowUp") return handled(), setCur((cur + total - 1) % total);
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      handled();
      if (multi) {
        if (canSend) send();
      } else if (cur < n && !(inInput(e) && custom.trim())) onSend({ picked: [cur], custom: "" });
      else if (custom.trim()) onSend({ picked: [], custom });
      return;
    }
    if (!inInput(e) && /^[1-9]$/.test(e.key) && Number(e.key) <= total) {
      handled();
      choose(Number(e.key) - 1);
    }
  }

  return (
    <div ref={rootRef} className="chat-composer chat-ask" tabIndex={-1} role="group" aria-label={t("chat.ask.tag")} onKeyDown={onKeyDown}>
      {look.head ?? <span className="chat-ask-tag">{t("chat.ask.tag")}</span>}
      <div className="chat-ask-q">{question.text}</div>
      <ul className="chat-ask-opts">
        {question.options.map((option, i) => (
          <li key={i} className={`chat-ask-opt${cur === i ? " is-cur" : ""}${picked.includes(i) ? " is-sel" : ""}`} onClick={() => choose(i)}>
            {multi ? <span className="chat-ask-chk" aria-hidden="true">{picked.includes(i) ? "✓" : ""}</span> : <kbd>{i + 1}</kbd>}
            <div className="chat-ask-txt">
              <OptionText option={option} />
            </div>
          </li>
        ))}
        {look.allowOther && (
          <li className={`chat-ask-opt is-other${cur === n ? " is-cur" : ""}`} onClick={() => choose(n)}>
            <kbd>{n + 1}</kbd>
            <input
              ref={otherRef}
              className="chat-ask-free"
              value={custom}
              placeholder={t("chat.ask.otherPlaceholder")}
              onFocus={() => setCur(n)}
              onChange={(e) => setCustom(e.target.value)}
            />
          </li>
        )}
      </ul>
      <div className="chat-ask-actions">
        <span className="chat-ask-hint">
          <kbd>{"↑"}</kbd>
          <kbd>{"↓"}</kbd> {t("chat.ask.hint.move")} {"·"} <kbd>{"↵"}</kbd> {multi ? t("chat.ask.hint.confirm") : t("chat.ask.hint.select")} {"·"} <kbd>Esc</kbd> {t("chat.ask.hint.skip")}
        </span>
        <span className="chat-actions-spacer" />
        {look.actions}
        <button type="button" className="chat-ask-btn is-ghost" onClick={onSkip}>
          {t("chat.ask.skip")}
        </button>
        {multi && (
          <button type="button" className="chat-ask-btn is-primary" disabled={!canSend} onClick={send}>
            {t("chat.ask.send", { n: picked.length + (custom.trim() ? 1 : 0) })}
          </button>
        )}
      </div>
    </div>
  );
}

/** Variant for several questions: one at a time as cards, then a review before sending. */
function AskSteps({ questions, autoFocus, look, onSkip, onSend }: { questions: AskQuestion[]; autoFocus: boolean; look: AskLook; onSkip: () => void; onSend: (a: AskAnswer[]) => void }) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<AskAnswer[]>(() => questions.map(() => ({ picked: [], custom: "" })));
  const count = questions.length;
  const review = step >= count;
  const q = questions[Math.min(step, count - 1)];

  useEffect(() => {
    if (autoFocus) rootRef.current?.focus();
  }, [autoFocus]);
  // A new step gives the keys back to the box (the "Other" input of the last one may still hold them).
  useEffect(() => {
    rootRef.current?.focus();
  }, [step]);
  // The free answer grows with its text, up to the height set in the CSS.
  const customText = answers[Math.min(step, count - 1)].custom;
  useLayoutEffect(() => {
    const input = otherRef.current;
    if (!input) return;
    input.style.height = "auto";
    // 0 while the chat is hidden: stay on the one-row height.
    if (input.scrollHeight) input.style.height = `${input.scrollHeight}px`;
  }, [customText, step]);

  const update = (i: number, patch: Partial<AskAnswer>) => setAnswers((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const go = (to: number) => setStep(Math.max(0, Math.min(count, to)));
  const choose = (i: number) => {
    if (i === q.options.length) return otherRef.current?.focus();
    const a = answers[step];
    if (q.multi) update(step, { picked: a.picked.includes(i) ? a.picked.filter((x) => x !== i) : [...a.picked, i] });
    else {
      // A single choice is the answer: it replaces anything typed and moves on.
      update(step, { picked: [i], custom: "" });
      go(step + 1);
    }
  };
  const textOf = (i: number) => {
    const a = answers[i];
    const labels = [...a.picked].sort((x, y) => x - y).map((p) => questions[i].options[p]?.label);
    if (a.custom.trim()) labels.push(a.custom.trim());
    return labels.join(", ") || "—";
  };

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.nativeEvent.isComposing) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === "Escape") return handled(), onSkip();
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) {
      handled();
      if (review) onSend(answers);
      else go(step + 1);
      return;
    }
    if (!review && !inInput(e) && /^[1-9]$/.test(e.key) && Number(e.key) <= q.options.length + 1) {
      handled();
      choose(Number(e.key) - 1);
    }
  }

  const dots = (
    <div className="chat-ask-steps">
      {questions.map((_, i) => (
        <span key={i} className={`chat-ask-dot${i === step ? " is-on" : i < step || review ? " is-ok" : ""}`} />
      ))}
      <span className="chat-ask-hint">{review ? t("chat.ask.summary") : t("chat.ask.step", { n: step + 1, total: count })}</span>
    </div>
  );

  return (
    <div ref={rootRef} className="chat-composer chat-ask" tabIndex={-1} role="group" aria-label={t("chat.ask.tag")} onKeyDown={onKeyDown}>
      {look.head ?? <span className="chat-ask-tag">{t("chat.ask.tag")}</span>}
      {dots}
      {review ? (
        <>
          <div className="chat-ask-q">{t("chat.ask.confirm")}</div>
          <div className="chat-ask-review">
            {questions.map((x, i) => (
              <div key={x.key}>
                <span>{x.header ?? x.text}</span>
                <b>{textOf(i)}</b>
              </div>
            ))}
          </div>
          <div className="chat-ask-actions">
            <button type="button" className="chat-ask-btn is-ghost" onClick={() => go(step - 1)}>
              {t("chat.ask.back")}
            </button>
            <span className="chat-actions-spacer" />
            <button type="button" className="chat-ask-btn is-primary" onClick={() => onSend(answers)}>
              {t("chat.ask.sendAll")}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="chat-ask-q">
            {q.text}
            {q.multi && <span className="chat-ask-hint is-inline">{t("chat.ask.multi")}</span>}
          </div>
          <div className="chat-ask-cards">
            {q.options.map((option, i) => (
              <button key={i} type="button" className={`chat-ask-card${answers[step].picked.includes(i) ? " is-sel" : ""}`} onClick={() => choose(i)}>
                <OptionText option={option} />
              </button>
            ))}
            <div className={`chat-ask-card is-other${customText.trim() ? " is-sel" : ""}`}>
              <textarea
                ref={otherRef}
                className="chat-ask-free"
                rows={1}
                value={customText}
                placeholder={t("chat.ask.other")}
                onChange={(e) => update(step, q.multi ? { custom: e.target.value } : { custom: e.target.value, picked: [] })}
              />
            </div>
          </div>
          <div className="chat-ask-actions">
            {step > 0 ? (
              <button type="button" className="chat-ask-btn is-ghost" onClick={() => go(step - 1)}>
                {t("chat.ask.back")}
              </button>
            ) : (
              <button type="button" className="chat-ask-btn is-ghost" onClick={onSkip}>
                {t("chat.ask.skipAll")}
              </button>
            )}
            {look.actions}
            <span className="chat-actions-spacer" />
            <button type="button" className="chat-ask-btn is-primary" onClick={() => go(step + 1)}>
              {step === count - 1 ? t("chat.ask.review") : t("chat.ask.next")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
