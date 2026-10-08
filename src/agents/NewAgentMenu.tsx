import { useEffect, useRef, useState } from "react";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import { readBool, usePersistentState, writeBool } from "../lib/storage";
import { useI18n } from "../i18n";
import { profileForPath, setProjectDefaultProfile, useProfiles } from "../profiles/profiles";

const NEW_IN_WORKTREE_KEY = "flowcode.agentsNewInWorktree";

const AGENTS = [
  { cli: "claude", label: "Claude Code" },
  { cli: "codex", label: "Codex CLI" },
  { cli: "vibe", label: "Mistral Vibe" },
] as const;

interface NewAgentMenuProps {
  /** The active tab's folder. */
  projectCwd: string;
  /** The git repository's root, when the folder is in one. */
  repoRoot: string | null;
  /** Worktrees can be created for this folder (see `isWorktreeCapable`). */
  worktreeCapable: boolean;
  /** `inWorktree`: start in a fresh worktree rather than the project folder.
   * `profileId`: the account profile picked (absent = the default one). */
  onLaunch: (cli: "claude" | "codex" | "vibe", inWorktree: boolean, profileId?: string) => void;
  onClose: () => void;
}

/** Popover under the Agents panel's "+" button: pick which agent to start in
 * a new tab of the project, optionally in a fresh git worktree. Positioned
 * against the panel header; closes on an outside click or Escape. */
export function NewAgentMenu({ projectCwd, repoRoot, worktreeCapable, onLaunch, onClose }: NewAgentMenuProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [inWorktree, setInWorktree] = usePersistentState(NEW_IN_WORKTREE_KEY, (k) => readBool(k, false), writeBool);
  const worktreeAvailable = !!repoRoot && worktreeCapable;
  const { profiles } = useProfiles();
  const projectPath = repoRoot ?? projectCwd;
  // The profile the project is set to use (null = the default one), and the
  // one picked here - starts on the former, once it has been read.
  const [projectDefault, setProjectDefault] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void profileForPath(projectPath).then((id) => {
      if (cancelled) return;
      setProjectDefault(id);
      setSelected(id);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Element;
      // The "+" button toggles the menu itself - closing here too would
      // make its click reopen what this just closed.
      if (target.closest(".agents-sidebar-add")) return;
      if (ref.current && !ref.current.contains(target)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="agents-new-menu" ref={ref} role="menu">
      <div className="agents-new-menu-caption">{basename(repoRoot ?? projectCwd)}</div>
      {profiles.length > 0 && (
        <div className="agents-new-menu-profiles" role="radiogroup" aria-label={t("agents.profile.label")}>
          <div className="agents-new-menu-caption">{t("agents.profile.label")}</div>
          <button
            type="button"
            role="radio"
            aria-checked={selected === null}
            className={"agents-new-menu-profile" + (selected === null ? " is-selected" : "")}
            onClick={() => setSelected(null)}
          >
            <span>{t("agents.profile.default")}</span>
          </button>
          {profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={selected === p.id}
              className={"agents-new-menu-profile" + (selected === p.id ? " is-selected" : "")}
              onClick={() => setSelected(p.id)}
            >
              <span className="agents-new-menu-profile-dot" style={{ background: p.color }} />
              <span>{p.name}</span>
            </button>
          ))}
          <label className="agents-new-menu-option">
            <input
              type="checkbox"
              checked={selected === projectDefault}
              onChange={(e) => {
                const next = e.target.checked ? selected : null;
                setProjectDefault(next);
                void setProjectDefaultProfile(projectPath, next);
              }}
            />
            <span>{t("agents.profile.rememberForProject")}</span>
          </label>
        </div>
      )}
      {AGENTS.map(({ cli, label }) => (
        <button
          key={cli}
          type="button"
          role="menuitem"
          className="agents-new-menu-item"
          onClick={() => {
            onLaunch(cli, inWorktree && worktreeAvailable, profiles.some((p) => p.id === selected) ? (selected ?? undefined) : undefined);
            onClose();
          }}
        >
          {agentCliIcon(cli)}
          <span>{label}</span>
        </button>
      ))}
      <label
        className={"agents-new-menu-option" + (worktreeAvailable ? "" : " is-disabled")}
        title={worktreeAvailable ? undefined : t("agents.new.worktreeUnavailable")}
      >
        <input
          type="checkbox"
          checked={inWorktree && worktreeAvailable}
          disabled={!worktreeAvailable}
          onChange={(e) => setInWorktree(e.target.checked)}
        />
        <span>{t("agents.new.worktree")}</span>
      </label>
    </div>
  );
}
