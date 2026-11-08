import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatTab, TermTab } from "../tabs/types";
import { agentCliIcon } from "../plugins/icons";
import { useI18n } from "../i18n";
import { relativeCommitTime } from "../lib/time";
import type { AgentSession } from "./agentSessions";
import { gitRepoRoot, gitWorktrees, isWorktreeCapable, type GitWorktree } from "./git";
import { inProject, keepIfSame } from "./agentScope";
import { AGENT_CLIS, CLI_INFO, cliName, type AgentCli } from "./cliInfo";
import { useAvailableClis } from "./useAvailableClis";
import { useProfiles } from "../profiles/profiles";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { useOutsideClose } from "../hooks/useOutsideClose";
import { childKeys, useDelegateHistory, type DelegateChild } from "./delegateHistory";
import { useAllTabDelegations } from "../chat/delegateStore";
import type { DelegateInfo } from "../chat/chatModel";
import { historyDot, TONE_LABEL, delegateTone } from "./delegateView";
import type { ClaudeSessionEntry, CodexSessionEntry, OpencodeSessionEntry, VibeSessionEntry } from "./entryTypes";
import "./agent-history.css";

const POLL_MS = 5000;

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

interface HistoryRow {
  key: string;
  cli: AgentCli;
  sessionId: string;
  title: string | null;
  cwd: string;
  at: number;
  profile: string | null;
  wslDistro: string | null;
  /** The tab it is open in, if any. */
  tabId?: string;
  status?: "busy" | "waiting" | "idle";
}

const isAgentCli = (cli: string): cli is AgentCli => (AGENT_CLIS as readonly string[]).includes(cli);

