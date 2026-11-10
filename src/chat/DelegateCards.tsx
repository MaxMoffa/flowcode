import { memo, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n, type MessageKey } from "../i18n";
import { cliName } from "../agents/cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { AskComposer } from "./AskComposer";
import type { AskQuestion } from "./askQuestions";
import { delegateRequestKey, type ChatItem, type DelegateInfo, type DelegateRequest, type DelegateStatus } from "./chatModel";
import { delegateAgentColor, delegateCounts, delegateDuration, delegatesActive, DELEGATE_STATUS_ORDER, firstLine } from "./delegateStrip";
import { permissionDetail } from "./permissionDetail";
import "./delegates.css";

const SWAP_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </svg>
);

const CHEVRON_ICON = (
  <svg className="chat-dstrip-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** The summary word that follows a count of delegates in one status. */
function sumKey(status: DelegateStatus, n: number): MessageKey {
  if (status === "running") return "chat.delegate.sum.running";
  if (status === "waiting_for_user") return n === 1 ? "chat.delegate.sum.waiting.one" : "chat.delegate.sum.waiting.other";
  if (status === "done") return n === 1 ? "chat.delegate.sum.done.one" : "chat.delegate.sum.done.other";
  if (status === "failed") return n === 1 ? "chat.delegate.sum.failed.one" : "chat.delegate.sum.failed.other";
  return n === 1 ? "chat.delegate.sum.cancelled.one" : "chat.delegate.sum.cancelled.other";
}

/** One delegate as a row of the open strip: its status, logo, title, what it does now (or how it ended), and its steps or duration. */
function DelegateRow({ delegate: d, onOpen }: { delegate: DelegateInfo; onOpen: (d: DelegateInfo) => void }) {
  const { t } = useI18n();
  let mark: ReactNode;
  let live: string;
  switch (d.status) {
    case "running":
      mark = <span className="chat-spinner" aria-hidden="true" />;
      live = d.lastActivity ?? t("chat.delegate.starting");
      break;
    case "waiting_for_user":
      mark = "●";
      live = t("chat.delegate.waiting");
      break;
    case "done":
      mark = "✓";
      live = firstLine(d.result) || t("chat.subagent.done");
      break;
    case "failed":
      mark = "✕";
      live = firstLine(d.error) || t("chat.delegate.failed");
      break;
    default:
      mark = "■";
      live = t("chat.delegate.cancelled");
  }
  const time = d.status === "running" || d.status === "waiting_for_user" ? t("chat.delegate.steps", { count: d.steps }) : delegateDuration(d);
  return (
    <button
      type="button"
      className={`chat-dstrip-row is-${d.status}`}
      style={{ "--agent": delegateAgentColor(d.agent) } as CSSProperties}
      title={`${t("chat.delegate.open")} · ${cliName(d.agent)}`}
      onClick={() => onOpen(d)}
    >
      <span className="chat-dstrip-ic">{mark}</span>
      <span className="chat-dstrip-logo is-row">{agentCliIcon(d.agent)}</span>
      <span className="chat-dstrip-title">{d.title}</span>
      <span className="chat-dstrip-sep" aria-hidden="true">
        —
      </span>
      <span className={`chat-dstrip-live${d.status === "running" ? " is-mono" : ""}`}>{live}</span>
      <span className="chat-dstrip-time">{time}</span>
    </button>
  );
}

/** The tasks an agent handed to others in one go: a compact strip with the count, the agents' logos and a summary per status. It opens to a row per delegate; it is open while something runs or waits, closes by itself when all have finished, and the user can toggle it. */
export const DelegateCards = memo(function DelegateCards({ items, onOpen }: { items: DelegateInfo[]; onOpen: (d: DelegateInfo) => void }) {
  const { t } = useI18n();
  const counts = delegateCounts(items);
  const active = delegatesActive(counts);
  const [manual, setManual] = useState<boolean | null>(null);
  useEffect(() => setManual(null), [active]);
  const open = manual ?? active;
  return (
    <div className={`chat-dstrip${open ? " is-open" : ""}`}>
      <button type="button" className="chat-dstrip-head" aria-expanded={open} onClick={() => setManual(!open)}>
        <span className="chat-dstrip-swap">{SWAP_ICON}</span>
        <b className="chat-dstrip-label">{items.length === 1 ? t("chat.delegate.stripOne", { agent: cliName(items[0].agent) }) : t("chat.delegate.stripMany", { count: items.length })}</b>
        <span className="chat-dstrip-stack">
          {items.map((d) => (
            <span key={d.taskId} className="chat-dstrip-logo" style={{ "--agent": delegateAgentColor(d.agent) } as CSSProperties} title={cliName(d.agent)}>
              {agentCliIcon(d.agent)}
            </span>
          ))}
        </span>
        <span className="chat-dstrip-sum">
          {DELEGATE_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className={`chat-dstrip-count is-${s}`}>
              <i />
              {counts[s]} {t(sumKey(s, counts[s]))}
            </span>
          ))}
        </span>
        {CHEVRON_ICON}
      </button>
      {open && <div className="chat-dstrip-rows">{items.map((d) => <DelegateRow key={d.taskId} delegate={d} onOpen={onOpen} />)}</div>}
    </div>
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
