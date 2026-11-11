import { useCallback, useEffect, useRef, useState } from "react";
import { gitRequest } from "./gitRemote";
import type { GitBranches, GitChange, GitStatus } from "./gitTypes";
import { t } from "./i18n";
import { CheckIcon, PlusIcon, RefreshIcon } from "./icons";
import { showToast } from "./remote";

const POLL_MS = 5000;

interface Props {
  cwd: string;
  visible: boolean;
  onOpenDiff: (root: string, path: string, staged: boolean, status: string) => void;
  /** The number of changed files, for the tab's badge. */
  onCount?: (n: number) => void;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dirName = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
/** The class of the status letter (as the desktop's .git-status-*). */
const statusClass = (s: string, conflict: boolean) => "wg-status wg-status-" + (conflict ? "conflict" : s === "?" ? "U" : s);

type Group = { key: "conflicts" | "staged" | "changes" | "untracked"; label: string; rows: GitChange[]; staged: boolean };

/** The Git tab of the wide sidebar: the desktop's Git panel (branch, changes, stage / discard, commit). */
export function WideGit({ cwd, visible, onOpenDiff, onCount }: Props) {
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [branches, setBranches] = useState<GitBranches | null>(null);
  const [picker, setPicker] = useState(false);
  const rootRef = useRef(root);
  rootRef.current = root;
  const seq = useRef(0);

  // The repository of the folder; another folder starts over.
  useEffect(() => {
    let live = true;
    setRoot(undefined);
    setStatus(null);
    setError(null);
    setPicker(false);
    gitRequest<string | null>({ op: "toplevel", path: cwd }).then(
      (r) => live && setRoot(r),
      (e: Error) => {
        if (!live) return;
        setRoot(null);
        setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [cwd]);

  const refresh = useCallback(async () => {
    const r = rootRef.current;
    if (!r) return;
    const id = ++seq.current;
    try {
      const s = await gitRequest<GitStatus>({ op: "status", root: r });
      if (id !== seq.current || rootRef.current !== r) return;
      setStatus(s);
      setError(null);
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Refresh when the tab is shown and every few seconds while it is.
  useEffect(() => {
    if (!root) return;
    // Once even while hidden, for the tab's badge.
    void refresh();
    if (!visible) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [root, visible, refresh]);

  const count = status ? status.conflicted.length + status.staged.length + status.unstaged.length + status.untracked.length : 0;
  useEffect(() => {
    onCount?.(count);
  }, [count, onCount]);

  const run = async (op: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await op();
    } catch (e) {
      showToast(t("wsGitError", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
      void refresh();
    }
  };
  const stage = (rows: GitChange[]) => run(() => gitRequest({ op: "stage", root: root!, paths: rows.map((r) => r.path) }));
  const unstage = (rows: GitChange[]) => run(() => gitRequest({ op: "unstage", root: root!, paths: rows.map((r) => r.path) }));
  const discard = (row: GitChange, untracked: boolean) => {
    const name = baseName(row.path);
    if (!window.confirm(t(untracked ? "wsDiscardUntrackedConfirm" : "wsDiscardConfirm", { name }))) return;
    void run(() => gitRequest({ op: "discard", root: root!, paths: [row.path], untracked }));
  };
  const commit = () =>
    run(async () => {
      const hash = await gitRequest<string>({ op: "commit", root: root!, message });
      setMessage("");
      showToast(t("wsCommitted", { hash }));
    });

  const openPicker = () => {
    const next = !picker;
    setPicker(next);
    if (next && root)
      gitRequest<GitBranches>({ op: "branches", root }).then(setBranches, (e: Error) => {
        setPicker(false);
        showToast(t("wsGitError", { error: e.message }));
      });
  };
  const switchTo = (name: string, remote: boolean) => {
    if (!window.confirm(t("wsSwitchConfirm", { name }))) return;
    setPicker(false);
    void run(() => gitRequest({ op: "switch", root: root!, name, createFromRemote: remote }));
  };

  if (root === undefined) return <div className="empty">{t("loading")}</div>;
  if (root === null) return <div className="empty">{error ?? t("wsNotRepo")}</div>;

  const groups: Group[] = status
    ? [
        { key: "conflicts" as const, label: t("wsConflicts"), rows: status.conflicted, staged: false },
        { key: "staged" as const, label: t("wsStaged"), rows: status.staged, staged: true },
        { key: "changes" as const, label: t("wsChanges"), rows: status.unstaged, staged: false },
        { key: "untracked" as const, label: t("wsUntracked"), rows: status.untracked, staged: false },
      ].filter((g) => g.rows.length > 0)
    : [];

  const branchLabel = status?.branch ?? t("wsDetached");
  return (
    <>
      <div className="w-ph wg-head">
        <button type="button" className="wg-branch" aria-expanded={picker} title={t("wsSwitchBranch")} onClick={openPicker}>
          <b>{branchLabel}</b>
          {status && (status.ahead > 0 || status.behind > 0) && (
            <small title={t("wsAheadBehind", { ahead: status.ahead, behind: status.behind })}>
              {status.ahead > 0 ? `↑${status.ahead}` : ""}
              {status.behind > 0 ? `↓${status.behind}` : ""}
            </small>
          )}
        </button>
        <button type="button" className="w-ib sm" aria-label={t("wsRefresh")} title={t("wsRefresh")} onClick={() => void refresh()}>
          <RefreshIcon />
        </button>
      </div>
      {picker && (
        <div className="wg-picker" role="listbox" aria-label={t("wsSwitchBranch")}>
          {!branches && <div className="wt-note">{t("loading")}</div>}
          {branches && [[t("wsBranchLocal"), branches.local, false], [t("wsBranchRemote"), branches.remote, true]].map(([label, list, remote]) => {
            const items = list as GitBranches["local"];
            if (items.length === 0) return null;
            return (
              <div key={String(label)}>
                <div className="wg-group-h">{String(label)}</div>
                {items.map((b) => (
                  <button key={b.name} type="button" role="option" aria-selected={b.name === branches.current} className={"wg-branch-row" + (b.name === branches.current ? " on" : "")} disabled={b.name === branches.current} onClick={() => switchTo(b.name, remote as boolean)}>
                    <span>{b.name}</span>
                    {b.name === branches.current && <CheckIcon />}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
      <div className="wf-list wg-list">
        {error && <div className="wt-note err">{error}</div>}
        {status && groups.length === 0 && <div className="wt-note">{t("wsNoChanges")}</div>}
        {groups.map((g) => (
          <section key={g.key}>
            <div className="wg-group-h">
              <span>{g.label}</span>
              <span className="wg-count">{g.rows.length}</span>
              {g.key === "staged" && (
                <button type="button" className="wg-act" aria-label={t("wsUnstageAll")} title={t("wsUnstageAll")} disabled={busy} onClick={() => void unstage(g.rows)}>
                  −
                </button>
              )}
              {(g.key === "changes" || g.key === "untracked") && (
                <button type="button" className="wg-act" aria-label={t("wsStageAll")} title={t("wsStageAll")} disabled={busy} onClick={() => void stage(g.rows)}>
                  <PlusIcon />
                </button>
              )}
            </div>
            {g.rows.map((row) => {
              const letter = g.key === "conflicts" ? "!" : row.status === "?" ? "U" : row.status;
              const dir = dirName(row.path);
              return (
                <div key={g.key + row.path} className="wg-row">
                  <button type="button" className="wg-file" title={row.path} onClick={() => onOpenDiff(root, row.path, g.staged, row.status)}>
                    <span className={statusClass(row.status, g.key === "conflicts")}>{letter}</span>
                    <span className="wf-name">
                      {baseName(row.path)}
                      {dir && <small>{dir}</small>}
                    </span>
                  </button>
                  {g.key !== "conflicts" && g.key !== "staged" && (
                    <button type="button" className="wg-act" aria-label={t("wsDiscard")} title={t("wsDiscard")} disabled={busy} onClick={() => discard(row, g.key === "untracked")}>
                      ↶
                    </button>
                  )}
                  {g.key === "staged" ? (
                    <button type="button" className="wg-act" aria-label={t("wsUnstage")} title={t("wsUnstage")} disabled={busy} onClick={() => void unstage([row])}>
                      −
                    </button>
                  ) : g.key !== "conflicts" ? (
                    <button type="button" className="wg-act" aria-label={t("wsStage")} title={t("wsStage")} disabled={busy} onClick={() => void stage([row])}>
                      <PlusIcon />
                    </button>
                  ) : null}
                </div>
              );
            })}
          </section>
        ))}
      </div>
      <div className="wg-commit">
        <textarea value={message} rows={2} placeholder={t("wsCommitPlaceholder")} aria-label={t("wsCommitPlaceholder")} disabled={busy} onChange={(e) => setMessage(e.target.value)} />
        <button type="button" className="wg-commit-btn" disabled={busy || !message.trim() || !status || status.staged.length === 0} onClick={() => void commit()}>
          {busy ? t("wsCommitting") : t("wsCommit")}
        </button>
      </div>
    </>
  );
}
