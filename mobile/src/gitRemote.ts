import type { ClientMsg, GitRequest, HistoryResult, ServerMsg } from "../../shared/remote-types";
import { onMessage, send, sendChecked } from "./remote";
import { t } from "./i18n";

let sequence = 0;

/** Sends a correlated request and resolves with the matching reply's payload (the error string rejects). */
function correlated<T>(prefix: string, kind: "git" | "history", build: (requestId: string) => ClientMsg, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = `${prefix}-${Date.now()}-${++sequence}`;
    let done = false;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true; clearTimeout(timer); off();
      if (error) reject(error); else resolve(value as T);
    };
    const off = onMessage((m: ServerMsg) => {
      if (m.t !== kind || m.requestId !== requestId) return;
      if (m.error) finish(new Error(m.error));
      else finish(undefined, (m.result ?? null) as T);
    });
    const timer = setTimeout(() => finish(new Error(t("filesTimeout"))), timeoutMs);
    void sendChecked(build(requestId)).then((ok) => { if (!ok) finish(new Error(t("filesOffline"))); });
  });
}

/** One Git panel operation on the desktop (`git` cap); rejects with the desktop's error string. */
export const gitRequest = <T>(request: GitRequest): Promise<T> =>
  correlated<T>("git", "git", (requestId) => ({ t: "git", requestId, request }), 30_000);

/** The agent sessions of the project at `cwd` (`history` cap). */
export const historyRequest = (cwd: string): Promise<HistoryResult> =>
  correlated<HistoryResult>("hist", "history", (requestId) => ({ t: "history", requestId, cwd }), 30_000);

/** Resumes an agent session in a new desktop tab (`resume` cap); fire and forget. */
export function resumeSession(p: { cwd: string; sessionId: string; cli: string; wslDistro?: string | null; profile?: string | null; view?: "chat" | "terminal" }): void {
  send({ t: "resume", cwd: p.cwd, sessionId: p.sessionId, cli: p.cli, wslDistro: p.wslDistro ?? undefined, profile: p.profile ?? undefined, view: p.view });
}
