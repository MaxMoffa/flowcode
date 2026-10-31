import { useEffect, useRef, useState } from "react";
import { buildAskContent, type AskAnswer, type AskOption, type AskQuestion } from "../../src/chat/askQuestions";
import type { ChatItem } from "../../src/chat/chatModel";
import { tapFeedback } from "./haptics";
import { t } from "./i18n";

type Ask = Extract<ChatItem, { type: "ask" }>;

/** `accept` carries the answers; `decline` skips the question. Resolves false when the answer never left the phone. */
type Answer = (requestId: string, action: "accept" | "decline", content?: Record<string, unknown>) => Promise<boolean>;

function OptionText({ option }: { option: AskOption }) {
  return (
    <>
      <b>{option.label}</b>
      {option.recommended && <span className="chat-ask-badge">{t("chatAskRecommended")}</span>}
      {option.description && <small>{option.description}</small>}
    </>
  );
}

/** The agent's open question(s) in the composer's place: tap rows for one question, a stepper with a review for several. Drawn by the app, never by a plugin view: nothing a view can send answers it. */
export function AskPanel({ ask, agent, onAnswer }: { ask: Ask; agent: string; onAnswer: Answer }) {
  // A question the schema couldn't be read for still shows its message, with a way to skip it.
  const questions: AskQuestion[] = ask.questions.length ? ask.questions : [{ key: "question_0", text: ask.message, multi: false, options: [] }];
  /** The request just answered, until the desktop confirms it (the panel stays put but dead). */
  const [sent, setSent] = useState<string | null>(null);
  useEffect(() => setSent(null), [ask.requestId]);

  const submit = (action: "accept" | "decline", content?: Record<string, unknown>) => {
    if (sent) return;
    tapFeedback();
    const requestId = ask.requestId;
    setSent(requestId);
    // The answer never left the phone: the panel comes back so it can be given again.
    void onAnswer(requestId, action, content).then((ok) => {
      if (!ok) setSent((s) => (s === requestId ? null : s));
    });
  };
  const busy = sent !== null;
  const skip = () => submit("decline");
  const tag = t("chatAskTag", { agent });
  return (
    <div className="chat-ask" role="group" aria-label={tag}>
      <span className="chat-ask-tag">{tag}</span>
      {questions.length === 1 ? (
        <AskList key={ask.requestId} question={questions[0]} busy={busy} onSkip={skip} onSend={(a) => submit("accept", buildAskContent(questions, [a]))} />
      ) : (
        <AskSteps key={ask.requestId} questions={questions} busy={busy} onSkip={skip} onSend={(a) => submit("accept", buildAskContent(questions, a))} />
      )}
    </div>
  );
}

/** The free-text row: "Other…" until tapped, then an input. */
function OtherRow({ open, value, busy, onOpen, onChange, onEnter }: { open: boolean; value: string; busy: boolean; onOpen: () => void; onChange: (v: string) => void; onEnter: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open && !value) {
    return (
      <button type="button" className="chat-ask-opt is-other" disabled={busy} onClick={onOpen}>
        <span className="chat-ask-txt">
          <b>{t("chatAskOther")}</b>
        </span>
      </button>
    );
  }
  return (
    <div className="chat-ask-opt is-other is-typing">
      <input
        ref={ref}
        className="chat-ask-free"
        value={value}
        disabled={busy}
        enterKeyHint="send"
        placeholder={t("chatAskOtherPlaceholder")}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onEnter();
          }
        }}
      />
    </div>
  );
}

/** One question: tapping a row answers at once; a multi-select ticks rows and sends with the button. */
function AskList({ question, busy, onSkip, onSend }: { question: AskQuestion; busy: boolean; onSkip: () => void; onSend: (a: AskAnswer) => void }) {
  const [picked, setPicked] = useState<number[]>([]);
  const [custom, setCustom] = useState("");
  const [typing, setTyping] = useState(false);
  const multi = question.multi;
  const typed = custom.trim() !== "";
  const count = picked.length + (typed ? 1 : 0);
  const send = () => onSend({ picked: multi ? picked : [], custom });
  return (
    <>
      <div className="chat-ask-q">{question.text}</div>
      <div className="chat-ask-opts">
        {question.options.map((option, i) => {
          const on = picked.includes(i);
          return (
            <button
              key={i}
              type="button"
              className={"chat-ask-opt" + (on ? " is-sel" : "")}
              disabled={busy}
              aria-pressed={multi ? on : undefined}
              onClick={() => {
                if (!multi) return onSend({ picked: [i], custom: "" });
                tapFeedback();
                setPicked((p) => (on ? p.filter((x) => x !== i) : [...p, i]));
              }}
            >
              {multi && (
                <span className="chat-ask-chk" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
              )}
              <span className="chat-ask-txt">
                <OptionText option={option} />
              </span>
            </button>
          );
        })}
        <OtherRow open={typing} value={custom} busy={busy} onOpen={() => setTyping(true)} onChange={setCustom} onEnter={() => typed && send()} />
      </div>
      <div className="chat-ask-actions">
        <button type="button" className="chat-ask-btn is-ghost" disabled={busy} onClick={onSkip}>
          {t("chatAskSkip")}
        </button>
        {(multi || typed) && (
          <button type="button" className="chat-ask-btn is-primary" disabled={busy || count === 0} onClick={send}>
            {t("chatAskSend", { n: multi ? count : 1 })}
          </button>
        )}
      </div>
    </>
  );
}

