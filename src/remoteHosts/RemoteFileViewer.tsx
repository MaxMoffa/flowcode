import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n";
import { basename } from "../lib/path";
import { openRemoteFile, readRemoteFile, useOpenRemoteFile, type RemoteFileText } from "./remoteFiles";
import "../dialog/modal.css";
import "./remote-files.css";

/** Shown lines at most: a huge log would freeze the view. The rest is cut with a note. */
const MAX_LINES = 20_000;

const close = () => openRemoteFile(null);

/** A file of another PC, read-only, opened from a link in its chat or from its explorer. One at a time. */
export function RemoteFileViewer({ hostId }: { hostId: string }) {
  const { t } = useI18n();
  const open = useOpenRemoteFile();
  const file = open && open.hostId === hostId ? open : null;
  const [loaded, setLoaded] = useState<{ path: string; result: RemoteFileText | Error } | null>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const path = file?.path;

  useEffect(() => {
    if (!path) return;
    let live = true;
    readRemoteFile(hostId, path).then(
      (result) => live && setLoaded({ path, result }),
      (e: Error) => live && setLoaded({ path, result: e }),
    );
    return () => {
      live = false;
    };
  }, [hostId, path]);

  useEffect(() => {
    if (!path) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [path]);

  // Leaving the PC takes its file away.
  useEffect(() => () => openRemoteFile(null), [hostId]);

  const result = loaded && loaded.path === path ? loaded.result : null;
  const ok = result && !(result instanceof Error) ? result : null;
  const lines = useMemo(() => (ok ? ok.text.split("\n") : []), [ok]);
  const targetLine = file?.line;
  useEffect(() => {
    if (ok) targetRef.current?.scrollIntoView({ block: "center" });
  }, [ok, targetLine]);

  if (!file) return null;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal-panel remote-file-panel" role="dialog" aria-modal="true" aria-label={basename(file.path)}>
        <div className="remote-file-head">
          <div className="remote-file-name">
            <b>{basename(file.path)}</b>
            <small title={file.path}>{file.path}</small>
          </div>
          <button type="button" className="settings-choice" disabled={!ok} onClick={() => ok && void navigator.clipboard.writeText(ok.text).catch(() => {})}>
            {t("remoteHosts.file.copy")}
          </button>
          <button type="button" className="settings-choice" onClick={close}>
            {t("common.close")}
          </button>
        </div>
        <div className="remote-file-body">
          {!result && <div className="remote-file-note">{t("common.loading")}</div>}
          {result instanceof Error && <div className="remote-file-note">{result.message === "offline" ? t("remoteHosts.file.offline") : t("remoteHosts.file.failed", { error: result.message })}</div>}
          {ok &&
            lines.slice(0, MAX_LINES).map((line, i) => (
              <div key={i} ref={i + 1 === targetLine ? targetRef : undefined} className={"remote-file-line" + (i + 1 === targetLine ? " is-target" : "")}>
                <span className="remote-file-no">{i + 1}</span>
                <span>{line}</span>
              </div>
            ))}
        </div>
        {ok && (ok.truncated || lines.length > MAX_LINES) && <div className="remote-file-note">{t("remoteHosts.file.truncated")}</div>}
      </div>
    </div>,
    document.body,
  );
}
