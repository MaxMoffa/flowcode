import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatTab, TermTab } from "../tabs/types";
import type { AgentSession } from "./agentSessions";
import { isWorktreeCapable } from "./git";
import { inProject } from "./agentScope";
import { cachedRepo, refreshClaude, refreshGlobalAgent, resolveRepo, useHistoryStore, type RepoInfo } from "./historyStore";
import { buildHistoryRows, type HistoryRow, type OpenSession } from "./historyRows";
import { AGENT_CLIS, type AgentCli } from "./cliInfo";
import { useAvailableClis } from "./useAvailableClis";
import { useProfiles } from "../profiles/profiles";
import { childKeys, forgetDelegates, useDelegateHistory, type DelegateChild } from "./delegateHistory";
import { useAllTabDelegations } from "../chat/delegateStore";
import type { DelegateInfo } from "../chat/chatModel";
import type { ClaudeSessionEntry } from "./entryTypes";
import { getHiddenRows, hideRows, historyDeleteSessions, historySessionPath, unhideRows, useHiddenRows, type HistoryItem } from "./historyDelete";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { loadHistoryTitles, renameHistoryChat, useHistoryTitles } from "./historyTitles";
import { HistoryView, type DeleteEntry, type HiddenRowsStore } from "./HistoryView";

const POLL_MS = 5000;
/** How long the first Claude scan waits for the repo's worktrees before going ahead with the folder alone. */
const ROOTS_WAIT_MS = 300;
const EMPTY_CLAUDE: ClaudeSessionEntry[] = [];

interface AgentHistoryPanelProps {
  /** The active agent tab's folder. */
  projectCwd: string;
  /** Its WSL distro, when the agent runs inside WSL. */
  wslDistro?: string;
  /** The session the active tab shows - highlighted. */
  currentSessionId?: string;
  /** The active tab's agent, for "New session". */
  currentCli: AgentCli;
  /** The History tab is showing: polling only runs then. */
  visible: boolean;
  /** The agents running in Flowcode terminals - see `useAgentSessions`. */
  sessions: AgentSession[] | null;
  tabs: TermTab[];
  chatTabs: ChatTab[];
  /** The open tabs of delegated children (not among `chatTabs`): a child still running is opened by its task. */
  delegateTabs: ChatTab[];
  getPtyId: (tabId: string) => string | null;
  /** `sessionId`: the conversation to show, when the tab holds several. */
  onOpenTab: (tabId: string, sessionId?: string) => void;
  onResume: (cwd: string, sessionId: string, cli: AgentCli, wslDistro?: string, profileId?: string, lastActiveAt?: number) => void;
  /** Opens a delegated child's live chat next to its orchestrator's tab (what the task cards do). */
  onOpenDelegate?: (parentTabId: string, delegate: DelegateInfo, wslDistro: string | null) => void;
  /** `profileId`: the account profile the session runs under (`undefined` = default). */
  onNewSession: (cli: AgentCli, cwd: string, profileId: string | undefined) => void;
  /** The active tab's profile: where the "New session" menu starts. */
  currentProfileId?: string;
}

const isAgentCli = (cli: string): cli is AgentCli => (AGENT_CLIS as readonly string[]).includes(cli);

const GLOBAL_AGENTS = ["codex", "vibe", "opencode", "cline"] as const;

const LOCAL_HIDDEN: HiddenRowsStore = { use: useHiddenRows, get: getHiddenRows, hide: hideRows, unhide: unhideRows };
const localKey = (cli: string, sessionId: string) => `${cli}:${sessionId}`;

/** Deletes on this PC for good; resolves with the session ids that could not be. */
async function deleteItems(items: HistoryItem[]): Promise<Set<string>> {
  const res = await historyDeleteSessions(items);
  return new Set(res.failed.map((f) => f.sessionId));
}

const revealItem = (item: HistoryItem) => historySessionPath(item).then((path) => revealItemInDir(path));

/** The sessions of the project the active agent tab works in - saved ones
 * from disk plus those open in a tab - newest first, grouped by day. */