/** Several questions: one at a time with progress dots, then a review before sending. */
function AskSteps({ questions, busy, onSkip, onSend }: { questions: AskQuestion[]; busy: boolean; onSkip: () => void; onSend: (a: AskAnswer[]) => void }) {
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<AskAnswer[]>(() => questions.map(() => ({ picked: [], custom: "" })));
  /** The "Other…" input is open for these questions. */
  const [typing, setTyping] = useState<number[]>([]);
  const count = questions.length;
  const review = step >= count;
  const q = questions[Math.min(step, count - 1)];
  const a = answers[Math.min(step, count - 1)];

  const update = (i: number, patch: Partial<AskAnswer>) => setAnswers((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const go = (to: number) => setStep(Math.max(0, Math.min(count, to)));
  const choose = (i: number) => {
    tapFeedback();
    if (q.multi) update(step, { picked: a.picked.includes(i) ? a.picked.filter((x) => x !== i) : [...a.picked, i] });
    else {
      // A single choice is the answer: it replaces anything typed and moves on.
      update(step, { picked: [i], custom: "" });
      go(step + 1);
    }
  };
  const textOf = (i: number) => {
    const x = answers[i];
    const labels = [...x.picked].sort((p, r) => p - r).map((p) => questions[i].options[p]?.label);
    if (x.custom.trim()) labels.push(x.custom.trim());
    return labels.join(", ") || "—";
  };

  const dots = (
    <div className="chat-ask-steps">
      {questions.map((_, i) => (
        <span key={i} className={"chat-ask-dot" + (i === step ? " is-on" : i < step || review ? " is-ok" : "")} />
      ))}
      <span className="chat-ask-hint">{review ? t("chatAskSummary") : t("chatAskStep", { n: step + 1, total: count })}</span>
    </div>
  );

  if (review) {
    return (
      <>
        {dots}
        <div className="chat-ask-q">{t("chatAskConfirm")}</div>
        <div className="chat-ask-review">
          {questions.map((x, i) => (
            <div key={x.key}>
              <span>{x.header ?? x.text}</span>
              <b>{textOf(i)}</b>
            </div>
          ))}
        </div>
        <div className="chat-ask-actions">
          <button type="button" className="chat-ask-btn is-ghost" disabled={busy} onClick={() => go(step - 1)}>
            {t("chatAskBack")}
          </button>
          <button type="button" className="chat-ask-btn is-primary" disabled={busy} onClick={() => onSend(answers)}>
            {t("chatAskSendAll")}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      {dots}
      <div className="chat-ask-q">
        {q.text}
        {q.multi && <span className="chat-ask-hint is-inline">{t("chatAskMulti")}</span>}
      </div>
      <div className="chat-ask-opts">
        {q.options.map((option, i) => {
          const on = a.picked.includes(i);
          return (
            <button key={i} type="button" className={"chat-ask-opt" + (on ? " is-sel" : "")} disabled={busy} aria-pressed={on} onClick={() => choose(i)}>
              {q.multi && (
                <span className="chat-ask-chk" aria-hidden="true">
                  {on ? "✓" : ""}
                </span>
              )}
              <span className="chat-ask-txt">
                <OptionText option={option} />
              </span>
            </button>
          );
        })}
        <OtherRow
          key={step}
          open={typing.includes(step)}
          value={a.custom}
          busy={busy}
          onOpen={() => setTyping((t) => [...t, step])}
          onChange={(v) => update(step, q.multi ? { custom: v } : { custom: v, picked: [] })}
          onEnter={() => go(step + 1)}
        />
      </div>
      <div className="chat-ask-actions">
        {step > 0 ? (
          <button type="button" className="chat-ask-btn is-ghost" disabled={busy} onClick={() => go(step - 1)}>
            {t("chatAskBack")}
          </button>
        ) : (
          <button type="button" className="chat-ask-btn is-ghost" disabled={busy} onClick={onSkip}>
            {t("chatAskSkipAll")}
          </button>
        )}
        <button type="button" className="chat-ask-btn is-primary" disabled={busy} onClick={() => go(step + 1)}>
          {step === count - 1 ? t("chatAskReview") : t("chatAskNext")}
        </button>
      </div>
    </>
  );
}
