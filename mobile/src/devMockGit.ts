// DEV ONLY: git, history and resume replies for the browser preview. Never touches a repository.
import { emit } from "@tauri-apps/api/event";
import type { ClientMsg, HistoryResult } from "../../shared/remote-types";

const change = (path: string, status: string) => ({ path, orig_path: null, status });
const now = Date.now();

function gitResult(r: Extract<ClientMsg, { t: "git" }>["request"]): unknown {
  switch (r.op) {
    case "toplevel": return r.path;
    case "status":
      return {
        branch: "main", head: "a1b2c3d", upstream: "origin/main", ahead: 1, behind: 0,
        staged: [change("src/App.tsx", "M")],
        unstaged: [change("mobile/src/remote.ts", "M"), change("README.md", "D")],
        untracked: [change("notes.txt", "?")],
        conflicted: [],
      };
    case "branches":
      return {
        current: "main",
        local: [{ name: "main", upstream: "origin/main", last_commit_unix: now / 1000 }, { name: "feat/phone-git", upstream: null, last_commit_unix: now / 1000 - 86400 }],
        remote: [{ name: "origin/release", upstream: null, last_commit_unix: now / 1000 - 604800 }],
      };
    case "show": return r.rev === "HEAD" ? "line one\nline two\n" : "line one\nline two changed\n";
    case "commit": return "a1b2c3e";
    default: return null;
  }
}

const historyMock = (cwd: string): HistoryResult => ({
  roots: [cwd],
  claude: [
    { cwd, sessionId: "7f3c9e2a-41d0-4b6e-9a3a-2f6d1c8e5b10", title: "Fix the login redirect", startedAt: now - 7200_000, updatedAt: now - 3600_000, profile: null },
    { cwd, sessionId: "11111111-aaaa-bbbb-cccc-000000000002", title: null, startedAt: now - 172800_000, updatedAt: now - 170000_000, profile: null },
  ],
  codex: [
    { cwd, sessionId: "22222222-aaaa-bbbb-cccc-000000000001", startedAt: now - 86400_000, wslDistro: null, name: "Refactor the parser", live: false, status: null, inFlowcode: false, profile: null },
  ],
  vibe: [],
  opencode: [],
});

export function gitMock(msg: ClientMsg | undefined) {
  if (msg?.t === "git") {
    const { requestId, request } = msg;
    let result: unknown, error: string | undefined;
    try { result = gitResult(request); } catch (e) { error = String((e as Error).message); }
    setTimeout(() => void emit("remote://msgs", [{ t: "git", requestId, result: result ?? null, error }]), 60);
  } else if (msg?.t === "history") {
    const { requestId, cwd } = msg;
    setTimeout(() => void emit("remote://msgs", [{ t: "history", requestId, result: historyMock(cwd) }]), 60);
  }
  // `resume` is accepted and ignored.
}
