import { invoke } from "@tauri-apps/api/core";
import { isWindowsHostPath, isWindowsPlatform } from "../lib/path";
import { wslDistroOfPath } from "../terminal/wslPath";

/** One working tree of a git repository - see `git_worktrees` in
 * src-tauri/src/git.rs. */
export interface GitWorktree {
  path: string;
  /** `null` for a detached HEAD. */
  branch: string | null;
  head: string;
  /** The repository's own working tree (the first entry). */
  is_main: boolean;
  /** Created by Flowcode (`flowcode/<slug>` branch). */
  flowcode: boolean;
}

/** The main working tree's root of the repository `path` is in; `null` when
 * it isn't in one, is a WSL path, or git is missing. */
export function gitRepoRoot(path: string): Promise<string | null> {
  return invoke<string | null>("git_repo_root", { path });
}

/** Every working tree of the repository, the main one first. */
export function gitWorktrees(repoRoot: string): Promise<GitWorktree[]> {
  return invoke<GitWorktree[]>("git_worktrees", { repoRoot });
}

/** Whether worktrees can be offered for a folder: the git commands run on
 * this host, so not for a WSL tab or a `\\wsl.localhost` path, and a POSIX
 * path only means something off Windows. */
export function isWorktreeCapable(path: string | undefined, wslDistro: string | undefined): boolean {
  if (!path || wslDistro || wslDistroOfPath(path) !== null) return false;
  return isWindowsPlatform() ? isWindowsHostPath(path) : true;
}
