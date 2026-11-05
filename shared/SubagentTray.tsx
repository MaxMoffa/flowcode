import { useEffect, useRef, useState } from "react";
import { subagentInfo, type SubagentItem } from "../src/chat/chatTimeline";

/** How long a subagent missing from the running list keeps its row before leaving. */
const LEAVE_GRACE_MS = 2500;

type TrayRow ={ item: SubagentItem; leaving: boolean };

const OPEN_ICON = (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

/** Running children behind the composer, shared by desktop and mobile. From two of them on they fold into one line that opens upward. */
export function SubagentTray({
  items,
  onOpen,
  openLabel,
  selectedId = null,
  expanded,
  onToggle,
  onUngrouped,
  countLabel,
  hint = "",
  hintOpen = "",
}: {
  items: SubagentItem[];
  onOpen?: (id: string) => void;
  openLabel: string;
  /** The row the keyboard is on (desktop). */
  selectedId?: string | null;
  expanded: boolean;
  onToggle: () => void;
  /** Down to a single row: there is nothing left to fold, so the host drops its expanded state. */
  onUngrouped: () => void;
  countLabel: (n: number) => string;
  /** Collapsed / expanded hint next to the count (the keys, on desktop). */
  hint?: string;
  hintOpen?: string;
}) {
  const [rows, setRows] = useState<TrayRow[]>([]);
  const [, setTick] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const graceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setRows((prev) => {
      const current = new Map(items.map((item) => [item.id, item]));
      const kept = new Set<string>();
      const next: TrayRow[] = [];
      for (const row of prev) {
        const fresh = current.get(row.item.id);
        if (fresh) {
          kept.add(row.item.id);
          const grace = graceTimers.current.get(row.item.id);
          if (grace !== undefined) {
            clearTimeout(grace);
            graceTimers.current.delete(row.item.id);
          }
          next.push({ item: fresh, leaving: false });
        } else if (row.leaving) {
          next.push(row);
        } else {
          // Gone from the running list: a subagent between two steps looks finished for a moment,
          // so the row stays for a grace period before it leaves.
          const id = row.item.id;
          if (!graceTimers.current.has(id)) {
            graceTimers.current.set(
              id,
              setTimeout(() => {
                graceTimers.current.delete(id);
                setRows((cur) => cur.map((r) => (r.item.id === id ? { ...r, leaving: true } : r)));
              }, LEAVE_GRACE_MS),
            );
          }
          next.push(row);
        }
      }
      for (const item of items) if (!kept.has(item.id)) next.push({ item, leaving: false });
      return next;
    });
  }, [items]);

  useEffect(() => {
    for (const row of rows) {
      const id = row.item.id;
      const pending = timers.current.get(id);
      if (!row.leaving) {
        if (pending !== undefined) {
          clearTimeout(pending);
          timers.current.delete(id);
        }
      } else if (pending === undefined) {
        timers.current.set(id, setTimeout(() => {
          timers.current.delete(id);
          setRows((prev) => prev.filter((r) => !(r.leaving && r.item.id === id)));
        }, 450));
      }
    }
  }, [rows]);

  useEffect(() => {
    const pending = timers.current;
    const grace = graceTimers.current;
    return () => {
      pending.forEach((timer) => clearTimeout(timer));
      pending.clear();
      grace.forEach((timer) => clearTimeout(timer));
      grace.clear();
    };
  }, []);

  const anyActive = rows.some((row) => !row.leaving);
  useEffect(() => {
    if (!anyActive) return;
    const interval = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, [anyActive]);

  // Rows in their grace period still count: a subagent between two steps must not refold the card.
  const liveCount = rows.filter((row) => !row.leaving).length;
  const grouped = liveCount > 1;
  useEffect(() => {
    if (!grouped && expanded) onUngrouped();
  }, [grouped, expanded, onUngrouped]);
  useEffect(() => {
    listRef.current?.querySelector(".is-selected")?.scrollIntoView({ block: "nearest" });
  }, [selectedId, expanded]);

  if (rows.length === 0) return null;
  return (
    <div className={`chat-subtray${grouped ? " is-grouped" : ""}`} role="status">
      {(!grouped || expanded) && (
        <div ref={listRef} className="chat-subtray-list">
          {rows.map(({ item, leaving }) => {
            const { type, description } = subagentInfo(item.call);
            const elapsed = Math.max(0, Math.floor((Date.now() - (item.call.startedAt ?? Date.now())) / 1000));
            const className = `chat-subtray-row${leaving ? " is-leaving" : ""}${selectedId === item.id ? " is-selected" : ""}`;
            const info = (
              <>
                <span className="chat-subtray-dot" aria-hidden="true" />
                <span className="chat-subtray-name">{type ?? "agent"}</span>
                <span className="chat-subtray-task" title={description}>{description}</span>
                <span className="chat-subtray-time">{`${elapsed}s`}</span>
              </>
            );
            if (grouped && onOpen) {
              return (
                <button key={item.id} type="button" className={className} title={openLabel} onClick={() => onOpen(item.id)}>
                  {info}
                  <span className="chat-subtray-go">{OPEN_ICON}</span>
                </button>
              );
            }
            return (
              <div key={item.id} className={className}>
                {info}
                {onOpen && (
                  <button type="button" className="chat-subcard-open" title={openLabel} aria-label={openLabel} onClick={() => onOpen(item.id)}>
                    {OPEN_ICON}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {grouped && (
        <button type="button" className="chat-subtray-head" aria-expanded={expanded} onClick={onToggle}>
          <span className="chat-subtray-dot" aria-hidden="true" />
          <span className="chat-subtray-count">{countLabel(liveCount)}</span>
          <span className="chat-subtray-hint">{expanded ? hintOpen : hint}</span>
          <svg className="chat-subtray-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 15 6-6 6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}
