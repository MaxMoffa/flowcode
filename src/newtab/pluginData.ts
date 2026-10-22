import type { AgentCli } from "../agents/cliInfo";
import type { NewTabData, NewTabLaunchKind } from "../../shared/newTabBridge";
import type { FavoriteFolder } from "../favorites/favoritesStore";
import { sameShell } from "../terminal/wslPath";
import type { RecentTerminal } from "./recentTerminals";
import type { NewTabLaunch } from "./types";

/** What the host offers a new tab plugin, as its own types. */
export interface NewTabLists {
  recents: RecentTerminal[];
  favorites: FavoriteFolder[];
  /** The shell chips: the `pty_spawn` shell id each stands for, and its name. */
  shells: { id: string; label: string }[];
  agents: { id: AgentCli; label: string }[];
  profile?: { id: string; label: string };
}

/** A recent terminal is one per folder and shell. */
const recentId = (r: RecentTerminal) => `${r.shell ?? ""}|${r.cwd}`;

/** The lists as the plugin receives them. The ids are only ever matched back
 * against these same lists (`resolveNewTabLaunch`): a plugin names an entry,
 * it never supplies a path or a command. */
export function buildNewTabData({ recents, favorites, shells, agents, profile }: NewTabLists): NewTabData {
  return {
    recents: recents.map((r) => ({ id: recentId(r), label: r.name, path: r.cwd, ...(r.shell ? { shell: r.shell } : {}) })),
    favorites: favorites.map((f) => ({ id: f.path, label: f.name, path: f.path })),
    shells,
    agents,
    ...(profile ? { profile } : {}),
  };
}

/** What starting an entry means: a terminal launch (as the layouts hand to
 * `onLaunch`), or an agent in place of the page. */
export type ResolvedLaunch = { launch: NewTabLaunch } | { agent: AgentCli };

/** The entry of `kind` with this `id` in the host's lists, or null when there
 * is none - a stale id, or one the plugin made up. */
export function resolveNewTabLaunch(lists: NewTabLists, kind: NewTabLaunchKind, id: string, defaultShell: string): ResolvedLaunch | null {
  switch (kind) {
    case "recent": {
      const r = lists.recents.find((entry) => recentId(entry) === id);
      return r ? { launch: { shell: r.shell, cwd: r.cwd, command: r.command, typeOnly: true } } : null;
    }
    case "favorite": {
      const f = lists.favorites.find((entry) => entry.path === id);
      return f ? { launch: { shell: f.shell, cwd: f.path } } : null;
    }
    case "shell": {
      const shell = lists.shells.find((entry) => entry.id === id);
      return shell ? { launch: { shell: sameShell(shell.id, defaultShell) ? undefined : shell.id } } : null;
    }
    case "agent": {
      const agent = lists.agents.find((entry) => entry.id === id);
      return agent ? { agent: agent.id } : null;
    }
  }
}
