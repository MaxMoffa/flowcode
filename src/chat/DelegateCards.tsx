import { memo, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { cliName } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { AskComposer } from "./AskComposer";
import type { AskQuestion } from "./askQuestions";
import { delegateFinished, delegateRequestKey, type ChatItem, type DelegateInfo, type DelegateRequest } from "./chatModel";
import { permissionDetail } from "./permissionDetail";
import "./delegates.css";

const BOT_ICON = (
  <svg className="chat-sub-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="8" width="14" height="11" rx="3" />
    <path d="M12 4v4M9 13h.01M15 13h.01M9 16.5h6" />
  </svg>
);

const OPEN_ICON = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

/** The first non-empty line of a delegate's answer: what the card says once it is done. */
function firstLine(text: string | undefined): string {
  return text?.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** How far the bar fills: running has no known end (the bar sweeps), the others are as far as they will get. */
function barClass(d: DelegateInfo): string {
  switch (d.status) {
    case "running":
      return " is-running";
    case "waiting_for_user":
      return " is-wait";
    case "failed":
      return " is-bad";
    case "cancelled":
      return " is-stop";
    default:
      return "";
  }
}

/** One delegated task as a card (the subagent card's look): its title, who it went to, steps, what it is doing now and a bar. The open button sits over the card, not inside it. */
function DelegateCard({ delegate: d, onOpen }: { delegate: DelegateInfo; onOpen: (d: DelegateInfo) => void }) {
  const { t } = useI18n();
  const agent = cliName(d.agent);
  const seconds = delegateFinished(d) && d.endedAt !== undefined && d.startedAt > 0 ? Math.round((d.endedAt - d.startedAt) / 1000) : null;
  const time =
    d.status === "running" ? t("chat.subagent.running") : d.status === "waiting_for_user" ? t("chat.delegate.waitingShort") : seconds !== null && seconds >= 1 ? t("chat.subagent.seconds", { count: seconds }) : "";
  let live;
  if (d.status === "running") {
    live = (
      <>
        <span className="chat-spinner" aria-hidden="true" />
        <span className="chat-subcard-text is-mono">{d.lastActivity ?? t("chat.delegate.starting")}</span>
      </>
    );
  } else if (d.status === "waiting_for_user") {
    live = (
      <>
        <span className="chat-sub-mark is-wait">{"●"}</span>
        <span className="chat-subcard-text">{t("chat.delegate.waiting")}</span>
      </>
    );
  } else if (d.status === "cancelled") {
    live = (
      <>
        <span className="chat-sub-mark is-stop">{"■"}</span>
        <span className="chat-subcard-text">{t("chat.delegate.cancelled")}</span>
      </>
    );
  } else if (d.status === "failed") {
    live = (
      <>
        <span className="chat-sub-mark is-failed">{"✕"}</span>
        <span className="chat-subcard-text">{firstLine(d.error) || t("chat.delegate.failed")}</span>
      </>
    );
  } else {
    live = (
      <>
        <span className="chat-sub-mark">{"✓"}</span>
        <span className="chat-subcard-text">{firstLine(d.result) || t("chat.subagent.done")}</span>
      </>
    );
  }
  return (
    <div className="chat-subcard-wrap">
      <button type="button" className={`chat-subcard${d.status === "waiting_for_user" ? " is-wait" : ""}`} title={`${t("chat.delegate.to", { agent })} · ${d.title}`} onClick={() => onOpen(d)}>
        <span className="chat-subcard-row has-open">
          <span className="chat-delegate-logo">{agentCliIcon(d.agent)}</span>
          <span className="chat-subcard-name">{d.title}</span>
        </span>
        <span className="chat-subcard-row">
          <span className="chat-sub-tag">{t("chat.delegate.to", { agent })}</span>
          <span className="chat-subcard-pill" title={t("chat.delegate.steps", { count: d.steps })}>
            {d.steps}
          </span>
          <span className="chat-subcard-time">{time}</span>
        </span>
        <span className="chat-subcard-live">{live}</span>
        <span className={`chat-subcard-bar${barClass(d)}`} aria-hidden="true">
          <i style={{ width: d.status === "running" ? "60%" : d.status === "waiting_for_user" ? "45%" : "100%" }} />
        </span>
      </button>
      <button type="button" className="chat-subcard-open is-floating" tabIndex={-1} title={t("chat.delegate.open")} aria-label={t("chat.delegate.open")} onClick={() => onOpen(d)}>
        {OPEN_ICON}
      </button>
    </div>
  );
}

/** The tasks an agent handed to others in one go: a line saying how many (with a tag per agent that opens its chat) and a card each, side by side. */
export const DelegateCards = memo(function DelegateCards({ items, onOpen }: { items: DelegateInfo[]; onOpen: (d: DelegateInfo) => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="chat-submark">
        {BOT_ICON}
        <span className="chat-submark-text">
          <b>{t(items.length === 1 ? "chat.delegate.launched.one" : "chat.delegate.launched.other", { count: items.length })}</b>
        </span>
        {items.map((d) => (
          <button key={d.taskId} type="button" className="chat-sub-tag chat-submark-tag" title={t("chat.delegate.open")} onClick={() => onOpen(d)}>
            {cliName(d.agent)}
          </button>
        ))}
      </div>
      <div className="chat-subcards">
        <div className={`chat-subcards-grid${items.length === 1 ? " is-single" : ""}`}>
          {items.map((d) => (
            <DelegateCard key={d.taskId} delegate={d} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </>
  );
  // The timeline rebuilds the arrays on every render; the delegates keep their identity until an event changes them.
}, (a, b) => a.onOpen === b.onOpen && a.items.length === b.items.length && a.items.every((d, i) => d === b.items[i]));

/** A permission request as one single-choice question, so the composer's ask card can show it: the choices are the options, answered by number. */
function permissionAsk(request: DelegateRequest): Extract<ChatItem, { type: "ask" }> {
  const name = request.toolCall?.title ?? request.toolCall?.kind ?? "";
  const detail = permissionDetail(request.toolCall);
  const title = detail ? (name ? `${name}: ${detail}` : detail) : name;
  const question: AskQuestion = {
    key: "question_0",
    text: title,
    multi: false,
    options: (request.options ?? []).map((o) => ({ label: o.name, value: o.optionId, recommended: o.kind === "allow_once" })),
  };
  return { type: "ask", id: `delegate-ask-${delegateRequestKey(request.childChatId, request.requestId)}`, requestId: request.requestId, message: title, questions: [question] };
}

function askItem(request: DelegateRequest): Extract<ChatItem, { type: "ask" }> {
  return { type: "ask", id: `delegate-ask-${delegateRequestKey(request.childChatId, request.requestId)}`, requestId: request.requestId, message: request.message ?? "", questions: request.questions ?? [] };
}

interface DelegateRequestsProps {
  requests: DelegateRequest[];
  /** Answers a permission request in the child's chat; null cancels it. */
  onPermission: (childChatId: string, requestId: string, optionId: string | null) => void;
  onAsk: (childChatId: string, requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void;
  onOpen: (request: DelegateRequest) => void;
  autoFocus: boolean;
}

/** The delegates' open permission requests and questions, queued where the composer is: one at a time as the ask card, "1 of N" to walk through them. Answering sends the answer to the child's chat; its resolved event takes the request out. Never answered by itself. */
export function DelegateRequests({ requests, onPermission, onAsk, onOpen, autoFocus }: DelegateRequestsProps) {
  const { t } = useI18n();
  const [index, setIndex] = useState(0);
  const at = Math.min(index, requests.length - 1);
  const request = requests[at];
  const item = useMemo(() => (request.kind === "permission" ? permissionAsk(request) : askItem(request)), [request]);
  const agent = cliName(request.agent);
  const go = (step: number) => setIndex((at + step + requests.length) % requests.length);

  const head = (
    <div className="ask-head">
      <span className="chat-ask-tag">
        <span className="ask-logo">{agentCliIcon(request.agent)}</span>
        {t("chat.delegate.askTag", { agent, title: request.title })}
      </span>
      {requests.length > 1 && (
        <span className="ask-nav">
          <button type="button" className="chat-ask-btn is-ghost sm" aria-label={t("chat.delegate.prev")} title={t("chat.delegate.prev")} onClick={() => go(-1)}>
            {"‹"}
          </button>
          {requests.map((r, i) => (
            <span key={delegateRequestKey(r.childChatId, r.requestId)} className={`chat-ask-dot${i === at ? " is-on" : ""}`} />
          ))}
          <span className="chat-ask-hint">{t("chat.ask.step", { n: at + 1, total: requests.length })}</span>
          <button type="button" className="chat-ask-btn is-ghost sm" aria-label={t("chat.delegate.next")} title={t("chat.delegate.next")} onClick={() => go(1)}>
            {"›"}
          </button>
        </span>
      )}
    </div>
  );
  const actions = (
    <button type="button" className="chat-ask-btn is-ghost" onClick={() => onOpen(request)}>
      {t("chat.delegate.openChat")}
    </button>
  );

  return (
    <AskComposer
      key={delegateRequestKey(request.childChatId, request.requestId)}
      item={item}
      autoFocus={autoFocus}
      head={head}
      actions={actions}
      allowOther={request.kind === "ask"}
      onAnswer={(requestId, action, content) => {
        if (request.kind === "ask") return onAsk(request.childChatId, requestId, action, content);
        // Permission options carry their ids through the composer, even when their labels match.
        const option = action === "accept" ? request.options?.find((o) => o.optionId === content?.question_0) : undefined;
        onPermission(request.childChatId, requestId, option?.optionId ?? null);
      }}
    />
  );
}
