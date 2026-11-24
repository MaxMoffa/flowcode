import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { hostRequest } from "./hostRequest";
import { useHost } from "./remoteHosts";
import { openRemoteFile } from "./remoteFiles";
import type { LsEntry } from "../../shared/remote-types";
import "../sidebar/sidebar.css";

interface Listing {
  path: string;
  parent: string | null;
  entries: LsEntry[];
  truncated: boolean;
}

const joinPath = (dir: string, name: string) => dir + (/[\\/]$/.test(dir) ? "" : dir.includes("\\") ? "\\" : "/") + name;

/** The folders of the other PC's tab in front, one level at a time, read through its file explorer (`fs`). Read-only. */
export function RemoteExplorer({ hostId, cwd, visible }: { hostId: string; cwd: string; visible: boolean }) {
  const { t } = useI18n();
  const host = useHost(hostId);
  const online = host?.status === "online";
  const [path, setPath] = useState(cwd);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const seq = useRef(0);

  // The front tab moved to another folder: follow it.
  useEffect(() => setPath(cwd), [cwd, hostId]);

  const load = useCallback(() => {
    const id = ++seq.current;
    hostRequest(hostId, "fs", (requestId) => ({ t: "fs", requestId, request: { op: "list", path } }))
      .then((m) => {
        if (id !== seq.current || m.response?.kind !== "list") return;
        setError(null);
        setListing({ path, parent: m.response.parent, entries: m.response.entries, truncated: m.response.truncated });
      })
      .catch((e: Error) => id === seq.current && setError(e.message));
  }, [hostId, path]);

  useEffect(() => {
    if (!visible || !online) return;
    load();
    return () => void seq.current++;
  }, [visible, online, load]);

  const mine = listing && listing.path === path ? listing : null;
  const entries = (mine?.entries ?? [])
    .filter((e) => showHidden || (!e.hidden && !e.name.startsWith(".")))
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

  return (
    <div className="file-tree">
      <div className="file-tree-header">
        <button type="button" className="file-tree-back" aria-label={t("files.up")} title={t("files.up")} disabled={!mine?.parent} onClick={() => mine?.parent && setPath(mine.parent)}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 6l-6 6 6 6" />
          </svg>
        </button>
        <button type="button" className="file-tree-back" aria-label={t("remoteHosts.explorer.project")} title={t("remoteHosts.explorer.project")} disabled={path === cwd} onClick={() => setPath(cwd)}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 11l8-7 8 7M6 10v9h12v-9" />
          </svg>
        </button>
        <span className="file-tree-header-label" title={path}>
          {path}
        </span>
        <button type="button" className={"file-tree-menu-btn" + (showHidden ? " is-active" : "")} aria-pressed={showHidden} aria-label={t("remoteHosts.explorer.hidden")} title={t("remoteHosts.explorer.hidden")} onClick={() => setShowHidden((v) => !v)}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" />
            <circle cx="12" cy="12" r="2.6" />
          </svg>
        </button>
      </div>
      <div className="file-tree-list">
        {error && !mine && <div className="file-tree-loading">{error === "offline" ? t("remoteHosts.offlineEmpty", { name: host?.hostName ?? "" }) : error}</div>}
        {!error && !mine && <div className="file-tree-loading">{t("common.loading")}</div>}
        {mine &&
          entries.map((entry) => (
            <div key={entry.name} className="file-tree-row" onClick={() => (entry.dir ? setPath(joinPath(mine.path, entry.name)) : openRemoteFile({ hostId, path: joinPath(mine.path, entry.name) }))} title={joinPath(mine.path, entry.name)}>
              {entry.dir ? (
                <span className="file-tree-icon ft-folder">
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none">
                    <path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />
                  </svg>
                </span>
              ) : (
                <FileTypeIcon name={entry.name} />
              )}
              <div className="file-tree-name-col">
                <span className="file-tree-name">{entry.name}</span>
              </div>
            </div>
          ))}
        {mine && entries.length === 0 && <div className="file-tree-loading">{t("files.empty")}</div>}
        {mine?.truncated && <div className="file-tree-loading">…</div>}
      </div>
    </div>
  );
}
