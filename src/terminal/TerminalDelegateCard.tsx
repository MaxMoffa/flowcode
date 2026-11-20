import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { DelegateCards, DelegateRequests } from "../chat/DelegateCards";
import { delegateFinished, type DelegateInfo, type DelegateRequest } from "../chat/chatModel";
import "../chat/chat.css";
import "./terminalDelegateCard.css";

interface Props {
  delegates: DelegateInfo[];
  requests: DelegateRequest[];
  onOpen: (d: DelegateInfo) => void;
  onPermission: (childChatId: string, requestId: string, optionId: string | null) => void;
  onAsk: (childChatId: string, requestId: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>) => void | Promise<unknown>;
  /** The tab is not the one on screen. */
  hidden?: boolean;
}

/** The delegations of a terminal tab's agent, docked bottom-right over the terminal: the tasks it handed to other agents and their open requests. The x folds it to a pill; a new request opens it again. */
export function TerminalDelegateCard({ delegates, requests, onOpen, onPermission, onAsk, hidden }: Props) {
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const seen = useRef(requests.length);
  useEffect(() => {
    if (requests.length > seen.current) setCollapsed(false);
    seen.current = requests.length;
  }, [requests.length]);
  if (delegates.length === 0) return null;
  const active = delegates.filter((d) => !delegateFinished(d)).length;
  if (collapsed) {
    return (
      <div className="term-deleg is-pill">
        <button type="button" className={`term-deleg-pill${requests.length > 0 ? " is-asking" : ""}`} title={t("terminal.delegates.show")} aria-label={t("terminal.delegates.show")} onClick={() => setCollapsed(false)}>
          {active > 0 && <span className="chat-spinner" aria-hidden="true" />}
          <b>{active > 0 ? `${active}/${delegates.length}` : delegates.length}</b>
          {requests.length > 0 && <span className="term-deleg-dot" aria-hidden="true" />}
        </button>
      </div>
    );
  }
  return (
    <div className="term-deleg">
      <button type="button" className="term-deleg-x" title={t("terminal.delegates.hide")} aria-label={t("terminal.delegates.hide")} onClick={() => setCollapsed(true)}>
        {"✕"}
      </button>
      <DelegateCards items={delegates} onOpen={onOpen} />
      {requests.length > 0 && (
        <DelegateRequests requests={requests} onPermission={onPermission} onAsk={onAsk} onOpen={(r) => { const d = delegates.find((x) => x.taskId === r.taskId); if (d) onOpen(d); }} autoFocus={!hidden} />
      )}
    </div>
  );
}
