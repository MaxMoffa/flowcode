import { useEffect, useRef, useState } from "react";
import { subagentInfo, type SubagentItem } from "../src/chat/chatTimeline";

/** How long a subagent missing from the running list keeps its row before leaving. */
const LEAVE_GRACE_MS = 2500;

type TrayRow ={ item: SubagentItem; leaving: boolean };

/** Running children behind the composer, shared by desktop and mobile. */
export function SubagentTray({ items, onOpen, openLabel }: { items: SubagentItem[]; onOpen?: (id: string) => void; openLabel: string }) {
  const [rows, setRows] = useState<TrayRow[]>([]);
  const [, setTick] = useState(0);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const graceTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

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

  if (rows.length === 0) return null;
  return (
    <div className="chat-subtray" role="status">
      <div className="chat-subtray-list">
        {rows.map(({ item, leaving }) => {
          const { type, description } = subagentInfo(item.call);
          const elapsed = Math.max(0, Math.floor((Date.now() - (item.call.startedAt ?? Date.now())) / 1000));
          return (
            <div key={item.id} className={`chat-subtray-row${leaving ? " is-leaving" : ""}`}>
              <span className="chat-subtray-dot" aria-hidden="true" />
              <span className="chat-subtray-name">{type ?? "agent"}</span>
              <span className="chat-subtray-task" title={description}>{description}</span>
              <span className="chat-subtray-time">{`${elapsed}s`}</span>
              {onOpen && (
                <button type="button" className="chat-subcard-open" title={openLabel} aria-label={openLabel} onClick={() => onOpen(item.id)}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M7 17 17 7M8 7h9v9" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
