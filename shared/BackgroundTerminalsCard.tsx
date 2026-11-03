import { useEffect, useState } from "react";
import type { BackgroundTerminal } from "../src/chat/backgroundTerminals";

/** Characters of a terminal's output drawn. */
const OUTPUT_MAX = 3000;

function elapsed(startedAt: number | null, now: number): string {
  if (startedAt === null) return "";
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** The words of the card, from the host app's translations. */
export interface BackgroundTerminalsLabels {
  count: (n: number) => string;
  /** Collapsed / expanded hint next to the count (the keys, on desktop); may be empty. */
  hint: string;
  hintOpen: string;
  noOutput: string;
}

/** The agent's running background commands: a one-line card tucked under the composer (as wide as it), opening into a list. */
export function BackgroundTerminalsCard({
  terminals,
  expanded,
  onToggle,
  selected,
  openId,
  onRow,
  idPrefix,
  labels,
}: {
  terminals: BackgroundTerminal[];
  expanded: boolean;
  onToggle: () => void;
  /** The row the keyboard is on, -1 for none. */
  selected: number;
  /** The row whose output is shown. */
  openId: string | null;
  onRow: (index: number) => void;
  idPrefix: string;
  labels: BackgroundTerminalsLabels;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expanded) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expanded]);
  if (terminals.length === 0) return null;
  return (
    <div className="chat-termcard">
      <button type="button" className="chat-termcard-head" aria-expanded={expanded} onClick={onToggle}>
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m5 7 5 5-5 5m8 0h6" />
        </svg>
        <span className="chat-termcard-count">{labels.count(terminals.length)}</span>
        <span className="chat-termcard-hint">{expanded ? labels.hintOpen : labels.hint}</span>
        <svg className="chat-termcard-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 15 6-6 6 6" />
        </svg>
      </button>
      {expanded && (
        <div className="chat-termcard-list" role="list">
          {terminals.map((term, i) => (
            <div key={term.id} role="listitem">
              <button
                type="button"
                id={`${idPrefix}-term-${i}`}
                className={`chat-termcard-row${selected === i ? " is-selected" : ""}`}
                aria-expanded={openId === term.id}
                onClick={() => onRow(i)}
                title={term.command}
              >
                <span className="chat-subtray-dot" aria-hidden="true" />
                <span className="chat-termcard-cmd">{term.command}</span>
                <span className="chat-termcard-desc">{term.description}</span>
                <span className="chat-subtray-time">{elapsed(term.startedAt, now)}</span>
              </button>
              {openId === term.id && (
                <pre className="chat-termcard-out" tabIndex={0}>
                  {term.output ? term.output.slice(-OUTPUT_MAX) : labels.noOutput}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
