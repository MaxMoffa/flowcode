import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { FileTypeIcon } from "../sidebar/fileIcons";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { useI18n } from "../i18n";
import { basename } from "../lib/path";
import {
  gitCommit,
  gitDiscard,
  gitStage,
  gitStatus,
  gitToplevel,
  gitUnstage,
  joinRepoPath,
  type GitChange,
  type GitStatus,
} from "./gitStatus";
import "./git-panel.css";

interface GitPanelProps {
  /** The folder the explorer is on - the repository is whichever one it is in. */
  cwd: string;
  /** Whether the Git tab is the one showing; refreshing only matters then. */
  visible: boolean;
  onOpenFile: (absPath: string) => void;
  onOpenDiff: (root: string, change: GitChange, staged: boolean) => void;
  /** Reports the total number of changes, for the badge on the tab. */
  onCountChange: (count: number) => void;
}

type Section = "conflicts" | "staged" | "changes";

/** A row of the "Changes" group keeps whether it's untracked: that decides
 * what discarding it means (delete vs. restore). */
interface Row {
  change: GitChange;
  untracked: boolean;
}

const POLL_MS = 4000;
// Hidden tab: only the badge needs to stay roughly right.
const HIDDEN_POLL_MS = 15000;
// Failed polls in a row before the panel stops saying "Loading".
const FAIL_LIMIT = 2;

const icons = {
  branch: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="5.5" r="2" />
      <circle cx="6" cy="18.5" r="2" />
      <circle cx="18" cy="8.5" r="2" />
      <path d="M6 7.5v9M18 10.5c0 4-6 3-11 6.5" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 12a8 8 0 0 1 13.66-5.66L20 8.5" />
      <path d="M20 4v4.5h-4.5" />
      <path d="M20 12a8 8 0 0 1-13.66 5.66L4 15.5" />
      <path d="M4 20v-4.5h4.5" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  minus: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 12h14" />
    </svg>
  ),
  discard: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </svg>
  ),
  open: (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3h-7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  ),
};

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

