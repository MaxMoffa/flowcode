import { useState } from "react";
import { useI18n } from "../i18n";
import { delegateFinished, type DelegateInfo, type DelegateRequest } from "../chat/chatModel";
import { useTabDelegation } from "../chat/delegateStore";
import { agentCliIcon } from "../plugins/icons";
import type { ActiveAgent } from "./activeAgent";
import { cliName } from "./cliInfo";
import { activeCount, delegateTone, TONE_CHIP, TONE_LABEL } from "./delegateView";

interface DelegatesPaneProps {
  agent: ActiveAgent;
  /** Opens a delegate's chat in a tab next to its orchestrator's. */
  onOpenDelegate?: (parentTabId: string, delegate: DelegateInfo, wslDistro: string | null) => void;
  /** Brings a tab to the front. */
  onFocusTab?: (tabId: string) => void;
}

const OPEN_ICON = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

const BACK_ICON = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

/** Moves the keyboard to the delegates' request card in the composer, if one is on screen. */
function focusRequestCard(): boolean {
  const card = [...document.querySelectorAll<HTMLElement>(".chat-ask")].find((el) => el.offsetParent !== null);
  card?.focus();
  return !!card;
}

/** The first non-empty line of a delegate's answer. */
function firstLine(text: string | undefined): string {
  return text?.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

/** The Delegates tab: on an orchestrator its delegated tasks, on a delegated child who asked for it and how it stands. */
export function DelegatesPane({ agent, onOpenDelegate, onFocusTab }: DelegatesPaneProps) {
  const own = useTabDelegation(agent.tabId);
  const parent = useTabDelegation(agent.delegateOf?.parentTabId ?? null);
  if (agent.delegateOf) {
    const of = agent.delegateOf;
    return <ChildBlock of={of} delegate={parent.delegates.find((d) => d.taskId === of.taskId)} onFocusTab={onFocusTab} />;
  }
  const tabId = agent.tabId;
  const open = tabId && onOpenDelegate ? (d: DelegateInfo) => onOpenDelegate(tabId, d, own.wslDistro) : undefined;
  return <OrchestratorBlock delegates={own.delegates} requests={own.requests} onOpen={open} />;
}

function StatusChip({ status }: { status: string }) {
  const { t } = useI18n();
  const tone = delegateTone(status);
  return <span className={`agents-sidebar-chip agents-sidebar-chip--${TONE_CHIP[tone]}`}>{t(TONE_LABEL[tone])}</span>;
}

function OrchestratorBlock({ delegates, requests, onOpen }: { delegates: DelegateInfo[]; requests: DelegateRequest[]; onOpen?: (d: DelegateInfo) => void }) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string | null>(null);
  if (delegates.length === 0) return <div className="agent-insight-note">{t("agentPanel.deleg.empty")}</div>;
  const peek = delegates.find((d) => d.taskId === picked) ?? delegates[0];
  return (
    <>
      <div className="agent-insight-title">
        {t("agentPanel.deleg.title")} <b>{delegates.length}</b>
        <span className="aside">{t("agentPanel.deleg.active", { n: activeCount(delegates) })}</span>
      </div>
      {delegates.map((d) => (
        <DelegateRow key={d.taskId} delegate={d} selected={d.taskId === peek.taskId} onPick={() => setPicked(d.taskId)} onOpen={onOpen} />
      ))}
      <DelegatePeek delegate={peek} request={requests.find((r) => r.taskId === peek.taskId)} onOpen={onOpen} />
    </>
  );
}

function DelegateRow({ delegate: d, selected, onPick, onOpen }: { delegate: DelegateInfo; selected: boolean; onPick: () => void; onOpen?: (d: DelegateInfo) => void }) {
  const { t } = useI18n();
  const tone = delegateTone(d.status);
  const live = delegateFinished(d) ? (d.status === "done" ? firstLine(d.result) : (d.error ?? "")) : (d.lastActivity ?? t("agentPanel.deleg.starting"));
  return (
    <div
      className={"agents-sidebar-row agent-insight-deleg-row" + (selected ? " is-active" : "")}
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <span className="agents-sidebar-icon">{agentCliIcon(d.agent)}</span>
      <span className="agents-sidebar-row-body">
        <span className="agents-sidebar-tab-label">{d.title || cliName(d.agent)}</span>
        <span className="agent-insight-live" title={live}>
          {live}
        </span>
        <span className={`agent-insight-mini is-${tone}`}>
          <i style={{ width: tone === "waiting" ? "60%" : "100%" }} />
        </span>
      </span>
      <StatusChip status={d.status} />
      {onOpen && (
        <button
          type="button"
          className="agents-sidebar-stop"
          title={t("agentPanel.deleg.open")}
          aria-label={t("agentPanel.deleg.open")}
          onClick={(e) => {
            e.stopPropagation();
            onOpen(d);
          }}
        >
          {OPEN_ICON}
        </button>
      )}
    </div>
  );
}

