import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatTab, TermTab } from "../tabs/types";
import { profileById, useProfiles, type ProfileInfo } from "../profiles/profiles";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import { readEnum, usePersistentState, writeString } from "../lib/storage";
import { t, useI18n } from "../i18n";
import type { AgentSession } from "./agentSessions";
import { gitRepoRoot, gitWorktreeAdd, gitWorktrees, isWorktreeCapable, type GitWorktree } from "./git";
import { inProject, keepIfSame } from "./agentScope";
import type { ClaudeAgentEntry, CodexSessionEntry, SavedSession, VibeSessionEntry } from "./entryTypes";
import { formatElapsed, relativeCommitTime } from "../lib/time";
import { useSecondTick } from "../lib/useSecondTick";
import { ChatIcon, TerminalIcon } from "../app/icons";
import { NewAgentMenu } from "./NewAgentMenu";
import { WorktreesSection } from "./WorktreesSection";
import { CLI_INFO } from "./cliInfo";
import { SegmentedSwitch } from "../lib/SegmentedSwitch";
import "./agents-sidebar.css";

const POLL_MS = 3000;
/** Saved Codex / Vibe sessions listed before "Show more". */
const SAVED_SESSIONS_SHOWN = 3;

const AGENTS_SCOPE_KEY = "flowcode.agentsScope";
/** Which agents the panel lists: those working in the active tab's folder, or all. */
type AgentsScope = "project" | "all";
const SCOPES = ["project", "all"] as const;

/** A live duration label: ticks on its own, so the rest of the sidebar isn't
 * re-rendered every second for it. */
function Elapsed({ since, ago }: { since: number; ago?: boolean }) {
  useSecondTick();
  return <>{ago ? relativeCommitTime(since / 1000) : formatElapsed(since)}</>;
}

interface AgentsSidebarProps {
  /** This window's label - agents in tabs of other windows are listed
   * separately, and double-clicking one brings that window forward. */
  windowLabel: string;
  tabs: TermTab[];
  /** The chat tabs of this window: agents hosted as a conversation, listed
   * with the running ones. */
  chatTabs: ChatTab[];
  activeTabId: string;
  /** The active terminal tab's folder - the "This project" scope lists the
   * agents working in it or below it. */
  projectCwd?: string;
  /** The new tab page is in front: `projectCwd` is the folder picked there, so
   * the "+" works, but it isn't a project to scope the list to. */
  newTabPage?: boolean;
  /** That tab's WSL distro, when it runs inside WSL. */
  projectWslDistro?: string;
  /** The agents running in Flowcode tabs - see `useAgentSessions`, polled
   * by App.tsx for the tab strip too. `null` until the first answer. */
  sessions: AgentSession[] | null;
  /** Polls `sessions` right away (the refresh button). */
  refreshSessions: () => Promise<void>;
  /** The backend pty session id behind a given tab, once its shell has
   * spawned - see TerminalHandle.getPtyId in terminal/Terminal.tsx. */
  getPtyId: (tabId: string) => string | null;
  onOpenTab: (tabId: string) => void;
  /** Opens a fresh terminal tab in `cwd` and resumes that session
   * (`claude --resume <sessionId>` / `codex resume <sessionId>` /
   * `vibe --resume <sessionId>`) - used for a background/saved session with
   * no local tab of its own to switch to. `profileId` is the account profile
   * that owns the session, so it resumes under the same account. */
  onOpenSession: (cwd: string, sessionId: string, cli: "claude" | "codex" | "vibe" | "gemini", wslDistro?: string, profileId?: string) => void;
  /** The shell id the active tab runs (see `tabShell` in App.tsx), so an
   * agent started in the project folder lands in the same kind of terminal. */
  projectShell?: string;
  /** Starts an agent in a NEW tab opened in `cwd` (the "+" menu). `shell` is
   * the shell to open it in - absent for a fresh worktree, which is on the
   * host file system. `profileId` is the account profile to run it under
   * (the default one when absent). */
  onLaunchAgent: (cli: "claude" | "codex" | "vibe" | "gemini", cwd: string, shell?: string, profileId?: string) => void;
  /** Opens a plain terminal tab in a folder (a worktree). */
  onOpenFolder: (cwd: string) => void;
  onClose: () => void;
}

