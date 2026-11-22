import { useContext, useRef } from "react";
import { useI18n } from "../i18n";
import { useOutsideClose } from "../hooks/useOutsideClose";
import { useActiveAgent } from "./activeAgent";
import { useAgentContextFill } from "./AgentInsightPanel";
import {
  AgentPanelHostContext,
  getAgentPanelPinned,
  setAgentPanelPinned,
  setAgentPopoverOpen,
  toggleAgentPopover,
  useAgentPanelPinned,
  useAgentPopoverOpen,
} from "./agentPanelState";
import "./agent-pill.css";

const RADIUS = 7.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The header's context pill: a fill ring and percentage for the agent of this
 * tab, opening the agent panel as a popover (or the pinned sidebar copy). */
export function AgentContextPill({ tabId }: { tabId?: string }) {
  const agent = useActiveAgent();
  const host = useContext(AgentPanelHostContext);
  if (!agent || !tabId || agent.tabId !== tabId || !host) return null;
  return <Pill agent={agent} host={host} />;
}

function Pill({ agent, host }: { agent: NonNullable<ReturnType<typeof useActiveAgent>>; host: NonNullable<React.ContextType<typeof AgentPanelHostContext>> }) {
  const { t } = useI18n();
  const { percent, warn } = useAgentContextFill(agent);
  const popoverOpen = useAgentPopoverOpen();
  const pinned = useAgentPanelPinned();
  const anchorRef = useRef<HTMLDivElement>(null);
  const open = popoverOpen && !pinned;

  // The toolbar's Agent button toggles the popover itself: closing on its mousedown would reopen it on the click.
  useOutsideClose(open, [anchorRef], () => setAgentPopoverOpen(false), {
    escape: true,
    ignore: (target) => !!target.closest('[data-plugin="toggleAgentsSidebar"]'),
  });

  const onClick = () => {
    if (getAgentPanelPinned()) host.showPinned();
    else toggleAgentPopover();
  };

  return (
    <div className="agent-pill-anchor" ref={anchorRef}>
      <button
        type="button"
        className={"agent-pill" + (warn ? " is-warn" : "") + (open ? " is-open" : "")}
        title={t("agentPanel.pill.title")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
      >
        <svg className="agent-pill-ring" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <circle className="agent-pill-track" cx="8" cy="8" r={RADIUS} fill="none" strokeWidth="2.4" />
          <circle
            className="agent-pill-progress"
            cx="8"
            cy="8"
            r={RADIUS}
            fill="none"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeDasharray={`${CIRCUMFERENCE * (percent ?? 0)} ${CIRCUMFERENCE}`}
            transform="rotate(-90 8 8)"
          />
        </svg>
        <span>{percent === null ? "—" : `${Math.round(percent * 100)}%`}</span>
      </button>
      {open && (
        <div className="agent-pop" role="dialog" aria-label={t("agentPanel.pill.title")}>
          {host.renderPanel(() => {
            setAgentPanelPinned(true);
            setAgentPopoverOpen(false);
            host.showPinned();
          })}
          <div className="agent-pop-foot">
            <kbd>Ctrl+Shift+A</kbd> {t("agentPanel.popFoot")}
          </div>
        </div>
      )}
    </div>
  );
}
