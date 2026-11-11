import { useEffect, useMemo, useRef, useState } from "react";
import { foldDiff, lineDiff } from "../../shared/lineDiff";
import { requestFs } from "./explorerRemote";
import { gitRequest } from "./gitRemote";
import { t } from "./i18n";
import { useRemoteSelector } from "./remote";

interface Props {
  root: string;
  /** Repo-relative, forward slashes. */
  path: string;
  staged: boolean;
  status: string;
}

const POLL_MS = 5000;
const join = (root: string, path: string) => `${root.replace(/[\\/]+$/, "")}/${path}`;

/** Read-only unified diff of one file, as the desktop's: staged = HEAD against the index; unstaged = the index against the file on disk (deleted reads as empty). */
export function WideDiffView({ root, path, staged, status }: Props) {
  const [sides, setSides] = useState<{ a: string; b: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Folded runs the user expanded, by their first row's old/new numbers. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const online = useRemoteSelector((s) => s.status) === "online";
  const seq = useRef(0);

  useEffect(() => {
    if (!online) return;
    let live = true;
    const load = async () => {
      const id = ++seq.current;
      try {
        const [a, b] = staged
          ? await Promise.all([gitRequest<string>({ op: "show", root, path, rev: "HEAD" }), gitRequest<string>({ op: "show", root, path, rev: "INDEX" })])
          : await Promise.all([
              gitRequest<string>({ op: "show", root, path, rev: "INDEX" }),
              requestFs({ op: "read", path: join(root, path) }).then((r) => (r.kind === "file" ? r.text : ""), () => ""),
            ]);
        if (!live || id !== seq.current) return;
        setError(null);
        setSides((p) => (p && p.a === a && p.b === b ? p : { a, b }));
      } catch (e) {
        if (live && id === seq.current) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [root, path, staged, online]);

  const chunks = useMemo(() => (sides ? foldDiff(lineDiff(sides.a, sides.b)) : []), [sides]);
  const slash = path.lastIndexOf("/") + 1;
  const digits = useMemo(() => {
    let max = 1;
    for (const c of chunks) for (const r of c.rows) max = Math.max(max, "oldNo" in r ? r.oldNo : 0, "newNo" in r ? r.newNo : 0);
    return String(max).length;
  }, [chunks]);

  return (
    <div className="wfv wdv">
      <div className="w-ph wfv-bar">
        <span className="wfv-path" title={path}>
          {path.slice(0, slash)}
          <b>{path.slice(slash)}</b>
        </span>
        <span className="wfv-tag">{staged ? t("wsStaged") : status === "?" ? t("wsUntracked") : t("wsChanges")}</span>
      </div>
      {error && <div className="empty">{t("wsGitError", { error })}</div>}
      {!error && !sides && <div className="empty">{t("loading")}</div>}
      {!error && sides && chunks.every((c) => c.rows.every((r) => r.kind === "same")) && <div className="empty">{t("wsNoDiff")}</div>}
      {!error && sides && (
        <div className="wfv-code wdv-code" style={{ "--digits": digits } as React.CSSProperties}>
          {chunks.map((c, i) => {
            const first = c.rows[0];
            const key = `${i}:${first && "oldNo" in first ? first.oldNo : 0}`;
            if (c.folded && !expanded.has(key))
              return (
                <button key={key} type="button" className="wdv-fold" onClick={() => setExpanded((s) => new Set(s).add(key))}>
                  {t("wsUnchanged", { n: c.rows.length })}
                </button>
              );
            return c.rows.map((r, j) => (
              <div key={key + ":" + j} className={"wfv-line wdv-" + r.kind}>
                <span className="wfv-no">{"oldNo" in r ? r.oldNo : ""}</span>
                <span className="wfv-no">{"newNo" in r ? r.newNo : ""}</span>
                <span className="wdv-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                <span className="wfv-text">{r.text}</span>
              </div>
            ));
          })}
        </div>
      )}
    </div>
  );
}
