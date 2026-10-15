import { useEffect, useMemo, useRef, useState } from "react";
import { shortCwd } from "./common";
import { t } from "./i18n";
import { CopyIcon } from "./icons";
import { onMessage, send, showToast, useRemoteSelector } from "./remote";

type Body = { state: "loading" } | { state: "error" } | { state: "text"; text: string; truncated: boolean };

/** A read-only view of one file of a terminal's folder (`cwd`), with line numbers and the desktop editor's toolbar minus save. */
export function WideFileView({ ptyId, path, cwd }: { ptyId: string; path: string; cwd?: string }) {
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
