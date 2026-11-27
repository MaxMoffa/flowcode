import { useMemo, useSyncExternalStore } from "react";
import { AGENT_CLIS, type AgentCli } from "../agents/cliInfo";
import { basename, trimTrailingSeparators } from "../lib/path";
import { createListStore } from "../lib/createListStore";
import type { NewTabSource, NewTabSourceLists } from "../newtab/newTabSource";
import type { RecentTerminal } from "../newtab/recentTerminals";
import type { Accounts, LoginState, ProfileInfo as LocalProfileInfo } from "../profiles/profiles";
import type { ProfileInfo } from "../../shared/remote-types";
import { hostRequest } from "./hostRequest";
import { chatLike, expectNewTab, sendToHost, terminalLike, useHost, useHostState } from "./remoteHosts";
import { remoteFsBackend } from "./remoteFs";

/** Folders launched from the new tab page of one PC, most recent first. */
const MAX_RECENTS = 8;
const stores = new Map<string, ReturnType<typeof createListStore<RecentTerminal>>>();
function recentsStore(hostId: string) {
  let store = stores.get(hostId);
  if (!store) {
    store = createListStore<RecentTerminal>(
      `flowcode.remoteRecents.${hostId}`,
      (r): r is RecentTerminal => typeof (r as RecentTerminal)?.cwd === "string" && typeof (r as RecentTerminal)?.at === "number",
      MAX_RECENTS,
    );
    stores.set(hostId, store);
  }
  return store;
}

const sameFolder = (a: string, b: string) => trimTrailingSeparators(a).replace(/\\/g, "/").toLowerCase() === trimTrailingSeparators(b).replace(/\\/g, "/").toLowerCase();

/** The folders of the PC's open tabs (now), then the ones launched from here, one entry per folder. */
export function mergeRemoteRecents(stored: readonly RecentTerminal[], openFolders: readonly string[], now: number): RecentTerminal[] {
  const merged: RecentTerminal[] = [];
  const add = (cwd: string, at: number) => {
    if (!cwd || merged.some((r) => sameFolder(r.cwd, cwd))) return;
    merged.push({ cwd, name: basename(cwd) || cwd, command: "", at });
  };
  for (const cwd of openFolders) add(cwd, now);
  for (const r of [...stored].sort((a, b) => b.at - a.at)) add(r.cwd, r.at);
  return merged;
}

/** Remembers a folder started from the new tab page of this PC. */
export function recordRemoteRecent(hostId: string, cwd: string) {
  const store = recentsStore(hostId);
  store.set([{ cwd, name: basename(cwd) || cwd, command: "", at: Date.now() }, ...store.get().filter((r) => !sameFolder(r.cwd, cwd))]);
}

/** The agents a PC offers: the ones it advertises (the older three are always there). */
export function agentsForCaps(caps: readonly string[]): AgentCli[] {
  return AGENT_CLIS.filter((cli) => (cli === "gemini" || cli === "opencode" || cli === "cline" ? caps.includes(cli) : true));
}

/** A PC's profile as the profile picker knows it. */
const toLocalProfile = (p: ProfileInfo): LocalProfileInfo => ({ id: p.id, name: p.name, color: p.color, dir: "", logged_in: p.loggedIn as unknown as LoginState, accounts: p.accounts as Accounts | undefined });

export interface RemoteLaunch {
  cwd?: string;
  /** Start this agent (a chat when the PC has them, else a terminal running its CLI). */
  agent?: AgentCli;
  /** `undefined`: the PC picks; `null`: its default profile. */
  profile?: string | null;
}

/** Asks `hostId` for the tab `launch` describes. The protocol has no shell choice and no command: a terminal is the PC's default shell. */
export function startOnHost(hostId: string, caps: readonly string[], { cwd, agent, profile }: RemoteLaunch) {
  const withProfile = profile !== undefined && caps.includes("newTabProfile") ? { profile: profile ?? "" } : {};
  const withCwd = cwd ? { cwd } : {};
  if (agent && caps.includes("chat")) {
    expectNewTab(hostId, chatLike(agent, cwd));
    void sendToHost(hostId, { t: "newchat", cli: agent, ...withCwd, ...withProfile });
  } else if (agent) {
    expectNewTab(hostId, terminalLike(cwd, agent));
    void sendToHost(hostId, { t: "newtab", cli: agent, ...withCwd, ...withProfile });
  } else {
    expectNewTab(hostId, terminalLike(cwd));
    void sendToHost(hostId, { t: "newtab", ...withCwd, ...withProfile });
  }
  if (cwd) recordRemoteRecent(hostId, cwd);
}

const looksWindows = (path: string | null) => !!path && (/^[A-Za-z]:/.test(path) || path.includes("\\"));

/** The new tab page's data from another PC. `homeHint` (its front tab's folder) is where "~" and the folder search start; without one, the PC's first root. */
export function createRemoteNewTabSource(hostId: string, hostName: string, homeHint: string | null): NewTabSource {
  const fs = remoteFsBackend(hostId);
  return {
    hostName,
    canRunCommand: false,
    hasFavorites: false,
    useLists(): NewTabSourceLists {
      const host = useHost(hostId);
      const state = useHostState(hostId);
      const store = recentsStore(hostId);
      const stored = useSyncExternalStore(store.subscribe, store.get, store.get);
      const caps = host?.caps ?? [];
      const folders = useMemo(() => [...state.tabs.map((x) => x.cwd), ...state.chats.map((c) => c.cwd)], [state.tabs, state.chats]);
      // Open tabs count as "now": the minute is enough to keep the list steady between renders.
      const minute = Math.floor(Date.now() / 60_000);
      const recents = useMemo(() => mergeRemoteRecents(stored, folders, minute * 60_000), [stored, folders, minute]);
      const hasProfiles = caps.includes("profiles");
      const profiles = useMemo(() => (hasProfiles ? state.profiles.map(toLocalProfile) : []), [hasProfiles, state.profiles]);
      return { favorites: [], recents, profiles, defaultAccounts: state.defaultAccounts as Accounts | null, agents: agentsForCaps(caps) };
    },
    listShells: () => Promise.resolve([]),
    homeDir: async () => {
      if (homeHint) return homeHint;
      const m = await hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: { op: "roots" } }), 15_000);
      if (m.response?.kind !== "roots" || !m.response.roots[0]) throw new Error("no roots");
      return m.response.roots[0].path;
    },
    readDir: fs.readDir,
    isDirectory: (path) => fs.readDir(path, true).then(() => true, () => false),
    isWindows: (path) => looksWindows(path ?? homeHint),
  };
}
