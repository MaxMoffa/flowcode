import { useEffect, useRef } from "react";
import type { TabAgent } from "../agents/agentSessions";
import { cliName, type AgentCli } from "../agents/cliInfo";
import { getNotificationSettings } from "../notifications/notificationSettings";
import type { AppTab } from "../tabs/types";
import { t } from "../i18n";
import { addCall, clearTab, removeCallByKey } from "./callStore";

/** Same settle as the native notifications: an agent quiet for a moment between two steps hasn't finished. */
const DONE_SETTLE_MS = 3000;

const muted = (tab: AppTab) => (tab as { notifyMuted?: boolean }).notifyMuted === true;

/** Calls for what a tab's agent does on its own, without a permission or question to answer: a terminal agent that
 * waits for the user ("attention", gone once it stops), and one that finished a turn unseen ("done"). They follow the
 * notification settings and each tab's mute, like the native notifications. Terminal tabs only name their agent when
 * one is detected in them; chat tabs say it themselves. */
export function useAgentStateCalls(tabs: AppTab[], agents: Map<string, TabAgent>, doneIds: ReadonlySet<string>) {
  const waiting = useRef(new Set<string>());
  const announcedDone = useRef(new Set<string>());
  const chatStatus = useRef(new Map<string, string | undefined>());
  const knownTabs = useRef(new Set<string>());
  const settle = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => () => settle.current.forEach(clearTimeout), []);

  useEffect(() => {
    // A closed tab has nothing left to call about.
    const ids = new Set(tabs.map((tab) => tab.id));
    for (const id of knownTabs.current) if (!ids.has(id)) clearTab(id);
    knownTabs.current = ids;

    const settings = getNotificationSettings();
    const stillWaiting = new Set<string>();
    for (const tab of tabs) {
      if (tab.kind !== "terminal") continue;
      const agent = agents.get(tab.id);
      if (agent?.state !== "waiting" || muted(tab) || !settings.input) continue;
      stillWaiting.add(tab.id);
      if (waiting.current.has(tab.id)) continue;
      addCall({
        key: `attn:${tab.id}`,
        tabId: tab.id,
        agent: agent.cli as AgentCli,
        kind: "attention",
        title: t("calls.title.attention", { agent: cliName(agent.cli) }),
      });
    }
    for (const id of waiting.current) if (!stillWaiting.has(id)) removeCallByKey(`attn:${id}`);
    waiting.current = stillWaiting;

    // A terminal agent: useAgentNotifications already decided it finished unseen (setting and mute included).
    for (const id of doneIds) {
      if (announcedDone.current.has(id)) continue;
      const agent = agents.get(id);
      addCall({ key: `done:${id}`, tabId: id, agent: agent?.cli as AgentCli | undefined, kind: "done", title: t("calls.title.done", { agent: agent ? cliName(agent.cli) : "" }).trim() });
    }
    announcedDone.current = new Set(doneIds);

    // A chat: its turn ended (busy to idle).
    const seen = new Map<string, string | undefined>();
    for (const tab of tabs) {
      if (tab.kind !== "chat" || tab.delegate) continue;
      seen.set(tab.id, tab.status);
      const pendingDone = settle.current.get(tab.id);
      if (pendingDone && tab.status !== "idle") {
        clearTimeout(pendingDone);
        settle.current.delete(tab.id);
      }
      if (chatStatus.current.get(tab.id) === "busy" && tab.status === "idle" && settings.done && !muted(tab)) {
        const { id, agent } = tab;
        settle.current.set(
          id,
          setTimeout(() => {
            settle.current.delete(id);
            addCall({ key: `done:${id}`, tabId: id, agent, kind: "done", title: t("calls.title.done", { agent: cliName(agent) }) });
          }, DONE_SETTLE_MS),
        );
      }
    }
    for (const [id, timer] of settle.current) {
      if (seen.has(id)) continue;
      clearTimeout(timer);
      settle.current.delete(id);
    }
    chatStatus.current = seen;
  }, [tabs, agents, doneIds]);
}
