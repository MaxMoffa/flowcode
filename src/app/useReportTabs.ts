// Tells the backend which terminals this window holds (pty, label, cwd), so
// the Agents panel and the remote-access server can find them - and which chat
// tabs, for the remote-access server alone.
import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalHandle } from "../terminal/Terminal";
import type { AppTab, ChatTab, TermTab } from "../tabs/types";

/** Re-sent when `reportedTabsKey` or `ptyVersion` changes, and retried every
 * few seconds while some tab's shell hasn't spawned yet. */
export function useReportTabs(
  reportedTabsKey: string,
  ptyVersion: number,
  latestRef: MutableRefObject<{ tabs: AppTab[] }>,
  termRefs: MutableRefObject<Map<string, TerminalHandle>>,
) {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const report = () => {
      const tabsNow = latestRef.current.tabs.filter((t): t is TermTab => t.kind === "terminal");
      const reported = tabsNow.map((t) => ({ pty_id: termRefs.current.get(t.id)?.getPtyId() ?? null, tab_id: t.id, label: t.label, cwd: t.cwd }));
      // A chat is reported once its agent has a session: that is how the backend matches it to the running chat.
      const chats = latestRef.current.tabs
        .filter((t): t is ChatTab => t.kind === "chat" && t.sessionId !== undefined)
        .map((t) => ({ tab_id: t.id, label: t.label, session_id: t.sessionId }));
      invoke("window_report_tabs", { tabs: reported, chats }).catch(() => {});
      // Retried only while some tab's shell hasn't spawned yet (a tab still
      // on the New Tab page has none to wait for).
      if (timer !== undefined && reported.every((r, i) => r.pty_id !== null || tabsNow[i].newTab)) {
        clearInterval(timer);
        timer = undefined;
      }
    };
    report();
    timer = setInterval(report, 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedTabsKey, ptyVersion]);
}
