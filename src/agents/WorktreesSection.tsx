import { basename } from "../lib/path";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { useI18n } from "../i18n";
import { gitWorktreeRemove, type GitWorktree, type WorktreeRemoval } from "./git";
import { TerminalIcon } from "../app/icons";

interface WorktreesSectionProps {
  repoRoot: string;
  /** Every worktree of the repo - the main one is left out here. */
  worktrees: GitWorktree[];
  /** Running agents per worktree path. */
  agentCounts: Map<string, number>;
  /** Opens a plain terminal tab in the folder. */
  onOpenFolder: (path: string) => void;
  /** A removal was attempted (done or not) - the list needs re-reading. */
  onRemoved: () => void;
  /** Shown in the panel's banner. */
  onError: (message: string) => void;
}

/** The project's linked git worktrees, with a terminal shortcut and removal
 * for each. A worktree an agent still works in can't be removed from here. */
export function WorktreesSection({ repoRoot, worktrees, agentCounts, onOpenFolder, onRemoved, onError }: WorktreesSectionProps) {
  const { t } = useI18n();
  const confirm = useConfirmDialog();
  const linked = worktrees.filter((w) => !w.is_main);
  if (linked.length === 0) return null;

  async function remove(wt: GitWorktree) {
    const branch = wt.branch ?? basename(wt.path);
    try {
      const ok = await confirm({
        title: t("agents.worktree.removeConfirm.title"),
        message: t("agents.worktree.removeConfirm.message", { branch }),
        confirmLabel: t("agents.worktree.remove"),
        danger: true,
      });
      if (!ok) return;
      let removal: WorktreeRemoval;
      try {
        removal = await gitWorktreeRemove(repoRoot, wt.path, false);
      } catch (err) {
        const message = String(err);
        if (!message.includes("modified or untracked")) {
          onError(t("agents.worktree.removeFailed", { message }));
          return;
        }
        const force = await confirm({
          title: t("agents.worktree.forceConfirm.title"),
          message: t("agents.worktree.forceConfirm.message", { branch }),
          confirmLabel: t("agents.worktree.remove"),
          danger: true,
        });
        if (!force) return;
        removal = await gitWorktreeRemove(repoRoot, wt.path, true);
      }
      // Informational, but the banner is the panel's one message slot.
      if (removal.branch_kept) onError(t("agents.worktree.branchKept", { branch: removal.branch_kept }));
    } catch (err) {
      onError(t("agents.worktree.removeFailed", { message: String(err) }));
    } finally {
      onRemoved();
    }
  }

  return (
    <>
      <div className="agents-sidebar-section-label">{t("agents.section.worktrees")}</div>
      {linked.map((wt) => {
        const count = agentCounts.get(wt.path) ?? 0;
        const name = wt.branch ?? basename(wt.path);
        return (
          <div
            key={wt.path}
            className="agents-sidebar-row agents-sidebar-row--background"
            onDoubleClick={() => onOpenFolder(wt.path)}
            title={`${name}\n${wt.path}\n${t("agents.worktree.open")}`}
          >
            <span className="agents-sidebar-icon">
              <BranchIcon />
            </span>
            <div className="agents-sidebar-row-body">
              <span className="agents-sidebar-tab-label">{name}</span>
              <span className="agents-sidebar-path">
                <bdi>{wt.path}</bdi>
              </span>
            </div>
            <span className={`agents-sidebar-chip agents-sidebar-chip--${count > 0 ? "busy" : "idle"}`}>
              {count > 0 ? t("agents.worktree.agents", { count }) : t("agents.worktree.free")}
            </span>
            <button
              type="button"
              className="agents-sidebar-stop"
              title={t("agents.worktree.open")}
              aria-label={t("agents.worktree.open")}
              onClick={() => onOpenFolder(wt.path)}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <TerminalIcon size={13} />
            </button>
            <button
              type="button"
              className="agents-sidebar-stop"
              title={count > 0 ? t("agents.worktree.busy") : t("agents.worktree.remove")}
              aria-label={t("agents.worktree.remove")}
              disabled={count > 0}
              onClick={() => void remove(wt)}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <TrashIcon />
            </button>
          </div>
        );
      })}
    </>
  );
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="8" r="2" />
      <path d="M6 8v8" />
      <path d="M18 10a6 6 0 0 1-6 6H8" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 20 7" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}