function DelegatePeek({ delegate: d, request, onOpen }: { delegate: DelegateInfo; request?: DelegateRequest; onOpen?: (d: DelegateInfo) => void }) {
  const { t } = useI18n();
  // The card in the orchestrator's composer when it is on screen, else the child's own chat.
  const reply = () => {
    if (!focusRequestCard()) onOpen?.(d);
  };
  return (
    <div className="agent-insight-peek">
      <div className="agent-insight-peek-head">
        <span className="agent-insight-peek-tag">{cliName(d.agent)}</span>
        <b title={d.title}>{d.title}</b>
        {onOpen && (
          <button type="button" className="agent-insight-btn sm" onClick={() => onOpen(d)}>
            {t("agentPanel.deleg.open")} {OPEN_ICON}
          </button>
        )}
      </div>
      {d.prompt && (
        <div className="agent-insight-peek-block">
          <span className="agent-insight-subtitle">{t("agentPanel.deleg.prompt")}</span>
          <div className="agent-insight-peek-text">{d.prompt}</div>
        </div>
      )}
      <div className="agent-insight-peek-block">
        <span className="agent-insight-subtitle">{t("agentPanel.deleg.activity")}</span>
        <div className="agent-insight-peek-step">
          <span className={"agent-insight-peek-dot" + (d.status === "running" ? " is-live" : "")} />
          <span className="agent-insight-peek-mono">{d.lastActivity ?? (delegateFinished(d) ? "—" : t("agentPanel.deleg.starting"))}</span>
          <span className="agent-insight-muted">{t("agentPanel.deleg.steps", { count: d.steps })}</span>
        </div>
      </div>
      {request && (
        <div className="agent-insight-peek-perm">
          <span>
            <b>{request.kind === "ask" ? t("agentPanel.deleg.needAnswer") : t("agentPanel.deleg.needPermission")}</b>
            {request.kind === "ask" ? request.message : request.toolCall?.title}
          </span>
          <button type="button" className="agent-insight-btn sm" onClick={reply}>
            {t("agentPanel.deleg.reply")}
          </button>
        </div>
      )}
      {d.status === "done" && d.result && (
        <div className="agent-insight-peek-block">
          <span className="agent-insight-subtitle">{t("agentPanel.deleg.result")}</span>
          <div className="agent-insight-peek-text is-result">{d.result}</div>
        </div>
      )}
      {d.error && (
        <div className="agent-insight-peek-block">
          <span className="agent-insight-subtitle">{t("agentPanel.deleg.error")}</span>
          <div className="agent-insight-peek-text">{d.error}</div>
        </div>
      )}
    </div>
  );
}

function ChildBlock({ of, delegate, onFocusTab }: { of: NonNullable<ActiveAgent["delegateOf"]>; delegate?: DelegateInfo; onFocusTab?: (tabId: string) => void }) {
  const { t } = useI18n();
  return (
    <>
      <div className="agent-insight-title">{t("agentPanel.deleg.from")}</div>
      <button type="button" className="agents-sidebar-row agent-insight-parent" onClick={() => onFocusTab?.(of.parentTabId)}>
        <span className="agents-sidebar-icon">{agentCliIcon(of.parentAgent)}</span>
        <span className="agents-sidebar-row-body">
          <span className="agents-sidebar-tab-label">{of.parentLabel || cliName(of.parentAgent)}</span>
          <span className="agents-sidebar-meta">{t("agentPanel.deleg.fromHint")}</span>
        </span>
        <span className="agents-sidebar-stop" aria-hidden="true">
          {BACK_ICON}
        </span>
      </button>
      {delegate && (
        <div className="agent-insight-section">
          <div className="agent-insight-row">
            <span className="agent-insight-row-name agent-insight-muted">{t("agentPanel.deleg.activity")}</span>
            <StatusChip status={delegate.status} />
          </div>
          {!delegateFinished(delegate) && <div className="agent-insight-peek-mono">{delegate.lastActivity ?? t("agentPanel.deleg.starting")}</div>}
        </div>
      )}
      <div className="agent-insight-note">{t("agentPanel.deleg.childNote")}</div>
    </>
  );
}
