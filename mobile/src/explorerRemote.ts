import { useEffect, useState } from "react";
import type { FsRequest, FsResponse } from "../../shared/remote-types";
import { onMessage, sendChecked, useRemoteSelector } from "./remote";
import { t } from "./i18n";

let sequence = 0;
/** Replies are correlated, so simultaneous pickers, reads and stale replies cannot cross. */
export function requestFs(request: FsRequest, signal?: AbortSignal): Promise<FsResponse> {
  return new Promise((resolve, reject) => {
    const requestId = `fs-${Date.now()}-${++sequence}`;
    const message = { t: "fs" as const, requestId, request };
    if (new TextEncoder().encode(JSON.stringify(message)).length >= 1024 * 1024) { reject(new Error(t("filesTooLarge"))); return; }
    let done = false;
    const finish = (error?: Error, response?: FsResponse) => {
      if (done) return;
      done = true; clearTimeout(timer); off(); signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(response!);
    };
    const abort = () => finish(new DOMException("Aborted", "AbortError"));
    const off = onMessage((m) => {
      if (m.t !== "fs" || m.requestId !== requestId) return;
      if (m.error || !m.response) finish(new Error(m.error || t("fileError")));
      else finish(undefined, m.response);
    });
    const timer = setTimeout(() => finish(new Error(t("filesTimeout"))), 20_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    void sendChecked(message).then((ok) => { if (!ok) finish(new Error(t("filesOffline"))); });
  });
}

export const fullPath = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, "")}/${name}`;
export const folderName = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;

/** A null path is Computer. Requests retry after reconnect and discard stale responses. */
export function useExplorer(path: string | null, revision = 0, enabled = true) {
  const [state, setState] = useState<{ key?: string; response?: FsResponse; error?: string }>({});
  const status = useRemoteSelector((r) => r.status);
  const hostName = useRemoteSelector((r) => r.hostName);
  const key = JSON.stringify([path, revision, status, hostName, enabled]);
  useEffect(() => {
    const controller = new AbortController();
    if (!enabled) return;
    setState({ key });
    if (status !== "online") { setState({ key, error: t("filesOffline") }); return; }
    void requestFs(path === null ? { op: "roots" } : { op: "list", path }, controller.signal)
      .then((response) => setState({ key, response }), (e: Error) => { if (!controller.signal.aborted) setState({ key, error: e.message }); });
    return () => controller.abort();
  }, [key]);
  return state.key === key ? state : {};
}
