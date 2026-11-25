import { createContext, useContext } from "react";
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

/** Mirrors `GitBranch` in src-tauri/src/git.rs. */
export interface GitBranch {
  /** Short name; `origin/feature` for a remote one. */
  name: string;
  upstream: string | null;
  last_commit_unix: number | null;
}

/** Mirrors `GitBranches` in src-tauri/src/git.rs. */
export interface GitBranches {
  /** `null` when the HEAD is detached. */
  current: string | null;
  local: GitBranch[];
  /** Without the ones a local branch already tracks. */
  remote: GitBranch[];
}

/** The repository (main tree or linked worktree) `path` is in, `null` when it
 * isn't in one. */
const gitToplevel = (path: string) => invoke<string | null>("git_toplevel", { path });
const gitStatus = (root: string) => invoke<GitStatus>("git_status", { root });
const gitStage = (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths });
const gitUnstage = (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths });
/** Resolves with the new commit's short hash; rejects with git's own message. */
const gitCommit = (root: string, message: string) => invoke<string>("git_commit", { root, message });
/** File content at "HEAD" or in the "INDEX"; empty when absent there. */
const gitShowFile = (root: string, path: string, rev: "HEAD" | "INDEX") =>
  invoke<string>("git_show_file", { root, path, rev });
const gitDiscard = (root: string, paths: string[], untracked: boolean) =>
  invoke<void>("git_discard", { root, paths, untracked });
const gitBranches = (root: string) => invoke<GitBranches>("git_branches", { root });
/** Rejects with git's own message when it refuses (e.g. changes would be
 * overwritten). `createFromRemote`: `name` is `<remote>/<branch>`. */
const gitSwitchBranch = (root: string, name: string, createFromRemote: boolean) =>
  invoke<void>("git_switch_branch", { root, name, createFromRemote });

/** What the Git panel, branch menu and diff view ask of a repository: this PC's by default, another PC's (through its `git` protocol messages) when the panel shows that one. */
export interface GitBackend {
  toplevel: (path: string) => Promise<string | null>;
  status: (root: string) => Promise<GitStatus>;
  stage: (root: string, paths: string[]) => Promise<void>;
  unstage: (root: string, paths: string[]) => Promise<void>;
  commit: (root: string, message: string) => Promise<string>;
  showFile: (root: string, path: string, rev: "HEAD" | "INDEX") => Promise<string>;
  discard: (root: string, paths: string[], untracked: boolean) => Promise<void>;
  branches: (root: string) => Promise<GitBranches>;
  switchBranch: (root: string, name: string, createFromRemote: boolean) => Promise<void>;
  /** A file of the working tree; empty when it is gone. */
  readText: (path: string) => Promise<string>;
}

const localGit: GitBackend = {
  toplevel: gitToplevel,
  status: gitStatus,
  stage: gitStage,
  unstage: gitUnstage,
  commit: gitCommit,
  showFile: gitShowFile,
  discard: gitDiscard,
  branches: gitBranches,
  switchBranch: gitSwitchBranch,
  readText: (path) => invoke<string>("read_text_file", { path }).catch(() => ""),
};

export const GitBackendContext = createContext<GitBackend>(localGit);
export const useGitBackend = () => useContext(GitBackendContext);

/** Builds an absolute path from the repository root and git's forward-slashed
 * relative one, using the separator the root itself uses. */
export function joinRepoPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep);
}
