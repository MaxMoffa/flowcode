import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { gitRepoRoot, gitWorktrees, isWorktreeCapable, type GitWorktree } from "./git";
import { keepIfSame } from "./agentScope";
import type { ClaudeSessionEntry, ClineSessionEntry, CodexSessionEntry, OpencodeSessionEntry, VibeSessionEntry } from "./entryTypes";

/** Module-level cache of the History lists: the panel unmounts with its tab, but a return shows the last lists at
 * once and refreshes them in the background (stale-while-revalidate). */

export interface HistoryLists {
  /** Claude scans, by the project's roots (JSON). */
  claude: Record<string, ClaudeSessionEntry[]>;
  /** The latest Claude scan of any roots: shown while the scan of the current ones is pending (rows are filtered by roots anyway). */
  claudeLast: ClaudeSessionEntry[] | null;
  codex: CodexSessionEntry[];
  vibe: VibeSessionEntry[];
  opencode: OpencodeSessionEntry[];
  cline: ClineSessionEntry[];
  /** What answered at least once: "claude:<rootsKey>", "codex", "vibe", "opencode", "cline". */
  loaded: ReadonlySet<string>;
}

let state: HistoryLists = { claude: {}, claudeLast: null, codex: [], vibe: [], opencode: [], cline: [], loaded: new Set() };
const listeners = new Set<() => void>();

function update(patch: Partial<HistoryLists>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function markLoaded(id: string) {
  if (state.loaded.has(id)) return;
  update({ loaded: new Set(state.loaded).add(id) });
}

export function useHistoryStore(): HistoryLists {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
  );
}

type GlobalAgent = "codex" | "vibe" | "opencode" | "cline";
const GLOBAL_COMMANDS: Record<GlobalAgent, string> = {
  codex: "list_codex_sessions",
  vibe: "list_vibe_sessions",
  opencode: "list_opencode_sessions",
  cline: "list_cline_sessions",
};

/** Refreshes one agent's list apart from the others: each shows as soon as it answers. A rejection keeps what was last known. */
export function refreshGlobalAgent(agent: GlobalAgent): void {
  invoke<never[]>(GLOBAL_COMMANDS[agent], { fresh: false })
    .then((r) => update({ [agent]: keepIfSame(state[agent] as never[], r) } as Partial<HistoryLists>))
    .catch(() => {})
    .finally(() => markLoaded(agent));
}

export function refreshClaude(roots: string[]): void {
  const key = JSON.stringify(roots);
  invoke<ClaudeSessionEntry[]>("list_claude_sessions", { roots })
    .then((r) => update({ claude: { ...state.claude, [key]: keepIfSame(state.claude[key] ?? [], r) }, claudeLast: r }))
    .catch(() => {})
    .finally(() => markLoaded(`claude:${key}`));
}

// ---- repo roots, by folder ----

export interface RepoInfo {
  roots: string[];
  worktrees: GitWorktree[];
}

const repoCache = new Map<string, RepoInfo>();
const repoInflight = new Map<string, Promise<RepoInfo>>();
const repoKey = (cwd: string, distro: string | undefined) => `${distro ?? ""}\n${cwd}`;

export function cachedRepo(cwd: string, distro: string | undefined): RepoInfo | undefined {
  return repoCache.get(repoKey(cwd, distro));
}

/** The repo's worktrees count as the project. Looked up once per folder; concurrent calls share one lookup. */
export function resolveRepo(cwd: string, distro: string | undefined): Promise<RepoInfo> {
  const key = repoKey(cwd, distro);
  const hit = repoCache.get(key);
  if (hit) return Promise.resolve(hit);
  const running = repoInflight.get(key);
  if (running) return running;
  const p = (async (): Promise<RepoInfo> => {
    let info: RepoInfo = { roots: [cwd], worktrees: [] };
    if (isWorktreeCapable(cwd, distro)) {
      try {
        const root = await gitRepoRoot(cwd);
        if (root) {
          const worktrees = await gitWorktrees(root);
          info = { roots: worktrees.length > 0 ? worktrees.map((w) => w.path) : [root], worktrees };
        }
      } catch {
        info = { roots: [cwd], worktrees: [] };
      }
    }
    repoCache.set(key, info);
    repoInflight.delete(key);
    return info;
  })();
  repoInflight.set(key, p);
  return p;
}

/** Row keys already drawn: only rows arriving the first time rise. */
export const seenRowKeys = new Set<string>();