/** Right-side panel, same size/structure as the left file explorer, listing
 * every terminal tab that currently has a recognized AI coding agent (Claude
 * Code, Codex CLI, Mistral Vibe) running in it - see src-tauri/src/agents.rs for how a tab
 * is matched to a running agent (its shell's own process tree, not anything
 * the agent CLI itself reports - there's no API for that). Double-clicking a
 * row switches to that tab. The header's scope selector narrows the list to the
 * active tab's folder ("this project", running agents only) or shows everything. */
function statusLabel(status: string): string {
  if (status === "busy") return t("agents.status.busy");
  if (status === "waiting") return t("agents.status.waiting");
  if (status === "idle") return t("agents.status.idle");
  return status;
}

/** Sends an interrupt keystroke (Esc - the same key both Claude Code's and
 * Codex's own TUI treat as "stop this turn") straight to a tab's pty. Only
 * ever offered for a *local* row (one this app's own pty_write can reach) -
 * a background/saved entry has no live pipe here to write to. */
function interruptPty(ptyId: string) {
  invoke("pty_write", { id: ptyId, data: "\x1b" }).catch(() => {});
}

/** Brings another window forward with the agent's tab selected. */
function focusOtherWindow(session: AgentSession) {
  if (!session.window || !session.tab_id) return;
  invoke("window_focus_tab", { label: session.window, tabId: session.tab_id }).catch(() => {});
}

