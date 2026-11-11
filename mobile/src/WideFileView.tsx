import { useEffect, useMemo, useRef, useState } from "react";
import type { FsResponse } from "../../shared/remote-types";
import { shortCwd } from "./common";
import { t } from "./i18n";
import { CopyIcon } from "./icons";
import { requestFs } from "./explorerRemote";
import { onMessage, send, showToast, useRemoteSelector } from "./remote";

type Body = { state: "loading" } | { state: "error" } | { state: "text"; text: string; truncated: boolean };

/** Read-only view of one file of a terminal's folder (`cwd`), through the old relative `read`: for desktops without the file explorer. */
export function LegacyFileView({ ptyId, path, cwd }: { ptyId: string; path: string; cwd?: string }) {
  const [body, setBody] = useState<Body>({ state: "loading" });
  // Reads asked for and not answered yet: only the reply to the latest one counts.
  const pending = useRef(0);
  const status = useRemoteSelector((s) => s.status);
  const loaded = body.state === "text";

  useEffect(() => {
    if (status !== "online") {
      // Replies of the old connection will never come.
      pending.current = 0;
      return;
    }
    if (loaded) return;
    setBody({ state: "loading" });
    pending.current++;
    send({ t: "read", ptyId, path });
  }, [ptyId, path, status, loaded]);

  useEffect(
    () =>
      onMessage((m) => {
        if ((m.t !== "file" && m.t !== "error") || m.ptyId !== ptyId || pending.current === 0) return;
        if (--pending.current > 0) return;
        setBody(m.t === "file" ? { state: "text", text: m.text, truncated: m.truncated } : { state: "error" });
      }),
    [ptyId],
  );

  const lines = useMemo(() => {
    if (body.state !== "text") return [];
    const l = body.text.split(/\r?\n/);
    if (l.length > 1 && l[l.length - 1] === "") l.pop();
    return l;
  }, [body]);

  const slash = path.lastIndexOf("/") + 1;
  const dir = (cwd ? shortCwd(cwd) + "/" : "") + path.slice(0, slash);
  const copyPath = () =>
    navigator.clipboard
      .writeText(cwd ? `${cwd.replace(/[\/]+$/, "")}/${path}` : path)
      .then(() => showToast(t("copied")))
      .catch(() => {});

  return (
    <div className="wfv">
      <div className="w-ph wfv-bar">
        <span className="wfv-path" title={path}>
          {dir}
          <b>{path.slice(slash)}</b>
        </span>
        <span className="wfv-tag">{t("readOnly")}</span>
        {body.state === "text" && body.truncated && <span className="wfv-tag warn">{t("truncated")}</span>}
        <span className="w-grow" />
        <button type="button" className="w-ib sm" aria-label={t("copyPath")} onClick={copyPath}>
          <CopyIcon />
        </button>
      </div>
      {body.state === "loading" && <div className="empty">{t("loading")}</div>}
      {body.state === "error" && <div className="empty">{t("fileError")}</div>}
      {body.state === "text" && (
        <div className="wfv-code" style={{ "--digits": String(lines.length).length } as React.CSSProperties}>
          {lines.map((l, i) => (
            <div key={i} className="wfv-line">
              <span className="wfv-no">{i + 1}</span>
              <span className="wfv-text">{l}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One file by absolute path, with line numbers and the desktop editor's toolbar: Edit / Save (version-checked) / Cancel. */
export function WideFileView({ path }: { path: string }) {
  const [body, setBody] = useState<Extract<FsResponse, { kind: "file" }> | null>(null);
  const [error, setError] = useState("");
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const status = useRemoteSelector((s) => s.status);

  useEffect(() => {
    if (status !== "online") return;
    const controller = new AbortController();
    setError("");
    requestFs({ op: "read", path }, controller.signal).then(
      (r) => {
        if (r.kind !== "file") return;
        setBody(r);
        setDraft(r.text);
      },
      (e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      },
    );
    return () => controller.abort();
  }, [path, revision, status]);

  const lines = useMemo(() => {
    if (!body) return [];
    const l = body.text.split(/\r?\n/);
    if (l.length > 1 && l[l.length - 1] === "") l.pop();
    return l;
  }, [body]);

  const save = async () => {
    if (!body?.version || body.truncated || busy) return;
    setBusy(true);
    setError("");
    try {
      await requestFs({ op: "write", path: body.path, text: draft, version: body.version });
      setEdit(false);
      setBody(null);
      setRevision((n) => n + 1);
      showToast(t("filesSaved"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    if (draft !== body?.text && !window.confirm(t("filesUnsaved"))) return;
    setDraft(body?.text ?? "");
    setEdit(false);
  };
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
  const copyPath = () =>
    navigator.clipboard
      .writeText(path)
      .then(() => showToast(t("copied")))
      .catch(() => {});
  const editable = !!body?.version && !body.truncated;

  return (
    <div className="wfv">
      <div className="w-ph wfv-bar">
        <span className="wfv-path" title={path}>
          {path.slice(0, slash)}
          <b>{path.slice(slash)}</b>
        </span>
        {body?.truncated && <span className="wfv-tag warn">{t("truncated")}</span>}
        <span className="w-grow" />
        {edit && (
          <button type="button" className="wfv-btn" disabled={busy} onClick={cancel}>
            {t("profileCancel")}
          </button>
        )}
        {editable && (
          <button type="button" className="wfv-btn primary" disabled={busy} onClick={() => (edit ? void save() : setEdit(true))}>
            {busy ? t("loading") : edit ? t("filesSave") : t("filesEdit")}
          </button>
        )}
        <button type="button" className="w-ib sm" aria-label={t("copyPath")} onClick={copyPath}>
          <CopyIcon />
        </button>
      </div>
      {error && <div className="wfv-err" role="alert">{error}</div>}
      {body?.truncated && <div className="wfv-err">{t("filesTruncatedReadOnly")}</div>}
      {!body && !error && <div className="empty">{t("loading")}</div>}
      {!body && error && <div className="empty">{t("fileError")}</div>}
      {body && edit && <textarea className="wfv-edit" aria-label={t("filesEdit")} spellCheck={false} value={draft} disabled={busy} onChange={(e) => setDraft(e.target.value)} />}
      {body && !edit && (
        <div className="wfv-code" style={{ "--digits": String(lines.length).length } as React.CSSProperties}>
          {lines.map((l, i) => (
            <div key={i} className="wfv-line">
              <span className="wfv-no">{i + 1}</span>
              <span className="wfv-text">{l}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
