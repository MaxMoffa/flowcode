import { useEffect, useRef, useState } from "react";
import { AGENT_CLIS, CLI_INFO, defaultCliStatus, type AgentCli } from "./cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import { readBool, usePersistentState, writeBool } from "../lib/storage";
import { useI18n } from "../i18n";
import { profileForPath, setProjectDefaultProfile, useProfiles } from "../profiles/profiles";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { activeTabProfile } from "../profiles/activeTabProfile";
import { useOutsideClose } from "../hooks/useOutsideClose";

const NEW_IN_WORKTREE_KEY = "flowcode.agentsNewInWorktree";

/** Whether a CLI is installed and signed in under the default profile. A
 * failed check counts as available. */
const defaultProfileCliOk = (cli: AgentCli): Promise<boolean> =>
  defaultCliStatus(cli).then((st) => (st ? st.installed && st.logged_in : true));

interface NewAgentMenuProps {
  /** The active tab's folder. */
  projectCwd: string;
  /** The git repository's root, when the folder is in one. */
  repoRoot: string | null;
  /** Worktrees can be created for this folder (see `isWorktreeCapable`). */
  worktreeCapable: boolean;
  /** `inWorktree`: start in a fresh worktree rather than the project folder.
   * `profileId`: the account profile picked (absent = the default one). */
  onLaunch: (cli: AgentCli, inWorktree: boolean, profileId?: string) => void;
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
  // one picked here - starts on the active tab's profile.
  const [projectDefault, setProjectDefault] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(() => activeTabProfile.get().profileId ?? null);
  // Which CLIs are signed in under the default profile; empty until checked
  // (then every CLI is shown).
  const [defaultOk, setDefaultOk] = useState<Partial<Record<AgentCli, boolean>>>({});

  useEffect(() => {
    let cancelled = false;
    void profileForPath(projectPath).then((id) => {
      if (cancelled) return;
      setProjectDefault(id);
    });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  // An account profile lists the CLIs it is signed in to; the default profile
  // uses the checks below. A stored id that no longer exists launches on the
  // default profile, so it is filtered like the default one.
  const account = selected ? profiles.find((p) => p.id === selected) : undefined;

  useEffect(() => {
    if (account) return;
    let cancelled = false;
    void Promise.all(AGENT_CLIS.map((cli) => defaultProfileCliOk(cli).then((ok) => [cli, ok] as const))).then((entries) => {
      if (!cancelled) setDefaultOk(Object.fromEntries(entries) as Partial<Record<AgentCli, boolean>>);
    });
    return () => {
      cancelled = true;
    };
  }, [!account]);

  const visibleClis = AGENT_CLIS.filter((cli) => (account ? account.logged_in[cli] === true : (defaultOk[cli] ?? true)));

  useOutsideClose(true, [ref], onClose, {
    escape: true,
    // The "+" button toggles the menu itself - closing here too would make its
    // click reopen what this just closed. The profile list is portaled out of the menu.
    ignore: (target) => !!target.closest(".agents-sidebar-add, [data-profile-select-menu]"),
  });

  return (
    <div className="agents-new-menu" ref={ref} role="menu">
      <div className="agents-new-menu-head">
        <div className="agents-new-menu-caption">{basename(repoRoot ?? projectCwd)}</div>
        <ProfileSelect
          value={selected ?? undefined}
          onChange={(id) => setSelected(id ?? null)}
          isStarred={(id) => projectDefault === (id ?? null)}
          footer={
            selected !== projectDefault && (
              <button
                type="button"
                className="agents-new-menu-set-default"
                onClick={() => {
                  setProjectDefault(selected);
                  void setProjectDefaultProfile(projectPath, selected);
                }}
              >
                ☆ {t("agents.profile.rememberForProject")}
              </button>
            )
          }
        />
      </div>
      {visibleClis.length === 0 && <div className="agents-new-menu-empty">{t("agents.new.noAgents")}</div>}
      {visibleClis.map((cli) => (
        <button
          key={cli}
          type="button"
          role="menuitem"
          className="agents-new-menu-item"
          onClick={() => {
            onLaunch(cli, inWorktree && worktreeAvailable, account ? selected ?? undefined : undefined);
            onClose();
          }}
        >
          {agentCliIcon(cli)}
          <span>{CLI_INFO[cli].label}</span>
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
