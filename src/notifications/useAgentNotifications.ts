import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { TabAgent } from "../agents/agentSessions";
import type { TermTab } from "../tabs/types";
import { t } from "../i18n";
import { getNotificationSettings, type NotificationKind } from "./notificationSettings";

/** An agent that goes quiet for a moment between two steps of the same job
 * would otherwise read as "finished" - the turn only counts as over once it
 * has stayed idle this long. */
const DONE_SETTLE_MS = 3000;

const CLI_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex" };

interface Watcher {
  /** The terminal tab, or undefined once it's gone. */
  getTab: (id: string) => TermTab | undefined;
  /** Whether the user is looking at that tab right now. */
  isViewing: (id: string) => boolean;
}

/** Watches the agents running in this window's tabs and raises a native
 * notification when one finishes its turn, needs the user, or exits - unless
 * that kind is switched off in Settings, the tab is muted, or the user is
 * already looking at it. Clicking the notification brings the tab forward
 * (see notify.rs). */
export function useAgentNotifications(agents: Map<string, TabAgent>, { getTab, isViewing }: Watcher) {
  const previous = useRef<Map<string, TabAgent> | null>(null);
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const before = previous.current;
    previous.current = agents;
    // The first answer only tells what was already going on.
    if (!before) return;

    function notify(tabId: string, agent: TabAgent, kind: NotificationKind) {
      const tab = getTab(tabId);
      if (!tab || tab.notifyMuted || !getNotificationSettings()[kind] || isViewing(tabId)) return;
      void invoke("notify_show", {
        label: getCurrentWindow().label,
        tabId,
        title: tab.label,
        body: t(`notifications.body.${kind}`, { agent: CLI_NAMES[agent.cli] ?? agent.cli }),
      }).catch(() => {});
    }

    for (const [tabId, agent] of agents) {
      const was = before.get(tabId);
      if (agent.state !== "idle") {
        const timer = settleTimers.current.get(tabId);
        if (timer) {
          clearTimeout(timer);
          settleTimers.current.delete(tabId);
        }
      }
      if (!was || was.state === agent.state) continue;
      if (agent.state === "waiting") notify(tabId, agent, "input");
      else if (agent.state === "idle" && was.state === "busy" && !settleTimers.current.has(tabId)) {
        settleTimers.current.set(
          tabId,
          setTimeout(() => {
            settleTimers.current.delete(tabId);
            notify(tabId, agent, "done");
          }, DONE_SETTLE_MS),
        );
      }
    }
    for (const [tabId, was] of before) {
      if (!agents.has(tabId)) {
        const timer = settleTimers.current.get(tabId);
        if (timer) clearTimeout(timer);
        settleTimers.current.delete(tabId);
        notify(tabId, was, "exited");
      }
    }
  });

  useEffect(
    () => () => {
      settleTimers.current.forEach(clearTimeout);
    },
    [],
  );
}
