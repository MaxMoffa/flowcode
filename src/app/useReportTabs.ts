// Tells the backend which terminals this window holds (pty, label, cwd), so
// the Agents panel and the remote-access server can find them.
import { useEffect, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TerminalHandle } from "../terminal/Terminal";
import type { AppTab, TermTab } from "../tabs/types";

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
      const reported = latestRef.current.tabs
        .filter((t): t is TermTab => t.kind === "terminal")
        .map((t) => ({ pty_id: termRefs.current.get(t.id)?.getPtyId() ?? null, tab_id: t.id, label: t.label, cwd: t.cwd }));
      invoke("window_report_tabs", { tabs: reported }).catch(() => {});
      // Retried only while some tab's shell hasn't spawned yet.
      if (timer !== undefined && reported.every((r) => r.pty_id !== null)) {
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
