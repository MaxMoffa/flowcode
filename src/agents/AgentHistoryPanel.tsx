import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ChatTab, TermTab } from "../tabs/types";
import { agentCliIcon } from "../plugins/icons";
import { useI18n } from "../i18n";
import { relativeCommitTime } from "../lib/time";
import type { AgentSession } from "./agentSessions";
import { isWorktreeCapable } from "./git";
import { inProject } from "./agentScope";
import { cachedRepo, refreshClaude, refreshGlobalAgent, resolveRepo, seenRowKeys, useHistoryStore, type RepoInfo } from "./historyStore";
import { buildHistoryRows, filterRows, groupByDay, type HistoryRow, type OpenSession } from "./historyRows";
import { AGENT_CLIS, CLI_INFO, cliName, type AgentCli } from "./cliInfo";
import { useAvailableClis } from "./useAvailableClis";
import { useProfiles } from "../profiles/profiles";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { useOutsideClose } from "../hooks/useOutsideClose";
import { childKeys, useDelegateHistory, type DelegateChild } from "./delegateHistory";
import { useAllTabDelegations } from "../chat/delegateStore";
import type { DelegateInfo } from "../chat/chatModel";
import { historyDot, TONE_LABEL, delegateTone } from "./delegateView";
import type { ClaudeSessionEntry } from "./entryTypes";
import { forgetDelegates } from "./delegateHistory";
import { getHiddenRows, hideRows, historyDeleteSessions, historySessionPath, unhideRows, useHiddenRows, type HistoryItem } from "./historyDelete";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { MenuIcons } from "../context-menu/menuIcons";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { HistoryToast, MORE_ICON, RowMore, useUndoDelete } from "./historyDeleteUi";
import "./agent-history.css";

const POLL_MS = 5000;
/** How long the first Claude scan waits for the repo's worktrees before going ahead with the folder alone. */
const ROOTS_WAIT_MS = 300;
/** Nothing arrived for this long: ghost rows appear (a faster answer shows no flash). */
const GHOST_DELAY_MS = 150;
const GHOST_ROWS = 8;
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

/** The arrow left of an orchestrator's icon: opens and closes the list of its delegated chats. */
function DelegateTwisty({ kids, open, onToggle }: { kids: DelegateChild[]; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const label = t(kids.length === 1 ? "history.delegates.one" : "history.delegates.other", { count: kids.length });
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={label}
      title={`${label} - ${t("history.delegates.toggle")}`}
      className="agent-history-twisty"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
    >
      <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </span>
  );
}

/** A saved chat on its way out: what the backend needs, its hidden-row key, and whether it had delegated chats. */
interface DeleteEntry {
  item: HistoryItem;
  key: string;
  orchestrator?: boolean;
}

const GLOBAL_AGENTS = ["codex", "vibe", "opencode", "cline"] as const;

