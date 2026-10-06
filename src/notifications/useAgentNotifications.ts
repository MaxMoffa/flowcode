import { useEffect, useRef, useState } from "react";
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

const CLI_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", vibe: "Mistral Vibe" };

interface Watcher {
  /** The terminal tab, or undefined once it's gone. */
  getTab: (id: string) => TermTab | undefined;
  /** Whether the user is looking at that tab right now. */
  isViewing: (id: string) => boolean;
  /** When the user last pressed Enter in that tab (ms, 0 if never). */
  lastSubmitAt: (id: string) => number;
}

/** Watches the agents running in this window's tabs and raises a native
 * notification when one finishes its turn, needs the user, or exits - unless
 * that kind is switched off in Settings, the tab is muted, or the user is
 * already looking at it. Clicking the notification brings the tab forward
 * (see notify.rs). The same events also drive the taskbar/Dock badge (see
 * attention.rs): agents waiting for input, or one that finished unseen. The
 * tabs whose agent finished unseen are returned too, for the tab strip. */
export function useAgentNotifications(
  agents: Map<string, TabAgent>,
  { getTab, isViewing, lastSubmitAt }: Watcher,
): ReadonlySet<string> {
  const previous = useRef<Map<string, TabAgent> | null>(null);
  const settleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  /** When each tab's agent last finished a turn (ms). An agent can start a
   * turn of its own - Claude Code wakes itself up when a background command
   * or sub-agent it left running ends, then finishes again - and that's not
   * news: only a turn the user asked for (an Enter in the tab since) is. */
  const lastDoneAt = useRef(new Map<string, number>());
  /** Tabs whose agent finished while the user wasn't looking - cleared once
   * they look, or the agent starts working again. */
  const unseenDone = useRef(new Set<string>());
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const sentBadge = useRef({ waiting: 0, done: false });
  const syncBadge = useRef<() => void>(() => {});

  useEffect(() => {
    const before = previous.current;
    previous.current = agents;

    syncBadge.current = () => {
      const settings = getNotificationSettings();
      const hidden = (id: string) => {
        const tab = getTab(id);
        return !tab || tab.notifyMuted || isViewing(id);
      };
      const before = unseenDone.current.size;
      for (const id of unseenDone.current) {
        if (hidden(id) || agents.get(id)?.state === "busy") unseenDone.current.delete(id);
      }
      if (unseenDone.current.size !== before) setDoneIds(new Set(unseenDone.current));
      let waiting = 0;
      if (settings.input) for (const [id, agent] of agents) if (agent.state === "waiting" && !hidden(id)) waiting++;
      const done = settings.done && unseenDone.current.size > 0;
      const sent = sentBadge.current;
      if (sent.waiting === waiting && sent.done === done) return;
      sentBadge.current = { waiting, done };
      void invoke("attention_set", {
        label: getCurrentWindow().label,
        waiting,
        done,
        flash: waiting > sent.waiting,
      }).catch(() => {});
    };
    // The first answer only tells what was already going on.
    if (!before) return;

    function notify(tabId: string, agent: TabAgent, kind: NotificationKind) {
      const tab = getTab(tabId);
      if (!tab || tab.notifyMuted || !getNotificationSettings()[kind] || isViewing(tabId)) return;
      if (kind === "done") {
        unseenDone.current.add(tabId);
        setDoneIds(new Set(unseenDone.current));
        syncBadge.current();
      }
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
            const previousDone = lastDoneAt.current.get(tabId);
            lastDoneAt.current.set(tabId, Date.now());
            if (previousDone !== undefined && lastSubmitAt(tabId) < previousDone) return;
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
        lastDoneAt.current.delete(tabId);
        notify(tabId, was, "exited");
      }
    }
    syncBadge.current();
  });

  // Looking at the window is what dismisses the badge, and that changes
  // without any agent state changing.
  useEffect(() => {
    const sync = () => syncBadge.current();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, []);

  useEffect(
    () => () => {
      settleTimers.current.forEach(clearTimeout);
      void invoke("attention_set", { label: getCurrentWindow().label, waiting: 0, done: false, flash: false }).catch(() => {});
    },
    [],
  );

  return doneIds;
}