/** "N delegates" on an orchestrator's row, with a pip per delegate; opens and closes the list of their chats. */
function DelegateChip({ kids, open, onToggle }: { kids: DelegateChild[]; open: boolean; onToggle: () => void }) {
  const { t } = useI18n();
  const waiting = kids.some((k) => k.status === "waiting_for_user");
  const label = t(kids.length === 1 ? "history.delegates.one" : "history.delegates.other", { count: kids.length });
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={open}
      title={t("history.delegates.toggle")}
      className={`agents-sidebar-chip agents-sidebar-chip--${waiting ? "waiting" : "running"} agent-history-delegates`}
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
      <span className="agent-history-pips" aria-hidden="true">
        {kids.map((k) => (
          <i key={k.taskId} className={`is-${delegateTone(k.status)}`} />
        ))}
      </span>
      {label}
      <svg className="agent-history-delegates-chev" viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="9 6 15 12 9 18" />
      </svg>
    </span>
  );
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
  const [claude, setClaude] = useState<ClaudeSessionEntry[]>([]);
  const [codex, setCodex] = useState<CodexSessionEntry[]>([]);
  const [vibe, setVibe] = useState<VibeSessionEntry[]>([]);
  const [opencode, setOpencode] = useState<OpencodeSessionEntry[]>([]);
  const [repo, setRepo] = useState<{ cwd: string; roots: string[]; worktrees: GitWorktree[] } | null>(null);

  // The repo's worktrees count as the project; looked up when the folder changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let roots = [projectCwd];
      let worktrees: GitWorktree[] = [];
      if (isWorktreeCapable(projectCwd, wslDistro)) {
        try {
          const root = await gitRepoRoot(projectCwd);
          if (root) {
            worktrees = await gitWorktrees(root);
            roots = worktrees.length > 0 ? worktrees.map((w) => w.path) : [root];
          }
        } catch {
          roots = [projectCwd];
          worktrees = [];
        }
      }
      if (!cancelled) setRepo({ cwd: projectCwd, roots, worktrees });
    })();
    return () => {
      cancelled = true;
    };
  }, [projectCwd, wslDistro]);

  const roots = repo?.cwd === projectCwd ? repo.roots : [projectCwd];
  const worktrees = repo?.cwd === projectCwd ? repo.worktrees : [];
  const rootsKey = JSON.stringify(roots);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const list: string[] = JSON.parse(rootsKey);
    function load() {
      // Rejections keep what was last known.
      if (!wslDistro) {
        invoke<ClaudeSessionEntry[]>("list_claude_sessions", { roots: list })
          .then((r) => !cancelled && setClaude((prev) => keepIfSame(prev, r)))
          .catch(() => {});
      }
      invoke<CodexSessionEntry[]>("list_codex_sessions", { fresh: false })
        .then((r) => !cancelled && setCodex((prev) => keepIfSame(prev, r)))
        .catch(() => {});
      invoke<VibeSessionEntry[]>("list_vibe_sessions", { fresh: false })
        .then((r) => !cancelled && setVibe((prev) => keepIfSame(prev, r)))
        .catch(() => {});
      invoke<OpencodeSessionEntry[]>("list_opencode_sessions", { fresh: false })
        .then((r) => !cancelled && setOpencode((prev) => keepIfSame(prev, r)))
        .catch(() => {});
    }
    load();
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
  }, [visible, rootsKey, wslDistro]);

  const inRoots = (cwd: string | null | undefined, distro: string | null | undefined) =>
    roots.some((root) => inProject(cwd, distro, root, wslDistro));

  const rows = useMemo(() => {
    const now = Date.now();
    const byKey = new Map<string, HistoryRow>();
    const add = (row: Omit<HistoryRow, "key">) => byKey.set(`${row.cli}:${row.sessionId}`, { ...row, key: `${row.cli}:${row.sessionId}` });
    for (const s of claude) {
      if (!inRoots(s.cwd, null)) continue;
      add({ cli: "claude", sessionId: s.sessionId, title: s.title, cwd: s.cwd, at: s.updatedAt ?? s.startedAt ?? 0, profile: s.profile, wslDistro: null });
    }
    for (const s of codex) {
      if (!inRoots(s.cwd, s.wslDistro)) continue;
      add({ cli: "codex", sessionId: s.sessionId, title: s.name, cwd: s.cwd, at: s.startedAt ?? 0, profile: s.profile, wslDistro: s.wslDistro });
    }
    for (const s of vibe) {
      if (!inRoots(s.cwd, s.wslDistro)) continue;
      add({ cli: "vibe", sessionId: s.sessionId, title: s.name, cwd: s.cwd, at: s.startedAt ?? 0, profile: s.profile, wslDistro: s.wslDistro });
    }
    for (const s of opencode) {
      if (!inRoots(s.cwd, s.wslDistro)) continue;
      add({ cli: "opencode", sessionId: s.sessionId, title: s.name, cwd: s.cwd, at: s.startedAt ?? 0, profile: s.profile, wslDistro: s.wslDistro });
    }
    const live: HistoryRow[] = [];
    /** Marks the saved row open in `tabId`, or lists a not-yet-saved session. */
    const mark = (row: Omit<HistoryRow, "key" | "at"> & { at: number | null }) => {
      const key = `${row.cli}:${row.sessionId}`;
      const saved = row.sessionId ? byKey.get(key) : undefined;
      if (saved) {
        saved.tabId = row.tabId;
        saved.status = row.status;
      } else {
        live.push({ ...row, at: row.at ?? now, key: row.sessionId ? key : `tab:${row.tabId}` });
      }
    };
    for (const tab of chatTabs) {
      if (!inRoots(tab.cwd, null)) continue;
      const status = tab.status === "busy" || tab.status === "waiting" ? tab.status : tab.status === "exited" ? undefined : "idle";
      mark({ cli: tab.agent, sessionId: tab.sessionId ?? "", title: tab.label, cwd: tab.cwd, at: null, profile: tab.profileId ?? null, wslDistro: null, tabId: tab.id, status });
      // Conversations of the tab running in the background.
      for (const pane of tab.parked ?? []) {
        const paneStatus = pane.status === "busy" || pane.status === "waiting" ? pane.status : pane.status === "exited" ? undefined : "idle";
        mark({ cli: tab.agent, sessionId: pane.sessionId ?? "", title: pane.label, cwd: tab.cwd, at: null, profile: tab.profileId ?? null, wslDistro: null, tabId: tab.id, status: paneStatus });
      }
    }
    for (const session of sessions ?? []) {
      const tab = tabs.find((x) => getPtyId(x.id) === session.pty_id);
      if (!tab || !isAgentCli(session.cli)) continue;
      const cwd = session.cwd ?? session.tab_cwd ?? tab.cwd;
      if (!inRoots(cwd, session.wsl_distro)) continue;
      const status = session.status === "busy" || session.status === "waiting" ? session.status : "idle";
      mark({ cli: session.cli, sessionId: session.session_id ?? "", title: session.session_name || tab.label, cwd, at: session.started_at, profile: session.profile, wslDistro: session.wsl_distro, tabId: tab.id, status });
    }
    // The same session can appear twice (two live tabs, or a live and a saved row): one row per key.
    const unique = new Map<string, HistoryRow>();
    // Delegated children are listed under their orchestrator, not as conversations of their own.
    const children = childKeys(delegateHistory);
    for (const row of [...byKey.values(), ...live]) {
      if (children.has(row.key)) continue;
      const prev = unique.get(row.key);
      if (!prev || (row.tabId !== undefined && prev.tabId === undefined) || (row.tabId !== undefined === (prev.tabId !== undefined) && row.at > prev.at)) {
        unique.set(row.key, row);
      }
    }
    return [...unique.values()].sort((a, b) => b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claude, codex, vibe, opencode, sessions, tabs, chatTabs, delegateHistory, rootsKey, wslDistro]);

  const needle = query.trim().toLowerCase();
  const titleOf = (row: HistoryRow) => row.title || `${CLI_INFO[row.cli].label} · ${row.sessionId.slice(0, 8)}`;
  const shown = needle ? rows.filter((row) => titleOf(row).toLowerCase().includes(needle)) : rows;

  const dayStart = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const today = dayStart(Date.now());
  const yesterday = dayStart(today - 1);
  const groups: { label: string; rows: HistoryRow[] }[] = [];
  for (const row of shown) {
    const day = dayStart(row.at);
    const label =
      day >= today
        ? t("history.today")
        : day === yesterday
          ? t("history.yesterday")
          : new Date(row.at).toLocaleDateString(language, { day: "numeric", month: "long" });
    const last = groups[groups.length - 1];
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }

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
  const timeOf = (row: HistoryRow) => {
    if (row.at <= 0) return "";
    return Date.now() - row.at < 60_000 ? t("history.now") : relativeCommitTime(row.at / 1000);
  };

  return (
    <div className="agent-history">
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
      <div className="agent-history-list">
        {groups.length === 0 && <div className="agent-history-empty">{needle ? t("history.noMatch") : t("history.empty")}</div>}
        {groups.map((group) => (
          <section key={group.label}>
            <div className="agent-history-group">{group.label}</div>
            {group.rows.map((row) => {
              const branch = branchOf(row.cwd);
              const time = timeOf(row);
              const kids = row.sessionId ? (delegateHistory[row.sessionId]?.children ?? []) : [];
              const unfoldedKids = kids.length > 0 && unfolded.has(row.sessionId);
              return (
                <Fragment key={row.key}>
                <button
                  type="button"
                  className={"agent-history-row" + (row.sessionId && row.sessionId === currentSessionId ? " is-current" : "")}
                  aria-current={row.sessionId && row.sessionId === currentSessionId ? "true" : undefined}
                  title={`${titleOf(row)}\n${row.cwd}`}
                  onClick={() => {
                    if (row.tabId) onOpenTab(row.tabId, row.sessionId || undefined);
                    else onResume(row.cwd, row.sessionId, row.cli, row.wslDistro ?? undefined, row.profile ?? undefined, row.at > 0 ? row.at : undefined);
                  }}
                >
                  <span className="agent-history-icon">{agentCliIcon(row.cli)}</span>
                  <span className="agent-history-body">
                    <span className="agent-history-title">{titleOf(row)}</span>
                    <span className="agent-history-meta">
                      {time}
                      {branch && `${time ? " · " : ""}⎇ ${branch}`}
                      {kids.length > 0 && (
                        <DelegateChip kids={kids} open={unfoldedKids} onToggle={() => toggleKids(row.sessionId)} />
                      )}
                      {row.status && row.status !== "idle" && (
                        <span className={`agent-history-status agent-history-status--${row.status}`}>
                          {`${time || branch ? " · " : ""}${row.status === "busy" ? t("agents.status.busy") : t("agents.status.waiting")}`}
                        </span>
                      )}
                    </span>
                  </span>
                  {row.tabId && <span className={`agent-history-dot agent-history-dot--${row.status ?? "idle"}`} aria-hidden="true" />}
                </button>
                {unfoldedKids && (
                  <div className="agent-history-kids">
                    {kids.map((child) => (
                      <button
                        key={child.taskId}
                        type="button"
                        className="agent-history-row is-child"
                        title={child.title}
                        onClick={() => openChild(row, child)}
                      >
                        <span className="agent-history-icon">{agentCliIcon(child.agent)}</span>
                        <span className="agent-history-body">
                          <span className="agent-history-title">{child.title || cliName(child.agent)}</span>
                          <span className="agent-history-meta">{`${cliName(child.agent)} · ${t(TONE_LABEL[delegateTone(child.status)])}`}</span>
                        </span>
                        <span className={`agent-history-dot agent-history-dot--${historyDot(child.status)}`} aria-hidden="true" />
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
