import { invoke } from "@tauri-apps/api/core";

/** Mirrors `GitChange` in src-tauri/src/git.rs. */
export interface GitChange {
  /** Repo-relative, forward slashes. */
  path: string;
  /** Where a rename/copy came from. */
  orig_path: string | null;
  /** One of M A D R C T U ? */
  status: string;
}

/** Mirrors `GitStatus` in src-tauri/src/git.rs. */
export interface GitStatus {
  /** `null` when the HEAD is detached. */
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitChange[];
  unstaged: GitChange[];
  untracked: GitChange[];
  conflicted: GitChange[];
}

/** The repository (main tree or linked worktree) `path` is in, `null` when it
 * isn't in one. */
export const gitToplevel = (path: string) => invoke<string | null>("git_toplevel", { path });
export const gitStatus = (root: string) => invoke<GitStatus>("git_status", { root });
export const gitStage = (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths });
export const gitUnstage = (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths });
/** Resolves with the new commit's short hash; rejects with git's own message. */
export const gitCommit = (root: string, message: string) => invoke<string>("git_commit", { root, message });
/** File content at "HEAD" or in the "INDEX"; empty when absent there. */
export const gitShowFile = (root: string, path: string, rev: "HEAD" | "INDEX") =>
  invoke<string>("git_show_file", { root, path, rev });
export const gitDiscard = (root: string, paths: string[], untracked: boolean) =>
  invoke<void>("git_discard", { root, paths, untracked });

/** Builds an absolute path from the repository root and git's forward-slashed
 * relative one, using the separator the root itself uses. */
export function joinRepoPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}
