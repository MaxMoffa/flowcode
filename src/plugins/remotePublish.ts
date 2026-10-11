import { invoke } from "@tauri-apps/api/core";
import { onUsageFetched } from "./useUsageState";
import { metricText, type UsageInfo } from "./usage";

/** What the phone app is shown (see docs/remote-protocol.md): the backend
 * keeps the latest of each and pushes it to connected phones, so publishing
 * while none is paired costs one tiny IPC call. */
interface RemoteMetric {
  kind: string;
  label?: string;
  percent?: number;
  resets?: string;
  command?: string;
  period?: string;
  cost?: number;
  tokens?: number;
  sessions?: number;
}

interface RemoteUsageItem {
  pluginId: string;
  label: string;
  profile?: string;
  metrics: RemoteMetric[];
}

/** Usage changes are coalesced: a refresh round fetches several plugins and
 * profiles within moments of each other. */
const PUBLISH_DELAY_MS = 2000;

/** Mirrors every usage result the app fetches (see useUsageState.ts - nothing
 * is fetched just for this) to the remote-access backend. `labelOf` names a
 * plugin id in the current language. */
export function watchUsageForRemote(labelOf: (pluginId: string) => string): () => void {
  const latest = new Map<string, RemoteUsageItem>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    invoke("remote_publish_usage", { items: [...latest.values()] }).catch(() => {});
  };

  const stop = onUsageFetched((pluginId: string, usage: UsageInfo, profile?: string) => {
    const key = `${pluginId}\u0000${profile ?? ""}`;
    if (!usage.ok) {
      latest.delete(key);
    } else {
      latest.set(key, {
        pluginId,
        label: labelOf(pluginId),
        profile,
        // The desktop words a metric at render time; the phone gets it done.
        metrics: usage.metrics.map((m) => ({
          kind: m.kind,
          label: m.label ?? metricText(m).label,
          percent: m.percent,
          resets: m.resets,
          command: m.command,
          period: m.period,
          cost: m.cost,
          tokens: m.tokens,
          sessions: m.sessions,
        })),
      });
    }
    if (!timer) timer = setTimeout(flush, PUBLISH_DELAY_MS);
  });

  return () => {
    stop();
    if (timer) clearTimeout(timer);
  };
}

/** Plugin actions that make sense from a phone: they type into or clear a
 * terminal, or announce something. Window furniture (sidebars, dialogs,
 * opening an editor on the desktop) does not. */
const PHONE_ACTIONS = new Set(["runCommand", "commandOutput", "clearTerminal", "newTerminal", "notify"]);

export function isPhoneAction(action: string): boolean {
  return PHONE_ACTIONS.has(action);
}

export function publishRemoteActions(actions: { id: string; label: string }[]) {
  invoke("remote_publish_actions", { actions }).catch(() => {});
}
