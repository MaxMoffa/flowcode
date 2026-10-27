import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChatTab, TermTab } from "../tabs/types";
import { agentCliIcon } from "../plugins/icons";
import { useI18n } from "../i18n";
import { formatElapsed } from "../lib/time";
import type { AgentSession } from "./agentSessions";
import { gitRepoRoot, gitWorktrees, isWorktreeCapable, type GitWorktree } from "./git";
import { inProject, keepIfSame } from "./agentScope";
import { AGENT_CLIS, CLI_INFO, type AgentCli } from "./cliInfo";
import type { ClaudeSessionEntry, CodexSessionEntry, VibeSessionEntry } from "./entryTypes";
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
  getPtyId: (tabId: string) => string | null;
  onOpenTab: (tabId: string) => void;
  onResume: (cwd: string, sessionId: string, cli: AgentCli, wslDistro?: string, profileId?: string) => void;
  onNewSession: (cli: AgentCli, cwd: string) => void;
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
  getPtyId,
  onOpenTab,
  onResume,
  onNewSession,
}: AgentHistoryPanelProps) {
  const { t, language } = useI18n();
  const [query, setQuery] = useState("");
  const [claude, setClaude] = useState<ClaudeSessionEntry[]>([]);
  const [codex, setCodex] = useState<CodexSessionEntry[]>([]);
  const [vibe, setVibe] = useState<VibeSessionEntry[]>([]);
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
    for (const row of [...byKey.values(), ...live]) {
      const prev = unique.get(row.key);
      if (!prev || (row.tabId !== undefined && prev.tabId === undefined) || (row.tabId !== undefined === (prev.tabId !== undefined) && row.at > prev.at)) {
        unique.set(row.key, row);
      }
    }
    return [...unique.values()].sort((a, b) => b.at - a.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claude, codex, vibe, sessions, tabs, chatTabs, rootsKey, wslDistro]);

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
  const timeOf = (row: HistoryRow) => {
    if (row.at <= 0) return "";
    return Date.now() - row.at < 60_000 ? t("history.now") : t("agents.ago", { duration: formatElapsed(row.at) });
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
              return (
                <button
                  key={row.key}
                  type="button"
                  className={"agent-history-row" + (row.sessionId && row.sessionId === currentSessionId ? " is-current" : "")}
                  aria-current={row.sessionId && row.sessionId === currentSessionId ? "true" : undefined}
                  title={`${titleOf(row)}\n${row.cwd}`}
                  onClick={() => {
                    if (row.tabId) onOpenTab(row.tabId);
                    else onResume(row.cwd, row.sessionId, row.cli, row.wslDistro ?? undefined, row.profile ?? undefined);
                  }}
                >
                  <span className="agent-history-icon">{agentCliIcon(row.cli)}</span>
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
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <div className="agent-history-footer">
        <button type="button" className="agent-history-new" onClick={() => onNewSession(currentCli, projectCwd)}>
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
          {t("history.new")}
        </button>
      </div>
    </div>
  );
}
