import { useEffect, useMemo, useState } from "react";
import type { ChatItem } from "./chatModel";
import { findSubagent, subagentInfo, subagentState, type SubagentItem } from "./chatTimeline";

/** Which subagent's chat a tab shows (null: the main conversation). Goes back by itself when the subagent is gone (e.g. /clear); Escape and Alt+Left go back while the tab is in front. */
export function useOpenSubagent(items: ChatItem[], hidden: boolean): { openId: string | null; sub: SubagentItem | null; open: (id: string | null) => void; back: () => void } {
  const [openId, setOpenId] = useState<string | null>(null);
  const sub = useMemo(() => (openId ? findSubagent(items, openId) : null), [items, openId]);
  useEffect(() => {
    if (openId && !sub) setOpenId(null);
  }, [openId, sub]);
  const active = !!sub && !hidden;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const escape = e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".chat-menu");
      const alt = e.key === "ArrowLeft" && e.altKey && !e.ctrlKey && !e.metaKey;
      if (escape || alt) {
        e.preventDefault();
        setOpenId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
  return { openId: sub ? openId : null, sub, open: setOpenId, back: () => setOpenId(null) };
}

/** The header's breadcrumb for an open subagent: "<type> · <description>" and how it is doing. */
export function subagentHeader(sub: SubagentItem, onBack: () => void) {
  const { type, description } = subagentInfo(sub.call);
  const state = subagentState(sub);
  return { label: [type, description].filter(Boolean).join(" · "), state: state.running ? ("running" as const) : state.failed ? ("failed" as const) : ("done" as const), onBack };
}
