import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { DelegateInfo, DelegateStatus } from "../../src/chat/chatModel";
import { DELEGATE_STATUS_ORDER, delegateAgentColor, delegateCounts, delegateDuration, delegatesActive, firstLine } from "../../src/chat/delegateStrip";
import { agentName } from "./common";
import { t, type Key } from "./i18n";
import { AgentLogo } from "./icons";

/** The word for each status in the summary's aria-label (the phone shows dots and counts only). */
const SUM_KEY: Record<DelegateStatus, Key> = {
  running: "chatDelegateSumRunning",
  waiting_for_user: "chatDelegateSumWaiting",
  done: "chatDelegateSumDone",
  failed: "chatDelegateSumFailed",
  cancelled: "chatDelegateSumCancelled",
};

const SWAP_ICON = (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 8h13l-3-3M20 16H7l3 3" />
  </svg>
);

const CHEV_ICON = (
  <svg className="chat-dstrip-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

/** The mark before a row's title: a spinner while it runs, a glyph once it waits or ends. */
function StatusMark({ status }: { status: DelegateStatus }) {
  if (status === "running") return <span className="chat-spinner" aria-hidden="true" />;
  const glyph = status === "waiting_for_user" ? "●" : status === "done" ? "✓" : status === "failed" ? "✕" : "■";
  return <span aria-hidden="true">{glyph}</span>;
}

/** The second line of a row: what the delegate does now, or why it stopped. */
function liveLine(d: DelegateInfo): ReactNode {
  switch (d.status) {
    case "running":
      return <span className="chat-dstrip-live is-mono">{d.lastActivity ?? t("chatDelegateStarting")}</span>;
    case "waiting_for_user":
      return <span className="chat-dstrip-live">{t("chatDelegateWaiting")}</span>;
    case "cancelled":
      return <span className="chat-dstrip-live">{t("chatDelegateCancelled")}</span>;
    case "failed":
      return <span className="chat-dstrip-live is-failed">{firstLine(d.error) || t("chatDelegateFailed")}</span>;
    default:
      return <span className="chat-dstrip-live">{firstLine(d.result) || t("chatSubDone")}</span>;
  }
}

/** One delegate as a row: status, logo, title, steps or duration, and what it does or why it stopped. Tapping opens its chat when `onOpen` is given. */
function DelegateRow({ d, onOpen }: { d: DelegateInfo; onOpen?: (childChatId: string) => void }) {
  const className = `chat-dstrip-row is-${d.status}`;
  const style = { "--agent": delegateAgentColor(d.agent) } as CSSProperties;
  const body = (
    <>
      <span className="chat-dstrip-ic">
        <StatusMark status={d.status} />
      </span>
      <span className="chat-dstrip-row-logo">
        <AgentLogo cli={d.agent} size={16} />
      </span>
      <span className="chat-dstrip-title">{d.title}</span>
      <span className="chat-dstrip-time">{d.status === "running" || d.status === "waiting_for_user" ? t("chatDelegateSteps", { n: d.steps }) : delegateDuration(d)}</span>
      {liveLine(d)}
    </>
  );
  return onOpen ? (
    <button type="button" className={className} style={style} onClick={() => onOpen(d.childChatId)}>
      {body}
    </button>
  ) : (
    <div className={className} style={style}>
      {body}
    </div>
  );
}

/** The cross-agent delegations of one launch as a compact strip under the agent's text: the head says what it is and how it goes (logos, a dot and count per status), tapping it opens the rows. It opens by itself while something runs or waits, and closes when all are done. */
export function DelegateStrip({ items, onOpen }: { items: DelegateInfo[]; onOpen?: (childChatId: string) => void }) {
  const counts = delegateCounts(items);
  const active = delegatesActive(counts);
  const [manual, setManual] = useState<boolean | null>(null);
  useEffect(() => setManual(null), [active]);
  const open = manual ?? active;
  const label = items.length === 1 ? t("chatDelegateOne", { agent: agentName(items[0].agent) }) : t("chatDelegateMany", { n: items.length });
  return (
    <div className={"chat-dstrip" + (open ? " is-open" : "")}>
      <button type="button" className="chat-dstrip-head" aria-expanded={open} onClick={() => setManual(!open)}>
        <span className="chat-dstrip-swap">{SWAP_ICON}</span>
        <b>{label}</b>
        <span className="chat-dstrip-stack">
          {items.map((d) => (
            <span key={d.taskId} className="chat-dstrip-logo" style={{ "--agent": delegateAgentColor(d.agent) } as CSSProperties}>
              <AgentLogo cli={d.agent} size={14} />
            </span>
          ))}
        </span>
        <span className="chat-dstrip-sum">
          {DELEGATE_STATUS_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <span key={s} className={`chat-dstrip-count is-${s}`} aria-label={`${counts[s]} ${t(SUM_KEY[s])}`}>
              <i aria-hidden="true" />
              {counts[s]}
            </span>
          ))}
        </span>
        {CHEV_ICON}
      </button>
      {open && (
        <div className="chat-dstrip-rows">
          {items.map((d) => (
            <DelegateRow key={d.taskId} d={d} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