export function GitPanel({ cwd, visible, onOpenFile, onOpenDiff, onCountChange }: GitPanelProps) {
  const { t } = useI18n();
  const confirm = useConfirmDialog();
  // undefined: still resolving, null: not in a repository.
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [message, setMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set after repeated status failures, so a broken repo isn't "Loading" forever.
  const [statusError, setStatusError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<Section, boolean>>({ conflicts: false, staged: false, changes: false });

  // Drops an answer that a newer request (e.g. the one after an action) has
  // overtaken.
  const requestRef = useRef(0);
  const lastJson = useRef("");
  // `git_toplevel` + `git_status` are two process spawns per poll: resolve the
  // repository once per folder and only redo it on a manual refresh or after
  // a failure.
  const topRef = useRef<{ cwd: string; top: string } | null>(null);
  const failRef = useRef(0);

  const refresh = useCallback(
    async (force = false) => {
      const id = ++requestRef.current;
      let top: string | null = !force && topRef.current?.cwd === cwd ? topRef.current.top : null;
      if (!top) {
        top = await gitToplevel(cwd).catch(() => null);
        if (id !== requestRef.current) return;
        topRef.current = top ? { cwd, top } : null;
      }
      setRoot(top);
      if (!top) {
        lastJson.current = "";
        setStatus(null);
        return;
      }
      try {
        const next = await gitStatus(top);
        if (id !== requestRef.current) return;
        failRef.current = 0;
        setStatusError(null);
        // A poll that found nothing new must not re-render the whole list.
        const json = JSON.stringify(next);
        if (json !== lastJson.current) {
          lastJson.current = json;
          setStatus(next);
        }
      } catch (e) {
        if (id !== requestRef.current) return;
        // The cached root may be stale (folder moved/removed): re-resolve next time.
        topRef.current = null;
        // Transient (index.lock held by another git) failures retry silently.
        if (++failRef.current >= FAIL_LIMIT) setStatusError(String(e));
      }
    },
    [cwd],
  );

  // A different folder: forget the previous repository's state right away. The
  // commit message belongs to the repository it was typed for.
  useEffect(() => {
    setRoot(undefined);
    setStatus(null);
    setError(null);
    setStatusError(null);
    setMessage("");
    lastJson.current = "";
    topRef.current = null;
    failRef.current = 0;
  }, [cwd]);

  // Refresh on mount, when the folder changes, when the tab is shown, and on
  // window focus while it is.
  useEffect(() => {
    void refresh();
    if (!visible) return;
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, refresh]);

  // While shown: the explorer's directory watcher (`fs-changed`, which the
  // FileTree keeps running for this cwd even while hidden) covers top-level
  // edits. It is non-recursive and blind to `.git/index` though, so a slow
  // poll catches changes in subfolders and staging done from a terminal.
  // While hidden a slower poll keeps the tab's badge from going stale.
  useEffect(() => {
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const unlisten = visible
      ? listen<string>("fs-changed", (event) => {
          if (event.payload !== cwd) return;
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void refresh(), 300);
        })
      : null;
    const poll = setInterval(
      () => {
        if (document.visibilityState === "visible" && document.hasFocus()) void refresh();
      },
      visible ? POLL_MS : HIDDEN_POLL_MS,
    );
    return () => {
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      unlisten?.then((fn) => fn());
    };
  }, [visible, cwd, refresh]);

  const staged = useMemo(() => (status?.staged ?? []).map((change): Row => ({ change, untracked: false })), [status]);
  const conflicts = useMemo(() => (status?.conflicted ?? []).map((change): Row => ({ change, untracked: false })), [status]);
  const changes = useMemo(
    () => [
      ...(status?.unstaged ?? []).map((change): Row => ({ change, untracked: false })),
      ...(status?.untracked ?? []).map((change): Row => ({ change, untracked: true })),
    ],
    [status],
  );
  const total = staged.length + conflicts.length + changes.length;
  // No status (loading, not a repository, failing) reports 0, which hides the badge.
  const reported = status ? total : 0;
  useEffect(() => onCountChange(reported), [reported, onCountChange]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(t("git.error", { error: String(e) }));
    }
    await refresh();
  }

  const stagePaths = (paths: string[]) => {
    if (root) void run(() => gitStage(root, paths));
  };
  const unstagePaths = (paths: string[]) => {
    if (root) void run(() => gitUnstage(root, paths));
  };

  async function discard(rows: Row[]) {
    if (!root || rows.length === 0) return;
    const untracked = rows.filter((r) => r.untracked);
    const tracked = rows.filter((r) => !r.untracked);
    // Tracked files are restored, untracked ones deleted: different warnings.
    const prompts: string[] = [];
    if (tracked.length > 0) {
      prompts.push(
        tracked.length === 1
          ? t("git.discardTracked.one", { name: basename(tracked[0].change.path) })
          : t("git.discardTracked.many", { count: tracked.length }),
      );
    }
    if (untracked.length > 0) {
      prompts.push(
        untracked.length === 1
          ? t("git.discardUntracked.one", { name: basename(untracked[0].change.path) })
          : t("git.discardUntracked.many", { count: untracked.length }),
      );
    }
    const ok = await confirm({
      title: t("git.discardTitle"),
      message: prompts.join("\n\n"),
      confirmLabel: t("git.discardConfirm"),
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      if (tracked.length > 0) {
        await gitDiscard(
          root,
          tracked.map((r) => r.change.path),
          false,
        );
      }
      if (untracked.length > 0) {
        await gitDiscard(
          root,
          untracked.map((r) => r.change.path),
          true,
        );
      }
    });
  }

  const hasStaged = staged.length > 0;
  const canCommit = !committing && message.trim().length > 0 && total > 0;

  async function commit() {
    if (!root || !canCommit) return;
    setCommitting(true);
    setError(null);
    try {
      // "Commit all": nothing staged yet, so everything goes in (smart commit).
      if (!hasStaged) await gitStage(root, ["."]);
      await gitCommit(root, message);
      setMessage("");
    } catch (e) {
      setError(String(e));
    } finally {
      setCommitting(false);
    }
    await refresh();
  }

  if (root === null) {
    return <div className="git-panel git-empty">{t("git.notRepo")}</div>;
  }
  if (root === undefined || !status) {
    if (statusError) return <div className="git-panel git-empty">{t("git.error", { error: statusError })}</div>;
    return <div className="git-panel git-empty">{t("common.loading")}</div>;
  }
  const repoRoot = root;

  const branchLabel = status.branch ?? (status.head ? `${t("git.detached")} ${status.head}` : t("git.detached"));

  function renderRow(row: Row, section: Section) {
    const { change } = row;
    const isStaged = section === "staged";
    const statusKey = section === "conflicts" ? "conflict" : row.untracked ? "U" : change.status;
    const letter = section === "conflicts" ? "!" : row.untracked ? "U" : change.status;
    const name = basename(change.path);
    const dir = dirOf(change.path);
    const open = () => {
      if (section === "conflicts") onOpenFile(joinRepoPath(repoRoot, change.path));
      else onOpenDiff(repoRoot, change, isStaged);
    };
    return (
      <div
        key={`${section}:${change.path}`}
        className="git-row"
        role="button"
        tabIndex={0}
        title={change.orig_path ? `${change.orig_path} → ${change.path}` : change.path}
        onClick={open}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            open();
          }
        }}
      >
        <span className="file-tree-icon">
          <FileTypeIcon name={name} />
        </span>
        <span className="git-row-name">{name}</span>
        {dir && <span className="git-row-dir">{dir}</span>}
        <span className="git-row-actions">
          <ActionButton label={t("git.openFile")} onClick={() => onOpenFile(joinRepoPath(repoRoot, change.path))}>
            {icons.open}
          </ActionButton>
          {section === "changes" && (
            <ActionButton label={t("git.discard")} onClick={() => void discard([row])}>
              {icons.discard}
            </ActionButton>
          )}
          <ActionButton
            label={isStaged ? t("git.unstage") : t("git.stage")}
            onClick={() => (isStaged ? unstagePaths([change.path]) : stagePaths([change.path]))}
          >
            {isStaged ? icons.minus : icons.plus}
          </ActionButton>
        </span>
        <span className={`git-status git-status-${statusKey}`} title={t(`git.status.${statusKey}` as "git.status.M")}>
          {letter}
        </span>
      </div>
    );
  }

  function renderGroup(section: Section, title: string, rows: Row[], bulk: { label: string; icon: ReactNode; run: () => void }) {
    if (rows.length === 0) return null;
    const isCollapsed = collapsed[section];
    const toggle = () => setCollapsed((c) => ({ ...c, [section]: !c[section] }));
    return (
      <div className="git-group">
        <div
          className="git-group-header"
          role="button"
          tabIndex={0}
          aria-expanded={!isCollapsed}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <span className={"git-chevron" + (isCollapsed ? "" : " is-open")}>{icons.chevron}</span>
          <span className="git-group-title">{title}</span>
          <span className="git-row-actions">
            {section === "changes" && (
              <ActionButton label={t("git.discard")} onClick={() => void discard(rows)}>
                {icons.discard}
              </ActionButton>
            )}
            <ActionButton label={bulk.label} onClick={bulk.run}>
              {bulk.icon}
            </ActionButton>
          </span>
          <span className="git-count">{rows.length}</span>
        </div>
        {!isCollapsed && rows.map((r) => renderRow(r, section))}
      </div>
    );
  }

  return (
    <div className="git-panel">
      <div className="git-header">
        <span className="git-branch" title={branchLabel}>
          {icons.branch}
          <span className="git-branch-name">{branchLabel}</span>
        </span>
        {(status.ahead > 0 || status.behind > 0) && (
          <span className="git-sync" title={t("git.aheadBehind", { ahead: status.ahead, behind: status.behind })}>
            {status.ahead > 0 && `↑${status.ahead}`}
            {status.ahead > 0 && status.behind > 0 && " "}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <span className="git-header-spacer" />
        <button type="button" className="git-icon-btn" title={t("git.refresh")} aria-label={t("git.refresh")} onClick={() => void refresh(true)}>
          {icons.refresh}
        </button>
      </div>

      <div className="git-commit-box">
        <textarea
          className="git-commit-input"
          value={message}
          rows={3}
          placeholder={t("git.commitPlaceholder")}
          spellCheck={false}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <button type="button" className="git-commit-btn" disabled={!canCommit} onClick={() => void commit()}>
          {committing ? t("git.committing") : hasStaged ? t("git.commit") : t("git.commitAll")}
        </button>
        {error && <div className="git-error">{error}</div>}
      </div>

      <div className="git-list">
        {total === 0 && <div className="git-none">{t("git.noChanges")}</div>}
        {renderGroup("conflicts", t("git.group.conflicts"), conflicts, {
          label: t("git.stageAll"),
          icon: icons.plus,
          run: () => stagePaths(conflicts.map((r) => r.change.path)),
        })}
        {renderGroup("staged", t("git.group.staged"), staged, {
          label: t("git.unstageAll"),
          icon: icons.minus,
          run: () => unstagePaths(staged.map((r) => r.change.path)),
        })}
        {renderGroup("changes", t("git.group.changes"), changes, {
          label: t("git.stageAll"),
          icon: icons.plus,
          run: () => stagePaths(changes.map((r) => r.change.path)),
        })}
      </div>
    </div>
  );
}

function ActionButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="git-icon-btn"
      title={label}
      aria-label={label}
      // The row/header behind it opens or collapses on click.
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}