export function AgentHistoryPanel({
  projectCwd,
  wslDistro,
  currentSessionId,
  currentCli,
  visible,
  sessions,
  tabs,
  chatTabs,
  delegateTabs,
  getPtyId,
  onOpenTab,
  onResume,
  onOpenDelegate,
  onNewSession,
  currentProfileId,
}: AgentHistoryPanelProps) {
  const { profiles } = useProfiles();
  const [profileId, setProfileId] = useState<string | undefined>(currentProfileId);
  const availableClis = useAvailableClis(profiles.find((p) => p.id === profileId));
  // Following the active tab: another agent tab brings its own profile.
  useEffect(() => setProfileId(currentProfileId), [currentProfileId]);
  const delegateHistory = useDelegateHistory();
  const delegations = useAllTabDelegations();
  const store = useHistoryStore();
  const customTitles = useHistoryTitles();
  useEffect(() => {
    if (visible) loadHistoryTitles();
  }, [visible]);
  const capable = isWorktreeCapable(projectCwd, wslDistro);
  const [repo, setRepo] = useState<{ cwd: string; wsl: string | undefined; info: RepoInfo } | null>(() => {
    const info = cachedRepo(projectCwd, wslDistro);
    return info ? { cwd: projectCwd, wsl: wslDistro, info } : null;
  });
  /** Roots unknown for too long: the Claude scan goes ahead with the folder alone. */
  const [rootsWaited, setRootsWaited] = useState<string | null>(null);
  const waitKey = `${wslDistro ?? ""}
${projectCwd}`;

  // The repo's worktrees count as the project; looked up once per folder (cached).
  useEffect(() => {
    let cancelled = false;
    const hit = cachedRepo(projectCwd, wslDistro);
    if (hit) {
      setRepo({ cwd: projectCwd, wsl: wslDistro, info: hit });
      return;
    }
    resolveRepo(projectCwd, wslDistro).then((info) => !cancelled && setRepo({ cwd: projectCwd, wsl: wslDistro, info }));
    const timer = setTimeout(() => !cancelled && setRootsWaited(waitKey), ROOTS_WAIT_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectCwd, wslDistro, waitKey]);

  const repoReady = repo?.cwd === projectCwd && repo.wsl === wslDistro;
  const roots = repoReady ? repo.info.roots : [projectCwd];
  const worktrees = repoReady ? repo.info.worktrees : [];
  const rootsKey = JSON.stringify(roots);
  const claudeReady = !capable || repoReady || rootsWaited === waitKey;

  // The agents without a project scope: each list shows as soon as its scan answers.
  useEffect(() => {
    if (!visible) return;
    const load = () => (["codex", "vibe", "opencode", "cline"] as const).forEach(refreshGlobalAgent);
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [visible]);

  // Claude: scoped to the roots. Same roots = same scan, so a late-arriving identical set doesn't rescan.
  useEffect(() => {
    if (!visible || wslDistro || !claudeReady) return;
    const list: string[] = JSON.parse(rootsKey);
    const load = () => refreshClaude(list);
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [visible, rootsKey, wslDistro, claudeReady]);

  const claude = store.claude[rootsKey] ?? store.claudeLast ?? EMPTY_CLAUDE;
  const { codex, vibe, opencode, cline } = store;
  /** Some agent has not answered yet since the app started. */
  const pending =
    !(["codex", "vibe", "opencode", "cline"] as const).every((id) => store.loaded.has(id)) ||
    (!wslDistro && !store.loaded.has(`claude:${rootsKey}`) && store.claudeLast === null);

  const rows = useMemo(() => {
    const open: OpenSession[] = [];
    const statusOf = (s: string | undefined) => (s === "busy" || s === "waiting" ? s : s === "exited" ? undefined : "idle");
    for (const tab of chatTabs) {
      open.push({ cli: tab.agent, sessionId: tab.sessionId ?? "", title: tab.label, cwd: tab.cwd, at: null, profile: tab.profileId ?? null, wslDistro: null, tabId: tab.id, status: statusOf(tab.status) });
      // Conversations of the tab running in the background.
      for (const pane of tab.parked ?? []) {
        open.push({ cli: tab.agent, sessionId: pane.sessionId ?? "", title: pane.label, cwd: tab.cwd, at: null, profile: tab.profileId ?? null, wslDistro: null, tabId: tab.id, status: statusOf(pane.status) });
      }
    }
    for (const session of sessions ?? []) {
      const tab = tabs.find((x) => getPtyId(x.id) === session.pty_id);
      if (!tab || !isAgentCli(session.cli)) continue;
      const cwd = session.cwd ?? session.tab_cwd ?? tab.cwd;
      const status = session.status === "busy" || session.status === "waiting" ? session.status : "idle";
      open.push({ cli: session.cli, sessionId: session.session_id ?? "", title: session.session_name || tab.label, cwd, at: session.started_at, profile: session.profile, wslDistro: session.wsl_distro, tabId: tab.id, status });
    }
    // Delegated children are listed under their orchestrator, not as conversations of their own.
    const built = buildHistoryRows({ entries: { claude, codex, vibe, opencode, cline }, roots, wslDistro, open, exclude: childKeys(delegateHistory) });
    // A name set with "Rename" wins over the agent's own title (and a tab's label).
    return built.map((row) => (customTitles[row.key] ? { ...row, title: customTitles[row.key] } : row));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claude, codex, vibe, opencode, cline, sessions, tabs, chatTabs, delegateHistory, rootsKey, wslDistro, customTitles]);

  /** The linked worktree a folder is in, if any. */
  const branchOf = (cwd: string) => worktrees.find((w) => !w.is_main && inProject(cwd, null, w.path, undefined))?.branch ?? null;
  /** A child still open in its delegate tab comes to the front; otherwise its conversation resumes as a normal chat. */
  const openChild = (row: HistoryRow, child: DelegateChild) => {
    const tab = delegateTabs.find((x) => x.delegate?.taskId === child.taskId);
    if (tab) return onOpenTab(tab.id);
    // Its chat still runs under a live orchestrator: attach to it. Resuming would load the session a second time,
    // which the agent refuses while that chat holds it (Codex: "session is in use by another Codex client").
    for (const [parentTabId, delegation] of Object.entries(delegations)) {
      if (delegation.ended) continue;
      const live = delegation.delegates.find((d) => d.taskId === child.taskId);
      if (live && onOpenDelegate) return onOpenDelegate(parentTabId, live, delegation.wslDistro);
    }
    if (!isAgentCli(child.agent)) return;
    onResume(row.cwd, child.childSessionId, child.agent, row.wslDistro ?? undefined, child.agent === row.cli ? (row.profile ?? undefined) : undefined, undefined);
  };
  const openRow = (row: HistoryRow) => {
    if (row.tabId) onOpenTab(row.tabId, row.sessionId || undefined);
    else onResume(row.cwd, row.sessionId, row.cli, row.wslDistro ?? undefined, row.profile ?? undefined, row.at > 0 ? row.at : undefined);
  };
  /** A delegated chat still live (open in a tab or running under its orchestrator) can't be deleted. */
  const childLive = (child: DelegateChild) =>
    delegateTabs.some((x) => x.delegate?.taskId === child.taskId) || Object.values(delegations).some((d) => !d.ended && d.delegates.some((x) => x.taskId === child.taskId));

  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  /** Takes the deleted chats out of the delegate memory and refreshes the lists they came from. */
  const onDeleted = useCallback((done: DeleteEntry[], failed: DeleteEntry[]) => {
    forgetDelegates(done.filter((e) => e.orchestrator).map((e) => e.item.sessionId));
    const clis = new Set([...done, ...failed].map((e) => e.item.cli));
    GLOBAL_AGENTS.filter((a) => clis.has(a)).forEach(refreshGlobalAgent);
    if (clis.has("claude")) refreshClaude(rootsRef.current);
  }, []);

  return (
    <HistoryView
      rows={rows}
      pending={pending}
      projectCwd={projectCwd}
      currentSessionId={currentSessionId}
      hidden={LOCAL_HIDDEN}
      keyOf={localKey}
      openRow={openRow}
      deleteItems={deleteItems}
      onDeleted={onDeleted}
      reveal={revealItem}
      rename={(row, title) => renameHistoryChat(row.cli, row.sessionId, title)}
      delegates={{ kidsOf: (row) => delegateHistory[row.sessionId]?.children ?? [], childLive, openChild }}
      branchOf={branchOf}
      newSession={{
        currentCli,
        clis: availableClis,
        profileId,
        currentProfileId,
        profilePicker: true,
        onProfileChange: setProfileId,
        onNew: (cli, profile) => onNewSession(cli, projectCwd, profile),
      }}
    />
  );
}
