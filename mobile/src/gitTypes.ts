// Wire types of the desktop's git panel (copied from src/git/gitStatus.ts, which imports tauri at module level).

export interface GitChange {
  /** Repo-relative, forward slashes. */
  path: string;
  /** Where a rename/copy came from. */
  orig_path: string | null;
  /** One of M A D R C T U ? */
  status: string;
}

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

interface GitBranch {
  /** Short name; `origin/feature` for a remote one. */
  name: string;
  upstream: string | null;
  last_commit_unix: number | null;
}

export interface GitBranches {
  /** `null` when the HEAD is detached. */
  current: string | null;
  local: GitBranch[];
  /** Without the ones a local branch already tracks. */
  remote: GitBranch[];
}