/** Deletes for good, takes failures back into the list and refreshes the lists. `onFailed` gets how many could not be deleted. */
async function deleteEntries(entries: DeleteEntry[], roots: string[], onFailed: (count: number) => void) {
  if (entries.length === 0) return;
  let failedIds: Set<string>;
  try {
    const res = await historyDeleteSessions(entries.map((e) => e.item));
    failedIds = new Set(res.failed.map((f) => f.sessionId));
  } catch {
    failedIds = new Set(entries.map((e) => e.item.sessionId));
  }
  const failed = entries.filter((e) => failedIds.has(e.item.sessionId));
  const done = entries.filter((e) => !failedIds.has(e.item.sessionId));
  unhideRows(failed.map((e) => e.key));
  forgetDelegates(done.filter((e) => e.orchestrator).map((e) => e.item.sessionId));
  const clis = new Set(entries.map((e) => e.item.cli));
  GLOBAL_AGENTS.filter((a) => clis.has(a)).forEach(refreshGlobalAgent);
  if (clis.has("claude")) refreshClaude(roots);
  if (failed.length > 0) onFailed(failed.length);
}

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
  const { t, language } = useI18n();
  const { profiles } = useProfiles();
  const [profileId, setProfileId] = useState<string | undefined>(currentProfileId);
  const [menuOpen, setMenuOpen] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);
  const availableClis = useAvailableClis(profiles.find((p) => p.id === profileId));
  // Following the active tab: another agent tab brings its own profile.
  useEffect(() => setProfileId(currentProfileId), [currentProfileId]);
  // The profile list is portaled to the body, so it counts as inside.
  useOutsideClose(menuOpen, [footerRef], () => setMenuOpen(false), { escape: true, ignore: (el) => !!el.closest("[data-profile-select-menu]") });
  const [query, setQuery] = useState("");
  const delegateHistory = useDelegateHistory();
  const delegations = useAllTabDelegations();
  /** Orchestrator sessions whose delegated chats are listed under them. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const store = useHistoryStore();
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
    return buildHistoryRows({ entries: { claude, codex, vibe, opencode, cline }, roots, wslDistro, open, exclude: childKeys(delegateHistory) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claude, codex, vibe, opencode, cline, sessions, tabs, chatTabs, delegateHistory, rootsKey, wslDistro]);

  // Deleted rows stay out of the list even while the backend lists still carry them.
  const hiddenRows = useHiddenRows();
  const visibleRows = useMemo(() => rows.filter((row) => !hiddenRows.has(row.key)), [rows, hiddenRows]);

  // Ghost rows only when the wait lasts: nothing here after GHOST_DELAY_MS.
  const [ghost, setGhost] = useState(false);
  const waiting = pending && visibleRows.length === 0;
  useEffect(() => {
    if (!waiting) return setGhost(false);
    const timer = setTimeout(() => setGhost(true), GHOST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
  // A warm store (return to the tab) draws at once; only rows arriving during the first load rise, once.
  const riseKeys = useRef(new Set<string>());
  const warmStart = useRef(!pending);
  if (pending && !warmStart.current) {
    for (const row of rows) {
      if (!seenRowKeys.has(row.key)) riseKeys.current.add(row.key);
    }
  }
  for (const row of rows) seenRowKeys.add(row.key);

  const titleOf = (row: HistoryRow) => row.title || `${CLI_INFO[row.cli].label} · ${row.sessionId.slice(0, 8)}`;
  const shown = filterRows(visibleRows, query, titleOf);
  const needle = query.trim();
  const groups = groupByDay(shown, (day) =>
    day === "open" ? t("history.open") : day === "today" ? t("history.today") : day === "yesterday" ? t("history.yesterday") : new Date(day).toLocaleDateString(language, { day: "numeric", month: "long" }),
  );

  /** Some row has delegated chats: every row then leaves room for the arrow, so titles stay aligned. */
  const kidsOf = (row: HistoryRow) => (row.sessionId ? (delegateHistory[row.sessionId]?.children ?? []) : []).filter((c) => !hiddenRows.has(`${c.agent}:${c.childSessionId}`));
  const hasDelegates = shown.some((row) => kidsOf(row).length > 0);

  /** The linked worktree a folder is in, if any. */
  const branchOf = (cwd: string) => worktrees.find((w) => !w.is_main && inProject(cwd, null, w.path, undefined))?.branch ?? null;
  const toggleKids = (sessionId: string) =>
    setUnfolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
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

  // ---- deleting ----
  const { show: showMenu } = useContextMenu();
  const confirm = useConfirmDialog();
  /** The row whose menu is open (kept lit). The menu has no close hook: any press, Escape or blur ends it. */
  const [menuKey, setMenuKey] = useState<string | null>(null);
  useEffect(() => {
    if (!menuKey) return;
    const close = () => setMenuKey(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", close);
    };
  }, [menuKey]);

  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const { toast, batch, showError, reportFailed, flush: flushBatch, queue: queueDelete, undo: undoDelete } = useUndoDelete<DeleteEntry>({
    hide: hideRows,
    unhide: unhideRows,
    commit: (entries, onFailed) => deleteEntries(entries, rootsRef.current, onFailed),
  });

  /** A delegated chat still live (open in a tab or running under its orchestrator) can't be deleted. */
  const childLive = (child: DelegateChild) =>
    delegateTabs.some((x) => x.delegate?.taskId === child.taskId) || Object.values(delegations).some((d) => !d.ended && d.delegates.some((x) => x.taskId === child.taskId));
  const entryOf = (cli: string, sessionId: string, profile: string | null, wslDistro: string | null): DeleteEntry => ({ item: { cli, sessionId, profile, wslDistro }, key: `${cli}:${sessionId}` });
  /** A row with the delegated chats that go with it. */
  const entriesOfRow = (row: HistoryRow): DeleteEntry[] => {
    const kids = kidsOf(row).filter((c) => !childLive(c));
    const own = { ...entryOf(row.cli, row.sessionId, row.profile, row.wslDistro), orchestrator: kidsOf(row).length > 0 };
    return [own, ...kids.map((c) => entryOf(c.agent, c.childSessionId, c.agent === row.cli ? row.profile : null, row.wslDistro))];
  };

  const copyId = (id: string) => void navigator.clipboard.writeText(id).catch(() => {});
  const reveal = (item: HistoryItem) => {
    historySessionPath(item)
      .then((path) => revealItemInDir(path))
      .catch(() => showError(t("history.reveal.failed")));
  };
  /** Menu of one saved chat: `open` is what a click on the row does. */
  const chatMenu = (open: { label: string; run: () => void }, entry: DeleteEntry, toDelete: DeleteEntry[] | null): ContextMenuItem[] => [
    { label: open.label, icon: MenuIcons.openExternal, onSelect: open.run },
    { label: t("history.menu.reveal"), icon: MenuIcons.folder, disabled: !entry.item.sessionId, onSelect: () => reveal(entry.item) },
    { label: t("history.menu.copyId"), icon: MenuIcons.duplicate, disabled: !entry.item.sessionId, onSelect: () => copyId(entry.item.sessionId) },
    { label: "history-menu-separator", separator: true },
    toDelete
      ? { label: t("history.menu.delete"), icon: MenuIcons.trash, danger: true, onSelect: () => queueDelete(toDelete) }
      : { label: t("history.menu.deleteOpen"), icon: MenuIcons.trash, danger: true, disabled: true },
  ];
  const rowMenu = (row: HistoryRow) => {
    const entries = entriesOfRow(row);
    const canDelete = !row.tabId && !!row.sessionId;
    return chatMenu({ label: t(row.tabId ? "history.menu.goToTab" : "history.menu.resume"), run: () => openRow(row) }, entries[0], canDelete ? entries : null);
  };
  const childMenu = (row: HistoryRow, child: DelegateChild) => {
    const entry = entryOf(child.agent, child.childSessionId, child.agent === row.cli ? row.profile : null, row.wslDistro);
    const live = childLive(child);
    const label = t(live ? "history.menu.goToTab" : "history.menu.resume");
    return chatMenu({ label, run: () => openChild(row, child) }, entry, live || !child.childSessionId ? null : [entry]);
  };
  /** Opens a menu at the "⋯" button (its right edge under the button) or at the pointer. */
  const openAt = (key: string, items: ContextMenuItem[], at: { x: number; y: number } | DOMRect) => {
    setMenuKey(key);
    if (at instanceof DOMRect) showMenu(at.right - 200, at.bottom + 4, items);
    else showMenu(at.x, at.y, items);
  };
  const onRowContext = (key: string, items: () => ContextMenuItem[]) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openAt(key, items(), { x: e.clientX, y: e.clientY });
  };

  /** What "Clear project history" would delete: every saved chat of the list (not the open ones), with its delegated chats. */
  const clearEntries = visibleRows.filter((row) => !row.tabId && row.sessionId).flatMap(entriesOfRow);
  const labelOf = (cli: string) => (isAgentCli(cli) ? CLI_INFO[cli].label : cliName(cli));
  const clearProject = async () => {
    const entries = clearEntries;
    if (entries.length === 0) return;
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.item.cli, (counts.get(e.item.cli) ?? 0) + 1);
    const breakdown = [...counts].map(([cli, n]) => `${labelOf(cli)} ${n}`).join(", ");
    const project = projectCwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || projectCwd;
    const ok = await confirm({
      title: t("history.clear.title", { project }),
      message: t("history.clear.message", { count: entries.length, breakdown }),
      confirmLabel: t("history.clear.confirm", { count: entries.length }),
      danger: true,
    });
    if (!ok) return;
    // The pending single deletes go first, then these - no undo.
    if (batch.current.length > 0) flushBatch();
    const fresh = entries.filter((e) => !getHiddenRows().has(e.key));
    hideRows(fresh.map((e) => e.key));
    void deleteEntries(fresh, rootsRef.current, reportFailed);
  };
  const toolsMenu = (rect: DOMRect) =>
    openAt("tools", [{ label: t("history.clear.menu"), icon: MenuIcons.trash, danger: true, disabled: clearEntries.length === 0, onSelect: () => void clearProject() }], rect);

  const timeOf = (row: HistoryRow) => {
    if (row.at <= 0) return "";
    return Date.now() - row.at < 60_000 ? t("history.now") : relativeCommitTime(row.at / 1000);
  };

  return (
    <div className="agent-history">
      <div className="agent-history-searchrow">
        <label className="agent-history-search">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2l3.3 3.3" />
          </svg>
          <input
            type="text"
            value={query}
            placeholder={t("history.search")}
            aria-label={t("history.search")}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button
          type="button"
          className={"agent-history-tools" + (menuKey === "tools" ? " is-open" : "")}
          aria-haspopup="menu"
          aria-label={t("history.tools")}
          title={t("history.tools")}
          onClick={(e) => toolsMenu(e.currentTarget.getBoundingClientRect())}
        >
          {MORE_ICON}
        </button>
      </div>
      <div className="agent-history-listwrap">
      {pending && <div className="agent-history-topbar" role="progressbar" aria-busy="true" />}
      <div className={"agent-history-list" + (hasDelegates ? " has-delegates" : "")}>
        {groups.length === 0 && !pending && <div className="agent-history-empty">{needle ? t("history.noMatch") : t("history.empty")}</div>}
        {groups.length === 0 && ghost && (
          <div className="agent-history-ghosts" aria-hidden="true">
            {Array.from({ length: GHOST_ROWS }, (_, i) => (
              <div key={i} className="agent-history-ghost">
                <span className="agent-history-ghost-icon" />
                <span className="agent-history-ghost-body">
                  <span className="agent-history-ghost-bar" style={{ width: `${[78, 62, 70, 55, 82, 66, 74, 58][i]}%` }} />
                  <span className="agent-history-ghost-bar is-short" style={{ width: `${[38, 30, 42, 34, 28, 40, 36, 31][i]}%` }} />
                </span>
              </div>
            ))}
          </div>
        )}
        {groups.map((group) => (
          <section key={group.label}>
            <div className="agent-history-group">
              {group.label}
              {pending && <span className="agent-history-count">{group.rows.length}</span>}
            </div>
            {group.rows.map((row) => {
              const branch = branchOf(row.cwd);
              const time = timeOf(row);
              const kids = kidsOf(row);
              const unfoldedKids = kids.length > 0 && unfolded.has(row.sessionId);
              return (
                <Fragment key={row.key}>
                <button
                  type="button"
                  className={"agent-history-row" + (riseKeys.current.has(row.key) ? " is-rise" : "") + (kids.length > 0 ? " has-delegates" : "") + (row.sessionId && row.sessionId === currentSessionId ? " is-current" : "") + (menuKey === row.key ? " is-menu-open" : "")}
                  aria-current={row.sessionId && row.sessionId === currentSessionId ? "true" : undefined}
                  title={`${titleOf(row)}\n${row.cwd}`}
                  onClick={() => openRow(row)}
                  onContextMenu={onRowContext(row.key, () => rowMenu(row))}
                >
                  {kids.length > 0 && <DelegateTwisty kids={kids} open={unfoldedKids} onToggle={() => toggleKids(row.sessionId)} />}
                  <span className="agent-history-icon">
                    {agentCliIcon(row.cli)}
                    {kids.length > 0 && (
                      <span
                        className={"agent-history-badge" + (kids.some((k) => k.status === "waiting_for_user") ? " is-waiting" : "")}
                        aria-hidden="true"
                      >
                        {kids.length}
                      </span>
                    )}
                  </span>
                  <span className="agent-history-body">
                    <span className="agent-history-title">{titleOf(row)}</span>
                    <span className="agent-history-meta">
                      {time}
                      {branch && `${time ? " · " : ""}⎇ ${branch}`}
                      {row.status && row.status !== "idle" && (
                        <span className={`agent-history-status agent-history-status--${row.status}`}>
                          {`${time || branch ? " · " : ""}${row.status === "busy" ? t("agents.status.busy") : t("agents.status.waiting")}`}
                        </span>
                      )}
                    </span>
                  </span>
                  {row.tabId && <span className={`agent-history-dot agent-history-dot--${row.status ?? "idle"}`} aria-hidden="true" />}
                  <RowMore label={t("history.menu.more")} onOpen={(rect) => openAt(row.key, rowMenu(row), rect)} />
                </button>
                {unfoldedKids && (
                  <div className="agent-history-kids">
                    {kids.map((child) => (
                      <button
                        key={child.taskId}
                        type="button"
                        className={"agent-history-row is-child" + (menuKey === `child:${child.taskId}` ? " is-menu-open" : "")}
                        title={child.title}
                        onClick={() => openChild(row, child)}
                        onContextMenu={onRowContext(`child:${child.taskId}`, () => childMenu(row, child))}
                      >
                        <span className="agent-history-icon">{agentCliIcon(child.agent)}</span>
                        <span className="agent-history-body">
                          <span className="agent-history-title">{child.title || cliName(child.agent)}</span>
                          <span className="agent-history-meta">{`${cliName(child.agent)} · ${t(TONE_LABEL[delegateTone(child.status)])}`}</span>
                        </span>
                        <span className={`agent-history-dot agent-history-dot--${historyDot(child.status)}`} aria-hidden="true" />
                        <RowMore label={t("history.menu.more")} onOpen={(rect) => openAt(`child:${child.taskId}`, childMenu(row, child), rect)} />
                      </button>
                    ))}
                  </div>
                )}
                </Fragment>
              );
            })}
          </section>
        ))}
      </div>
      {toast && <HistoryToast toast={toast} count={batch.current.length} onUndo={undoDelete} />}
      </div>
      <div className="agent-history-footer" ref={footerRef}>
        {menuOpen && (
          <div className="agent-history-newmenu" role="menu">
            <div className="agent-history-newmenu-head">
              <span>{t("history.newWith")}</span>
              <ProfileSelect value={profileId} onChange={(next) => setProfileId(next)} />
            </div>
            {availableClis.length === 0 && <div className="agent-history-newmenu-empty">{t("history.noAgents")}</div>}
            {availableClis.map((cli) => (
              <button
                key={cli}
                type="button"
                role="menuitem"
                className="agent-history-newmenu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onNewSession(cli, projectCwd, profileId);
                }}
              >
                <span className="agent-history-newmenu-icon">{agentCliIcon(cli)}</span>
                <span>{CLI_INFO[cli].label}</span>
                {cli === currentCli && profileId === currentProfileId && (
                  <svg className="agent-history-newmenu-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="agent-history-split">
          <button type="button" className="agent-history-new" onClick={() => onNewSession(currentCli, projectCwd, profileId)}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t("history.new")}
          </button>
          <button
            type="button"
            className="agent-history-caret"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("history.newPick")}
            title={t("history.newPick")}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M4 6h8l-4 5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