export function AgentsSidebar({
  windowLabel,
  tabs,
  chatTabs,
  activeTabId,
  projectCwd,
  newTabPage,
  projectWslDistro,
  sessions,
  refreshSessions,
  getPtyId,
  onOpenTab,
  onOpenSession,
  projectShell,
  onLaunchAgent,
  onOpenFolder,
  onClose,
}: AgentsSidebarProps) {
  const { t } = useI18n();
  const profilesState = useProfiles();
  /** The profile with this id, for the badge on a row - none for the default. */
  const profileOf = (id: string | null | undefined) => profileById(profilesState, id);
  const [scope, setScope] = usePersistentState<AgentsScope>(AGENTS_SCOPE_KEY, (k) => readEnum(k, SCOPES, "all"), writeString);
  const [claudeAgents, setClaudeAgents] = useState<ClaudeAgentEntry[]>([]);
  const [codexSessions, setCodexSessions] = useState<CodexSessionEntry[]>([]);
  const [vibeSessions, setVibeSessions] = useState<VibeSessionEntry[]>([]);
  const [showAllSaved, setShowAllSaved] = useState(false);
  // The git repository the active tab's folder belongs to, and its worktrees.
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [worktrees, setWorktrees] = useState<GitWorktree[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  // The current poll's loader, for the header's refresh button.
  const loadRef = useRef<(fresh: boolean) => Promise<unknown>>(() => Promise.resolve());
  const refreshSessionsRef = useRef(refreshSessions);
  refreshSessionsRef.current = refreshSessions;

  // Bumped per repo lookup so a slow answer for a folder the tab has since
  // left is dropped.
  const repoRequestRef = useRef(0);
  const worktreeCapable = isWorktreeCapable(projectCwd, projectWslDistro);
  // The repo root only changes with the folder, so it is looked up once per
  // folder (a non-repo too); only the worktree list is re-read on every poll.
  const repoRootCacheRef = useRef<{ cwd: string; root: string | null } | null>(null);
  /** Re-reads the repository and worktrees of the active tab's folder. Any
   * failure (git missing, not a repo) just means "no repository". `fresh`
   * also looks the repository root up again. */
  async function loadRepo(fresh = false) {
    const request = ++repoRequestRef.current;
    let root: string | null = null;
    let list: GitWorktree[] = [];
    if (projectCwd && worktreeCapable) {
      const cache = repoRootCacheRef.current;
      if (cache?.cwd === projectCwd && !fresh) {
        root = cache.root;
      } else {
        try {
          root = await gitRepoRoot(projectCwd);
        } catch {
          root = null;
        }
        // Keyed by folder, so storing a late answer is still right - and a
        // slow git never gets stuck re-asking on every poll.
        repoRootCacheRef.current = { cwd: projectCwd, root };
      }
      if (root) {
        try {
          list = await gitWorktrees(root);
        } catch {
          root = null;
          list = [];
        }
      }
    } else {
      repoRootCacheRef.current = null;
    }
    if (request !== repoRequestRef.current) return;
    setRepoRoot(root);
    setWorktrees((prev) => (JSON.stringify(prev) === JSON.stringify(list) ? prev : list));
  }
  const loadRepoRef = useRef(loadRepo);
  loadRepoRef.current = loadRepo;

  useEffect(() => {
    void loadRepoRef.current();
  }, [projectCwd, projectWslDistro]);

  const loadSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // `fresh`: also re-read what's normally cached between polls (the WSL
    // saved-sessions folder) - asked for by the refresh button.
    function load(fresh = false) {
      // A slower, older load must not overwrite what a newer one stored.
      const seq = ++loadSeqRef.current;
      const current = () => !cancelled && seq === loadSeqRef.current;
      return Promise.allSettled([
        loadRepoRef.current(fresh),
        // Polled on its own by App.tsx - only asked again here when the
        // refresh button wants everything re-read now.
        ...(fresh ? [refreshSessionsRef.current()] : []),
        // Not installed / not on PATH / old version without this subcommand
        // all resolve to the same empty list on the Rust side already - a
        // rejection here is only a genuinely unexpected failure, so just keep
        // whatever was last known instead of flashing the list empty.
        invoke<ClaudeAgentEntry[]>("list_claude_agents")
          .then((result) => {
            if (current()) setClaudeAgents((prev) => keepIfSame(prev, result));
          })
          .catch(() => {}),
        invoke<CodexSessionEntry[]>("list_codex_sessions", { fresh })
          .then((result) => {
            if (current()) setCodexSessions((prev) => keepIfSame(prev, result));
          })
          .catch(() => {}),
        invoke<VibeSessionEntry[]>("list_vibe_sessions", { fresh })
          .then((result) => {
            if (current()) setVibeSessions((prev) => keepIfSame(prev, result));
          })
          .catch(() => {}),
      ]);
    }
    loadRef.current = load;
    load();
    // Each poll refreshes the whole process table and spawns `claude agents`
    // - not worth doing while the window is minimized/hidden.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  const localRows = (sessions ?? [])
    .map((session) => ({ session, tab: tabs.find((t) => getPtyId(t.id) === session.pty_id) }))
    .filter((row): row is { session: AgentSession; tab: TermTab } => row.tab !== undefined);
  // Chat tabs have no process to poll: the tab itself reports the status. A
  // closed one (`exited`) has nothing running to list.
  const chatRows = chatTabs.filter((tab) => tab.status !== "exited");
  // Agents in tabs of the other Flowcode windows.
  const otherWindowRows = (sessions ?? []).filter(
    (session) => session.window !== null && session.window !== windowLabel && session.tab_id !== null,
  );
  const allRunning = sessions ?? [];

  // A Claude session already shown above (it's running in one of this app's
  // tabs, in any window) is matched by pid and folded into that row's status
  // instead of being listed a second time - only genuinely background
  // sessions (no tab claims that pid) get their own row. `claude agents`
  // only knows Windows-side sessions, so a WSL one (a Linux pid) never
  // matches here.
  const runningClaudePids = new Set(allRunning.filter((s) => s.cli === "claude" && !s.wsl_distro).map((s) => s.pid));
  const backgroundClaudeAgents = claudeAgents.filter((a) => !runningClaudePids.has(a.pid));

  // Same idea for Codex, one level cruder: with no pid to match on (see
  // CodexSessionEntry above), a saved session is folded out whenever a
  // Codex already running in a tab works in that exact folder, rather than
  // shown as a second, redundant "resume" entry for the thing already
  // running.
  const runningCwds = (cli: string) =>
    new Set(allRunning.filter((s) => s.cli === cli).flatMap((s) => [s.cwd, s.tab_cwd].filter((c): c is string => !!c)));
  const runningCodexCwds = runningCwds("codex");
  const runningVibeCwds = runningCwds("vibe");
  const runningSessionIds = new Set(allRunning.map((s) => s.session_id).filter((id): id is string => !!id));
  // Codex threads open right now in a terminal this app doesn't show (another
  // Flowcode, another terminal app) - running, not merely saved.
  const liveCodexElsewhere = codexSessions.filter((s) => s.live && !runningSessionIds.has(s.sessionId));
  const savedSessions: SavedSession[] = [
    ...codexSessions
      .filter((s) => !s.live && !runningCodexCwds.has(s.cwd))
      .map((s): SavedSession => ({ cli: "codex", cwd: s.cwd, sessionId: s.sessionId, startedAt: s.startedAt, wslDistro: s.wslDistro, name: s.name, profile: s.profile })),
    ...vibeSessions
      .filter((s) => !runningVibeCwds.has(s.cwd) && !runningSessionIds.has(s.sessionId))
      .map((s): SavedSession => ({ cli: "vibe", ...s })),
  ].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));

  // The "This project" scope: only what's running in the active tab's folder
  // (or below it) - saved sessions are left out. Folding above stays on the
  // unfiltered lists; only what's rendered is narrowed.
  // Without a project in front there's nothing to narrow to: show everything,
  // but keep the saved choice for when a terminal is back in front.
  const projectScope = scope === "project" && !!projectCwd && !newTabPage;
  // Every worktree of the repo counts as the project (the repo root too, even
  // when the active tab sits in a subfolder of it).
  const projectRoots = repoRoot
    ? worktrees.length > 0
      ? worktrees.map((w) => w.path)
      : [repoRoot]
    : projectCwd
      ? [projectCwd]
      : [];
  const inActiveProject = (cwd: string | null | undefined, wslDistro: string | null | undefined) =>
    projectRoots.some((root) => inProject(cwd, wslDistro, root, projectWslDistro));
  /** The linked worktree a folder is in, if any. */
  const worktreeOf = (cwd: string | null | undefined): GitWorktree | undefined =>
    cwd ? worktrees.find((w) => !w.is_main && inProject(cwd, null, w.path, undefined)) : undefined;
  /** `meta` plus the branch, for an agent working in a linked worktree. */
  const withBranch = (meta: ReactNode, cwd: string | null | undefined): ReactNode => {
    const branch = worktreeOf(cwd)?.branch;
    return branch ? (
      <>
        {meta}
        {` \u00b7 \u2387 ${branch}`}
      </>
    ) : (
      meta
    );
  };
  // Running agents per linked worktree, whichever window or terminal they run in.
  const agentCounts = new Map<string, number>();
  if (repoRoot) {
    const countAgent = (cwd: string | null | undefined) => {
      const wt = worktreeOf(cwd);
      if (wt) agentCounts.set(wt.path, (agentCounts.get(wt.path) ?? 0) + 1);
    };
    localRows.forEach(({ session, tab }) => countAgent(session.cwd ?? session.tab_cwd ?? tab.cwd));
    chatRows.forEach((tab) => countAgent(tab.cwd));
    otherWindowRows.forEach((s) => countAgent(s.cwd ?? s.tab_cwd));
    backgroundClaudeAgents.forEach((a) => countAgent(a.cwd));
    liveCodexElsewhere.forEach((s) => countAgent(s.cwd));
  }
  const projectName = projectCwd ? basename(repoRoot ?? projectCwd) : "";
  const projectLocalRows = localRows.filter(
    ({ session, tab }) =>
      inActiveProject(session.cwd, session.wsl_distro) || inActiveProject(session.tab_cwd ?? tab.cwd, session.wsl_distro),
  );
  const projectChatRows = chatRows.filter((tab) => inActiveProject(tab.cwd, null));
  const projectOtherWindowRows = otherWindowRows.filter(
    (s) => inActiveProject(s.cwd, s.wsl_distro) || inActiveProject(s.tab_cwd, s.wsl_distro),
  );
  const projectBackgroundClaudeAgents = backgroundClaudeAgents.filter((a) => inActiveProject(a.cwd, null));
  const projectLiveCodexElsewhere = liveCodexElsewhere.filter((s) => inActiveProject(s.cwd, s.wslDistro));
  const projectCount =
    projectLocalRows.length +
    projectChatRows.length +
    projectOtherWindowRows.length +
    projectBackgroundClaudeAgents.length +
    projectLiveCodexElsewhere.length;
  const allCount = localRows.length + chatRows.length + otherWindowRows.length + backgroundClaudeAgents.length + liveCodexElsewhere.length;

  const shownLocalRows = projectScope ? projectLocalRows : localRows;
  const shownChatRows = projectScope ? projectChatRows : chatRows;
  const shownOtherWindowRows = projectScope ? projectOtherWindowRows : otherWindowRows;
  const shownBackgroundClaudeAgents = projectScope ? projectBackgroundClaudeAgents : backgroundClaudeAgents;
  const shownLiveCodexElsewhere = projectScope ? projectLiveCodexElsewhere : liveCodexElsewhere;
  const listedSavedSessions = projectScope ? [] : savedSessions;

  // Saved sessions are only a way back into an old chat: the latest few are
  // shown, the rest one click away, so they never crowd out what's running.
  const shownSavedSessions = showAllSaved ? listedSavedSessions : listedSavedSessions.slice(0, SAVED_SESSIONS_SHOWN);

  const loading = sessions === null;
  const isEmpty =
    !loading &&
    shownLocalRows.length === 0 &&
    shownChatRows.length === 0 &&
    shownOtherWindowRows.length === 0 &&
    shownBackgroundClaudeAgents.length === 0 &&
    shownLiveCodexElsewhere.length === 0 &&
    listedSavedSessions.length === 0;
  const emptyMessage = !projectScope
    ? t("agents.empty")
    : projectCwd
      ? t("agents.scope.emptyProject", { folder: projectName })
      : t("agents.scope.noProject");

  /** Name, folder and chip of an agent running in a tab (this window's or
   * another's): the session's own name when it's known (see `AgentSession`
   * and `claude agents`), else the folder it works in. */
  function describeRunning(session: AgentSession, fallbackCwd: string | null) {
    const claudeInfo =
      session.cli === "claude" && !session.wsl_distro ? claudeAgents.find((a) => a.pid === session.pid) : undefined;
    const cwd = session.cwd ?? claudeInfo?.cwd ?? fallbackCwd ?? "";
    const status = session.status ?? claudeInfo?.status;
    return {
      name: session.session_name || claudeInfo?.name || basename(cwd) || session.cli_label,
      cwd,
      chip: status
        ? { kind: status === "busy" || status === "waiting" ? status : "idle", label: statusLabel(status) }
        : { kind: "running", label: t("agents.status.running") },
    };
  }

  const stopButton = (ptyId: string) => (
    <button
      type="button"
      className="agents-sidebar-stop"
      title={t("agents.interrupt")}
      onClick={(e) => {
        e.stopPropagation();
        interruptPty(ptyId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <StopIcon />
    </button>
  );

  /** Starts `cli` in the project folder, or in a fresh worktree of its repo. */
  async function launch(cli: "claude" | "codex" | "vibe" | "gemini", inWorktree: boolean, profileId?: string) {
    if (!projectCwd) return;
    if (!inWorktree || !repoRoot) {
      onLaunchAgent(cli, projectCwd, projectShell, profileId);
      return;
    }
    setCreating(true);
    try {
      const wt = await gitWorktreeAdd(repoRoot, cli);
      onLaunchAgent(cli, wt.path, undefined, profileId);
      void loadRepo();
    } catch (err) {
      setError(t("agents.worktree.addFailed", { message: String(err) }));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="agents-sidebar">
      <div className="agents-sidebar-head">
      <div className="agents-sidebar-header">
        <button type="button" className="agents-sidebar-close" title={t("agents.closePanel")} aria-label={t("agents.closePanel")} onClick={onClose}>
          <CloseIcon />
        </button>
        <span className="agents-sidebar-title">{t("agents.title")}</span>
        {projectCwd && (
          <button
            type="button"
            className="agents-sidebar-close agents-sidebar-add"
            title={t("agents.new.title")}
            aria-label={t("agents.new.title")}
            disabled={creating}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <PlusIcon />
          </button>
        )}
        <button
          type="button"
          className={"agents-sidebar-close agents-sidebar-refresh" + (refreshing ? " is-refreshing" : "")}
          title={t("agents.refresh")}
          aria-label={t("agents.refresh")}
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void loadRef.current(true).finally(() => setRefreshing(false));
          }}
        >
          <RefreshIcon />
        </button>
        {menuOpen && projectCwd && (
          <NewAgentMenu
            projectCwd={projectCwd}
            repoRoot={repoRoot}
            worktreeCapable={worktreeCapable}
            onLaunch={(cli, inWorktree, profileId) => void launch(cli, inWorktree, profileId)}
            onClose={() => setMenuOpen(false)}
          />
        )}
      </div>
      {projectCwd && !newTabPage && (
        <SegmentedSwitch
          options={[
            { id: "project", label: projectName || t("agents.scope.project"), title: repoRoot ?? projectCwd ?? t("agents.scope.noProject"), count: projectCount },
            { id: "all", label: t("agents.scope.all"), count: allCount },
          ]}
          value={scope}
          onChange={setScope}
          ariaLabel={t("agents.scope.label")}
        />
      )}
      </div>
      <div className="agents-sidebar-list">
        {error && (
          <div className="agents-sidebar-error" role="alert">
            <span className="agents-sidebar-error-text">{error}</span>
            <button type="button" className="agents-sidebar-error-close" aria-label={t("agents.closePanel")} onClick={() => setError(null)}>
              <CloseIcon />
            </button>
          </div>
        )}
        {loading && <div className="agents-sidebar-empty">{t("common.checking")}</div>}
        {isEmpty && <div className="agents-sidebar-empty">{emptyMessage}</div>}
        {shownLocalRows.map(({ session, tab }) => {
          const { name, cwd, chip } = describeRunning(session, tab.cwd);
          return (
            <AgentRow
              key={session.pty_id}
              cli={session.cli}
              name={name}
              cwd={cwd}
              terminal={tab.label}
              meta={withBranch(runningMeta(session), cwd)}
              profile={profileOf(session.profile)}
              chip={chip}
              active={tab.id === activeTabId}
              hint={t("agents.hint.openTab")}
              onOpen={() => onOpenTab(tab.id)}
              action={stopButton(session.pty_id)}
            />
          );
        })}
        {shownChatRows.map((tab) => {
          const status = tab.status ?? "starting";
          return (
            <AgentRow
              key={tab.id}
              cli={tab.agent}
              name={tab.label}
              cwd={tab.cwd}
              terminal={CLI_INFO[tab.agent].label}
              chat
              meta={null}
              profile={profileOf(tab.profileId)}
              chip={{ kind: status === "busy" || status === "waiting" ? status : "idle", label: statusLabel(status === "starting" ? "idle" : status) }}
              active={tab.id === activeTabId}
              hint={t("agents.hint.openTab")}
              onOpen={() => onOpenTab(tab.id)}
            />
          );
        })}
        {shownOtherWindowRows.length > 0 && <div className="agents-sidebar-section-label">{t("agents.section.otherWindows")}</div>}
        {shownOtherWindowRows.map((session) => {
          const { name, cwd, chip } = describeRunning(session, session.tab_cwd);
          return (
            <AgentRow
              key={session.pty_id}
              cli={session.cli}
              name={name}
              cwd={cwd}
              terminal={session.tab_label ?? ""}
              otherWindow
              meta={withBranch(runningMeta(session), cwd)}
              profile={profileOf(session.profile)}
              chip={chip}
              hint={t("agents.hint.otherWindow")}
              onOpen={() => focusOtherWindow(session)}
              action={stopButton(session.pty_id)}
            />
          );
        })}
        {(shownBackgroundClaudeAgents.length > 0 || shownLiveCodexElsewhere.length > 0) && (
          <div className="agents-sidebar-section-label">{t("agents.section.background")}</div>
        )}
        {shownLiveCodexElsewhere.map((s) => (
          <AgentRow
            key={s.sessionId}
            background
            cli="codex"
            name={s.name || basename(s.cwd)}
            cwd={s.cwd}
            terminal={s.inFlowcode ? t("agents.otherFlowcode") : t("agents.otherTerminal")}
            meta={`Codex CLI${s.wslDistro ? " · WSL" : ""}`}
            profile={profileOf(s.profile)}
            chip={{ kind: s.status === "busy" ? "busy" : "idle", label: statusLabel(s.status ?? "idle") }}
            hint={t("agents.hint.runningElsewhere")}
            // Already open there - resuming it here too would put two
            // terminals on one thread.
            onOpen={() => {}}
          />
        ))}
        {shownBackgroundClaudeAgents.map((agent) => (
          <AgentRow
            key={agent.sessionId}
            background
            cli="claude"
            name={agent.name || basename(agent.cwd)}
            cwd={agent.cwd}
            terminal={agent.hostApp ?? t("agents.otherTerminal")}
            meta={
              <>
                {CLI_INFO.claude.label}
                {agent.startedAt !== null && (
                  <>
                    {" · "}
                    <Elapsed since={agent.startedAt} />
                  </>
                )}
              </>
            }
            profile={profileOf(agent.profile)}
            chip={{ kind: agent.status === "busy" ? "busy" : "idle", label: statusLabel(agent.status) }}
            hint={t("agents.hint.outsideFlowcode")}
            onOpen={() => onOpenSession(agent.cwd, agent.sessionId, "claude", undefined, agent.profile ?? undefined)}
          />
        ))}
        {listedSavedSessions.length > 0 && <div className="agents-sidebar-section-label">{t("agents.section.saved")}</div>}
        {shownSavedSessions.map((s) => (
          <AgentRow
            key={`${s.cli}:${s.sessionId}`}
            background
            cli={s.cli}
            name={s.name || basename(s.cwd)}
            cwd={s.cwd}
            meta={
              <>
                {s.cli === "vibe" ? "Mistral Vibe" : "Codex CLI"}
                {s.wslDistro ? " · WSL" : ""}
                {s.startedAt !== null && (
                  <>
                    {" · "}
                    <Elapsed since={s.startedAt} ago />
                  </>
                )}
              </>
            }
            profile={profileOf(s.profile)}
            chip={{ kind: "saved", label: t("agents.status.saved") }}
            hint={t("agents.hint.resume")}
            onOpen={() => onOpenSession(s.cwd, s.sessionId, s.cli, s.wslDistro ?? undefined, s.profile ?? undefined)}
          />
        ))}
        {listedSavedSessions.length > SAVED_SESSIONS_SHOWN && (
          <button type="button" className="agents-sidebar-more" onClick={() => setShowAllSaved((v) => !v)}>
            {showAllSaved
              ? t("agents.showLess")
              : t("agents.showMore", { count: listedSavedSessions.length - SAVED_SESSIONS_SHOWN })}
          </button>
        )}
        {projectScope && repoRoot && (
          <WorktreesSection
            repoRoot={repoRoot}
            worktrees={worktrees}
            agentCounts={agentCounts}
            onOpenFolder={onOpenFolder}
            onRemoved={() => void loadRepo()}
            onError={setError}
          />
        )}
      </div>
    </div>
  );
}

interface AgentRowProps {
  cli: string;
  /** The session's name - or its folder, when it has none. */
  name: string;
  /** Where the agent works (a Linux path for one inside WSL). */
  cwd: string;
  /** The tab it runs in - absent for a session no Flowcode tab runs. */
  terminal?: string;
  /** That tab is in another Flowcode window. */
  otherWindow?: boolean;
  /** The agent is a chat tab, not a terminal one. */
  chat?: boolean;
  /** CLI, WSL, how long - the small print after the terminal. */
  meta: ReactNode;
  /** The account profile it runs under - absent for the default one. */
  profile?: ProfileInfo;
  chip: { kind: string; label: string };
  active?: boolean;
  background?: boolean;
  /** What a double-click does, for the tooltip. */
  hint: string;
  onOpen: () => void;
  action?: ReactNode;
}

/** One agent: its session name, the folder it works in, and which terminal
 * it runs in. */
function AgentRow({ cli, name, cwd, terminal, otherWindow, chat, meta, profile, chip, active, background, hint, onOpen, action }: AgentRowProps) {
  const { t } = useI18n();
  return (
    <div
      className={
        "agents-sidebar-row" + (active ? " is-active" : "") + (background ? " agents-sidebar-row--background" : "")
      }
      onDoubleClick={onOpen}
      title={`${name}\n${cwd}\n${hint}`}
    >
      <span className="agents-sidebar-icon">
        {agentCliIcon(cli)}
        {profile && <span className="agents-sidebar-profile-dot" style={{ background: profile.color }} />}
      </span>
      <div className="agents-sidebar-row-body">
        <span className="agents-sidebar-tab-label">{name}</span>
        {cwd && (
          // Right-to-left so a long path is cut at its start, keeping the
          // folder names that tell projects apart; the inner span keeps the
          // path itself reading left to right.
          <span className="agents-sidebar-path">
            <bdi>{cwd}</bdi>
          </span>
        )}
        <span className="agents-sidebar-meta">
          {terminal !== undefined && (
            <span
              className="agents-sidebar-terminal"
              title={otherWindow ? t("agents.tabOtherWindow") : t("agents.tabHere")}
            >
              {otherWindow ? <WindowIcon /> : chat ? <ChatIcon size={11} /> : <TerminalIcon size={11} />}
              <span className="agents-sidebar-terminal-label">{terminal}</span>
            </span>
          )}
          <span className="agents-sidebar-meta-text">{profile ? <>{meta} · {profile.name}</> : meta}</span>
        </span>
      </div>
      <StatusChip kind={chip.kind} label={chip.label} />
      {action}
    </div>
  );
}

/** "Codex CLI · WSL · 5 min" - the CLI, where it runs, and for how long. */
function runningMeta(session: AgentSession): ReactNode {
  return (
    <>
      {session.cli_label}
      {session.wsl_distro ? " · WSL" : ""}
      {session.started_at !== null && (
        <>
          {" · "}
          <Elapsed since={session.started_at} />
        </>
      )}
    </>
  );
}

function StatusChip({ kind, label }: { kind: string; label: string }) {
  return <span className={`agents-sidebar-chip agents-sidebar-chip--${kind}`}>{label}</span>;
}

function WindowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="7" width="14" height="12" rx="2" />
      <path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <polyline points="20 4 20 11 13 11" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="5" y1="5" x2="19" y2="19" />
      <line x1="19" y1="5" x2="5" y2="19" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
