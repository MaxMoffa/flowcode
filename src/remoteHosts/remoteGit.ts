import type { GitRequest } from "../../shared/remote-types";
import type { GitBackend, GitBranches, GitStatus } from "../git/gitStatus";
import { hostRequest } from "./hostRequest";
import { readRemoteFile } from "./remoteFiles";

/** The Git panel's repository access for another PC: its `git` protocol messages (the phone's), answered with that PC's own `git_*` results. */
export function remoteGitBackend(hostId: string): GitBackend {
  const ask = async <T>(request: GitRequest): Promise<T> => {
    const m = await hostRequest(hostId, "git", (requestId) => ({ t: "git", requestId, request }));
    return (m.result ?? null) as T;
  };
  return {
    toplevel: (path) => ask<string | null>({ op: "toplevel", path }),
    status: (root) => ask<GitStatus>({ op: "status", root }),
    stage: (root, paths) => ask<void>({ op: "stage", root, paths }),
    unstage: (root, paths) => ask<void>({ op: "unstage", root, paths }),
    commit: (root, message) => ask<string>({ op: "commit", root, message }),
    showFile: async (root, path, rev) => (await ask<string | null>({ op: "show", root, path, rev })) ?? "",
    discard: (root, paths, untracked) => ask<void>({ op: "discard", root, paths, untracked }),
    branches: (root) => ask<GitBranches>({ op: "branches", root }),
    switchBranch: (root, name, createFromRemote) => ask<void>({ op: "switch", root, name, createFromRemote }),
    readText: (path) => readRemoteFile(hostId, path).then((f) => f.text, () => ""),
  };
}
