import { joinRepoPath, type GitChange, type GitStatus } from "./gitStatus";

export interface GitDecor {
  /** Status letter for a file (absolute path), `undefined` when unchanged or deleted. */
  file(path: string): string | undefined;
  /** Whether something changed strictly inside this folder (absolute path). */
  dir(path: string): boolean;
}

// Windows paths are case-insensitive and mix separators: compare normalised.
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/** Per-path decorations for the file tree, built once per status. */
export function buildGitDecor(root: string, status: GitStatus): GitDecor {
  const letters = new Map<string, string>();
  const dirs = new Set<string>();
  const rootKey = norm(root);

  const markAncestors = (key: string) => {
    let i = key.lastIndexOf("/");
    while (i > 0) {
      const parent = key.slice(0, i);
      if (dirs.has(parent)) break;
      dirs.add(parent);
      if (parent === rootKey) break;
      i = parent.lastIndexOf("/");
    }
  };

  const add = (c: GitChange, letter: string | undefined, overwrite: boolean) => {
    const key = norm(joinRepoPath(root, c.path));
    if (letter && (overwrite || !letters.has(key))) letters.set(key, letter);
    markAncestors(key);
    // An untracked folder is reported as "dir/": it is a changed folder itself.
    if (c.path.endsWith("/")) dirs.add(key);
  };

  // Priority conflicted > untracked > unstaged > staged: later lists only fill gaps.
  for (const c of status.conflicted) add(c, "!", true);
  for (const c of status.untracked) add(c, "U", false);
  for (const c of status.unstaged) add(c, c.status === "D" ? undefined : c.status === "?" ? "U" : c.status, false);
  for (const c of status.staged) add(c, c.status === "D" ? undefined : c.status, false);

  return {
    file: (path) => letters.get(norm(path)),
    dir: (path) => dirs.has(norm(path)),
  };
}
