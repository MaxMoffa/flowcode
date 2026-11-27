import type { ClientMsg, ServerMsg } from "../../shared/remote-types";
import { onHostLeavesOnline, onHostMessages, sendToHost } from "./remoteHosts";

let sequence = 0;

type Reply<K extends ServerMsg["t"]> = Extract<ServerMsg, { t: K }>;

/** Sends a correlated request (`history`, `historydelete`, `fs`, `git`) to a PC and resolves with its reply; the host's error string rejects. */
export function hostRequest<K extends "history" | "historydelete" | "fs" | "git">(hostId: string, kind: K, build: (requestId: string) => ClientMsg, timeoutMs = 30_000): Promise<Reply<K>> {
  return new Promise((resolve, reject) => {
    const requestId = `${kind}-${Date.now()}-${++sequence}`;
    let done = false;
    const finish = (error?: Error, value?: Reply<K>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      stopLink();
      if (error) reject(error);
      else resolve(value as Reply<K>);
    };
    const stop = onHostMessages(hostId, (msgs) => {
      for (const m of msgs) {
        if (m.t !== kind || (m as { requestId?: string }).requestId !== requestId) continue;
        const reply = m as Reply<K>;
        const error = (reply as { error?: string }).error;
        if (error) finish(new Error(error));
        else finish(undefined, reply);
        return;
      }
    });
    // The link dropped (or was replaced): the reply can't come, don't wait out the timeout.
    const stopLink = onHostLeavesOnline(hostId, () => finish(new Error("offline")));
    const timer = setTimeout(() => finish(new Error("timeout")), timeoutMs);
    void sendToHost(hostId, build(requestId)).then((ok) => {
      if (!ok) finish(new Error("offline"));
    });
  });
}
