import { useExitGhost } from "../hooks/useExitGhost";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { DiffView } from "../git/DiffView";
import { GitBackendContext } from "../git/gitStatus";
import { remoteGitBackend } from "./remoteGit";
import "../dialog/modal.css";
import "./remote-files.css";

interface OpenDiff {
  hostId: string;
  root: string;
  /** Repo-relative, forward slashes. */
  path: string;
  staged: boolean;
}

let current: OpenDiff | null = null;
const subs = new Set<() => void>();

/** Shows the diff of one file of a repository on another PC (the Git drawer's rows open it), read-only. */
export function openRemoteDiff(diff: OpenDiff | null) {
  current = diff;
  subs.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};

export function RemoteDiffViewer({ hostId }: { hostId: string }) {
  const exitRef = useExitGhost<HTMLDivElement>();
  const { t } = useI18n();
  const open = useSyncExternalStore(subscribe, () => current);
  const diff = open && open.hostId === hostId ? open : null;
  const git = useMemo(() => remoteGitBackend(hostId), [hostId]);
  useEffect(() => {
    if (!diff) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openRemoteDiff(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diff]);
  // Leaving the PC takes its diff away.
  useEffect(() => () => openRemoteDiff(null), [hostId]);
  if (!diff) return null;
  return createPortal(
    <div className="modal-backdrop" ref={exitRef} onMouseDown={(e) => e.target === e.currentTarget && openRemoteDiff(null)}>
      <div className="modal-panel remote-file-panel remote-diff-panel" role="dialog" aria-modal="true" aria-label={diff.path}>
        <div className="remote-file-head">
          <div className="remote-file-name">
            <b>{diff.path}</b>
          </div>
          <button type="button" className="settings-choice" onClick={() => openRemoteDiff(null)}>
            {t("common.close")}
          </button>
        </div>
        <div className="remote-diff-body">
          <GitBackendContext.Provider value={git}>
            <DiffView root={diff.root} path={diff.path} staged={diff.staged} />
          </GitBackendContext.Provider>
        </div>
      </div>
    </div>,
    document.body,
  );
}
