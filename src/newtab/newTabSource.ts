import { createContext, useContext, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentCli } from "../agents/cliInfo";
import { useAvailableClis } from "../agents/useAvailableClis";
import { listFavorites, subscribeFavorites, type FavoriteFolder } from "../favorites/favoritesStore";
import { isWindowsPlatform } from "../lib/path";
import { useProfiles, type Accounts, type ProfileInfo } from "../profiles/profiles";
import { rememberBannerInfo, type BannerSystemInfo } from "../terminal/asciiBanner";
import { listShellOptions, type ShellOption } from "../terminal/shellOptions";
import { listRecentTerminals, subscribeRecentTerminals, type RecentTerminal } from "./recentTerminals";

export interface NewTabFsEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** What the layouts list: favorites, recents, the account profiles and the agents that can start. */
export interface NewTabSourceLists {
  favorites: FavoriteFolder[];
  recents: RecentTerminal[];
  profiles: ProfileInfo[];
  defaultAccounts?: Accounts | null;
  agents: AgentCli[];
}

/** Where the new tab page gets its data: this PC by default, another PC's when the page is shown for that one. A missing optional member hides its feature. */
export interface NewTabSource {
  /** The PC's name, for a page that says whose it is (absent: this PC). */
  hostName?: string;
  /** A typed command can be run (this PC); false: a command line can only open a terminal in a folder. */
  canRunCommand: boolean;
  /** The PC keeps a list of favorite folders (false: no favorites section). */
  hasFavorites: boolean;
  /** A hook (it reads stores): one source stays in place for the page's life. */
  useLists: (profileId?: string) => NewTabSourceLists;
  /** The shells to pick from; none: no shell chips. */
  listShells: () => Promise<ShellOption[]>;
  homeDir: () => Promise<string>;
  readDir: (path: string, showHidden: boolean) => Promise<NewTabFsEntry[]>;
  isDirectory: (path: string) => Promise<boolean>;
  /** Folder-only search under `root`; `generation` lets the backend drop an older walk. Absent: no folder search. */
  searchDirs?: (root: string, query: string, depth: number, generation: number) => Promise<NewTabFsEntry[]>;
  /** Whether `path` (a start folder or home of that PC) is a Windows-style path. */
  isWindows: (path: string | null) => boolean;
  /** The banner's machine facts. Absent: no banner. */
  systemInfo?: () => Promise<BannerSystemInfo>;
}

function useLocalLists(profileId?: string): NewTabSourceLists {
  const favorites = useSyncExternalStore(subscribeFavorites, listFavorites, listFavorites);
  const recents = useSyncExternalStore(subscribeRecentTerminals, listRecentTerminals, listRecentTerminals);
  const { profiles, default_accounts } = useProfiles();
  // The agents this tab's account is signed in to - as the Agents panel's "+" menu offers them.
  const agents = useAvailableClis(profiles.find((p) => p.id === profileId));
  return { favorites, recents, profiles, defaultAccounts: default_accounts, agents };
}

export const localNewTabSource: NewTabSource = {
  canRunCommand: true,
  hasFavorites: true,
  useLists: useLocalLists,
  listShells: listShellOptions,
  homeDir: () => invoke<string>("home_dir"),
  readDir: (path, showHidden) => invoke<NewTabFsEntry[]>("read_dir", { path, showHidden }),
  isDirectory: (path) => invoke<boolean>("is_directory", { path }),
  // The folder search has its own generation counter (`channel`), apart from the file tree's.
  searchDirs: (root, query, depth, generation) =>
    invoke<NewTabFsEntry[]>("search_dir", { path: root, query, showHidden: false, generation, dirsOnly: true, maxDepth: depth, channel: "newtab" }),
  isWindows: () => isWindowsPlatform(),
  systemInfo: () =>
    invoke<BannerSystemInfo>("system_info").then((info) => {
      rememberBannerInfo({ info });
      return info;
    }),
};

export const NewTabSourceContext = createContext<NewTabSource>(localNewTabSource);
export const useNewTabSource = () => useContext(NewTabSourceContext);
