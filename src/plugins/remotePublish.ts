import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onUsageFetched, retainUsage } from "./useUsageState";
import { isRemoteLeader, watchRemoteLeader } from "../remote/leader";
import { metricText, usageFetcherFor, type UsageInfo } from "./usage";

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

export interface UsageWatch {
  dispose: () => void;
  /** Re-reads `pluginIds` (the user pinned or unpinned something). */
  refresh: () => void;
}

/** Mirrors every usage result the app fetches (see useUsageState.ts) to the
 * remote-access backend. While a phone is connected, usage is also kept
 * fetched for every plugin in `pluginIds` (the ones the user enabled), since
 * the desktop UI only fetches what it shows. Only the leader window (see
 * remote/leader.ts) publishes and retains. `labelOf` names a plugin id in the
 * current language. */
export function watchUsageForRemote(labelOf: (pluginId: string) => string, pluginIds: () => string[]): UsageWatch {
  const latest = new Map<string, RemoteUsageItem>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (!isRemoteLeader()) return;
    invoke("remote_publish_usage", { items: [...latest.values()] }).catch(() => {});
  };

  const stop = onUsageFetched((pluginId: string, usage: UsageInfo, profile?: string) => {
    const key = `${pluginId}\u0000${profile ?? ""}`;
    // A failed probe keeps the last good value: one hiccup must not make the
    // item vanish from the phone.
    if (usage.ok) {
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

  const held = new Map<string, () => void>();
  let disposed = false;
  let phoneConnected = false;
  const release = () => {
    for (const r of held.values()) r();
    held.clear();
  };
  /** Retains exactly the wanted plugins while a phone is connected and this
   * window leads; nothing otherwise. */
  const reconcile = () => {
    const wanted = new Set(phoneConnected && isRemoteLeader() ? pluginIds().filter((id) => usageFetcherFor(id)) : []);
    for (const [id, r] of held) {
      if (!wanted.has(id)) {
        r();
        held.delete(id);
      }
    }
    for (const id of wanted) {
      if (!held.has(id)) held.set(id, retainUsage(id));
    }
  };
  const sync = async () => {
    const status = await invoke<{ devices: { connected: boolean }[] }>("remote_status").catch(() => null);
    if (disposed) return;
    phoneConnected = !!status?.devices.some((d) => d.connected);
    reconcile();
  };
  void sync();
  const unlisten = listen("remote://devices-changed", () => void sync());
  const unwatchLeader = watchRemoteLeader((lead) => {
    reconcile();
    // Newly in charge: hand over what this window already knows.
    if (lead && latest.size > 0 && !timer) timer = setTimeout(flush, PUBLISH_DELAY_MS);
  });

  return {
    dispose: () => {
      disposed = true;
      stop();
      if (timer) clearTimeout(timer);
      unlisten.then((fn) => fn()).catch(() => {});
      unwatchLeader();
      release();
    },
    refresh: reconcile,
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
  if (!isRemoteLeader()) return;
  invoke("remote_publish_actions", { actions }).catch(() => {});
}
