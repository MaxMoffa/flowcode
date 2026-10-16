import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ensureProfilesLoaded, getProfilesState, onProfilesChanged, profileById } from "../profiles/profiles";
import { defaultCliStatus, type AgentCli } from "../agents/cliInfo";
import { onUsageFetched, retainUsage } from "./useUsageState";
import { isRemoteLeader, watchRemoteLeader } from "../remote/leader";
import type { UsageItem } from "../../shared/remote-types";
import { metricText, usageFetcherFor, type UsageInfo } from "./usage";

// What the phone app is shown (see docs/remote-protocol.md): the backend
// keeps the latest of each and pushes it to connected phones, so publishing
// while none is paired costs one tiny IPC call.

const usageKey = (pluginId: string, profile?: string) => `${pluginId}\u0000${profile ?? ""}`;

/** The agent CLI behind a bundled plugin: whose login (profiles.ts `logged_in`) its usage reads, and whose logo the phone draws for it. */
export const PROFILE_CLI: Record<string, AgentCli> = {
  "claude-code": "claude",
  "codex-cli": "codex",
  "mistral-vibe": "vibe",
  "gemini-cli": "gemini",
};

/** Usage changes are coalesced: a refresh round fetches several plugins and
 * profiles within moments of each other. */
const PUBLISH_DELAY_MS = 2000;

export interface UsageWatch {
  dispose: () => void;
  /** Re-reads which profiles are signed in. */
  refresh: () => void;
}

/** Mirrors every usage result the app fetches (see useUsageState.ts) to the
 * remote-access backend. While a phone is connected, usage is also kept
 * fetched for every agent with a usage fetcher, pinned or not, in every
 * profile signed in to its CLI, since the desktop UI only fetches what it
 * shows. Only the leader window (see
 * remote/leader.ts) publishes and retains. `labelOf` names a plugin id in the
 * current language. */
export function watchUsageForRemote(labelOf: (pluginId: string) => string): UsageWatch {
  const latest = new Map<string, UsageItem>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (!isRemoteLeader()) return;
    // Name and colour are resolved now, so a rename reaches the phone too.
    const { profiles } = getProfilesState();
    const items = [...latest.values()].map((item) => {
      const p = profileById({ profiles, project_defaults: {}, default_logged_in: null }, item.profile);
      return p ? { ...item, profileName: p.name, profileColor: p.color } : item;
    });
    invoke("remote_publish_usage", { items }).catch(() => {});
  };

  const stop = onUsageFetched((pluginId: string, usage: UsageInfo, profile?: string) => {
    const key = usageKey(pluginId, profile);
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
  /** Retains exactly the wanted (plugin, profile) pairs while a phone is
   * connected and this window leads; nothing otherwise. Every profile signed
   * in to the plugin's CLI counts, besides the default one. */
  const reconcile = () => {
    ensureProfilesLoaded();
    const { profiles } = getProfilesState();
    const wanted = new Map<string, { id: string; profile?: string }>();
    for (const id of Object.keys(PROFILE_CLI)) {
      if (!usageFetcherFor(id)) continue;
      const cli = PROFILE_CLI[id];
      if (defaultSignedIn.has(cli)) wanted.set(usageKey(id), { id });
      for (const p of profiles) {
        if (p.logged_in[cli]) wanted.set(usageKey(id, p.id), { id, profile: p.id });
      }
    }
    // A deleted profile or unpinned plugin must leave the phone too.
    for (const key of latest.keys()) if (!wanted.has(key)) latest.delete(key);
    const active = phoneConnected && isRemoteLeader();
    for (const [key, r] of held) {
      if (!active || !wanted.has(key)) {
        r();
        held.delete(key);
      }
    }
    if (!active) return;
    for (const [key, w] of wanted) {
      if (!held.has(key)) held.set(key, retainUsage(w.id, w.profile));
    }
  };
  /** The default profile's logins: not in the profiles store, so asked of the
   * backend (cheap, but it may spawn the CLI - hence only while publishing). */
  const defaultSignedIn = new Set<string>();
  let lastProbeAt = 0;
  /** `force`: the profile list changed, so ask again whatever the last probe's age. */
  const probeDefault = async (force = false) => {
    if (!phoneConnected || !isRemoteLeader()) return;
    if (!force && Date.now() - lastProbeAt < 30_000) return;
    lastProbeAt = Date.now();
    for (const cli of new Set(Object.values(PROFILE_CLI))) {
      const st = await defaultCliStatus(cli, force);
      if (disposed) return;
      if (st?.installed && st.logged_in) defaultSignedIn.add(cli);
      else if (st) defaultSignedIn.delete(cli);
    }
    reconcile();
  };
  const probeTimer = setInterval(() => void probeDefault(), 5 * 60 * 1000);
  const unwatchProfiles = onProfilesChanged(() => {
    reconcile();
    void probeDefault(true);
  });
  const sync = async () => {
    const status = await invoke<{ devices: { connected: boolean }[] }>("remote_status").catch(() => null);
    if (disposed) return;
    phoneConnected = !!status?.devices.some((d) => d.connected);
    reconcile();
    void probeDefault();
  };
  void sync();
  const unlisten = listen("remote://devices-changed", () => void sync());
  const unwatchLeader = watchRemoteLeader((lead) => {
    reconcile();
    if (lead) void probeDefault();
    // Newly in charge: hand over what this window already knows.
    if (lead && latest.size > 0 && !timer) timer = setTimeout(flush, PUBLISH_DELAY_MS);
  });

  return {
    dispose: () => {
      disposed = true;
      clearInterval(probeTimer);
      stop();
      if (timer) clearTimeout(timer);
      unlisten.then((fn) => fn()).catch(() => {});
      unwatchLeader();
      unwatchProfiles();
      release();
    },
    refresh: () => {
      reconcile();
      void probeDefault();
    },
  };
}

/** Plugin actions that make sense from a phone: they type into or clear a
 * terminal, or announce something. Window furniture (sidebars, dialogs,
 * opening an editor on the desktop) does not. */
const PHONE_ACTIONS = new Set(["runCommand", "commandOutput", "clearTerminal", "newTerminal", "notify"]);

export function isPhoneAction(action: string): boolean {
  return PHONE_ACTIONS.has(action);
}

export function publishRemoteActions(actions: { id: string; label: string; icon?: string; cli?: string }[]) {
  if (!isRemoteLeader()) return;
  invoke("remote_publish_actions", { actions }).catch(() => {});
}
