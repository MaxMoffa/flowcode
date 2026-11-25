import { useEffect, useMemo, useRef } from "react";
import { lastSubmitAt } from "../terminal/ptyClient";
import type { ChatTab, TermTab } from "../tabs/types";
import { useAutoResume } from "../agents/useAutoResume";
import { useAgentStateCalls } from "../calls/useAgentStateCalls";
import { useAgentNotifications } from "../notifications/useAgentNotifications";
import { watchLimitResets } from "../notifications/limitResetWatcher";
import { tabAgentOf, type AgentSession, type TabAgent } from "../agents/agentSessions";
import { activeTabProfile } from "../profiles/activeTabProfile";
import { useActiveAgentSync } from "./useActiveAgentSync";
import { useUsageWatch } from "./useUsageWatch";
import type { TabAgentsCtx } from "./shellContext";

/** The agent running in each tab, and what follows from it (notifications, auto-resume, the usage popovers' context). */
export function useTabAgents(S: TabAgentsCtx) {
  const {
    activeTerminal, agentSessions, allPluginsRef, frontChat, latestRef, ptyVersion, quickActionIds, tabs, termRefs,
  } = S;
  // Popups that pick an account profile start from the terminal in front.
  // A chat in front wins over the last terminal, like in useActiveAgentSync.
  const activeTerminalProfileId = frontChat ? frontChat.profileId : activeTerminal?.profileId;
  const activeTerminalKey = frontChat ? frontChat.id : activeTerminal?.id;
  useEffect(() => {
    if (activeTerminalKey) activeTabProfile.set({ tabId: activeTerminalKey, profileId: activeTerminalProfileId });
  }, [activeTerminalKey, activeTerminalProfileId]);
  // The Agents panel's "This project" scope only makes sense while a terminal
  // is in front: with Settings or the changelog showing, the last terminal's
  // folder may not even be a project open in this window - and the new tab
  // page (a terminal tab with no shell yet) isn't one either.
  // The agent CLI running in each terminal tab, for its logo and status in
  // the tab strip - matched by pty id, same as the Agents panel does.
  const tabAgentsRef = useRef(new Map<string, TabAgent>());
  const { tabAgents, sessionByTab } = useMemo(() => {
    const byTab = new Map<string, AgentSession>();
    // pty id -> tab, built once (a scan of the tabs per session was quadratic).
    const tabByPty = new Map<string, string>();
    for (const t of tabs) {
      if (t.kind !== "terminal") continue;
      const pty = termRefs.current.get(t.id)?.getPtyId();
      if (pty != null && !tabByPty.has(pty)) tabByPty.set(pty, t.id);
    }
    for (const session of agentSessions ?? []) {
      const tabId = tabByPty.get(session.pty_id);
      if (tabId) byTab.set(tabId, session);
    }
    const next = new Map<string, TabAgent>();
    for (const [id, session] of byTab) next.set(id, tabAgentOf(session));
    // Same agents as before (a title change re-runs this): keep the old Map,
    // so the notification and auto-resume hooks see no change.
    const prev = tabAgentsRef.current;
    const same =
      prev.size === next.size && [...next].every(([id, a]) => prev.get(id)?.cli === a.cli && prev.get(id)?.state === a.state);
    if (same) return { tabAgents: prev, sessionByTab: byTab };
    tabAgentsRef.current = next;
    return { tabAgents: next, sessionByTab: byTab };
  }, [agentSessions, tabs, ptyVersion]);
  // The active tab's agent, for the usage popovers' context section.
  const activeAgentSession = activeTerminal ? sessionByTab.get(activeTerminal.id) : undefined;
  useActiveAgentSync(
    activeAgentSession,
    activeTerminal?.label,
    frontChat,
    activeTerminal && { id: activeTerminal.id, cwd: activeTerminal.cwd ?? "" },
    frontChat?.delegate ? tabs.find((t): t is ChatTab => t.id === frontChat.delegate?.parentTabId && t.kind === "chat") : undefined,
  );
  useEffect(watchLimitResets, []);
  useUsageWatch(allPluginsRef, quickActionIds);
  const doneTabIds = useAgentNotifications(tabAgents, {
    getTab: (id) => latestRef.current.tabs.find((t): t is TermTab => t.id === id && t.kind === "terminal"),
    isViewing: (id) => document.hasFocus() && latestRef.current.activeTabId === id,
    lastSubmitAt: (id) => lastSubmitAt(termRefs.current.get(id)?.getPtyId()),
  });
  useAgentStateCalls(tabs, tabAgents, doneTabIds);
  const { armed: resumeArmed, cancel: cancelResume } = useAutoResume(tabAgents, {
    getTab: (id) => latestRef.current.tabs.find((t): t is TermTab => t.id === id && t.kind === "terminal"),
    getTerm: (id) => termRefs.current.get(id),
    lastSubmitAt: (id) => lastSubmitAt(termRefs.current.get(id)?.getPtyId()),
  });
  return {
    activeAgentSession, doneTabIds, tabAgents, sessionByTab, resumeArmed, cancelResume,
  };
}
