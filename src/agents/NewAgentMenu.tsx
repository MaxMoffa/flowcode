import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AGENT_CLIS, CLI_INFO, type AgentCli } from "./cliInfo";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import { readBool, usePersistentState, writeBool } from "../lib/storage";
import { useI18n } from "../i18n";
import { profileForPath, setProjectDefaultProfile, useProfiles } from "../profiles/profiles";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { activeTabProfile } from "../profiles/activeTabProfile";

const NEW_IN_WORKTREE_KEY = "flowcode.agentsNewInWorktree";
const CLI_STATUS_TTL_MS = 60_000;

/** Last `check_cli_status` answer per CLI for the default profile, shared by
 * every opening of the menu. Failed checks are not cached. */
const cliStatusCache = new Map<AgentCli, { at: number; ok: boolean }>();

/** Whether a CLI is installed and signed in under the default profile. A
 * failed check counts as available. */
function defaultProfileCliOk(cli: AgentCli): Promise<boolean> {
  const hit = cliStatusCache.get(cli);
  if (hit && Date.now() - hit.at < CLI_STATUS_TTL_MS) return Promise.resolve(hit.ok);
  return invoke<{ installed: boolean; logged_in: boolean }>("check_cli_status", { cli })
    .then((st) => {
      const ok = st.installed && st.logged_in;
      cliStatusCache.set(cli, { at: Date.now(), ok });
      return ok;
    })
    .catch(() => true);
}

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

  useEffect(() => {
    if (selected) return;
    let cancelled = false;
    void Promise.all(AGENT_CLIS.map((cli) => defaultProfileCliOk(cli).then((ok) => [cli, ok] as const))).then((entries) => {
      if (!cancelled) setDefaultOk(Object.fromEntries(entries) as Partial<Record<AgentCli, boolean>>);
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // An account profile lists the CLIs it is signed in to; the default profile
  // uses the checks above. A stored id that no longer exists launches on the
  // default profile, so it is filtered like the default one.
  const account = selected ? profiles.find((p) => p.id === selected) : undefined;
  const visibleClis = AGENT_CLIS.filter((cli) => (account ? account.logged_in[cli] === true : (defaultOk[cli] ?? true)));

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
            onLaunch(cli, inWorktree && worktreeAvailable, profiles.some((p) => p.id === selected) ? (selected ?? undefined) : undefined);
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
