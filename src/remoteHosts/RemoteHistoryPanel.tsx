import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentCliIcon } from "../plugins/icons";
import { useI18n } from "../i18n";
import { relativeCommitTime } from "../lib/time";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { AGENT_CLIS, CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { buildHistoryRows, filterRows, groupByDay, type HistoryEntries, type HistoryRow, type OpenSession } from "../agents/historyRows";
import { chatKey, ptyKey } from "../../shared/remoteEntries";
import { hostRequest } from "./hostRequest";
import { chatLike, expectNewTab, terminalLike, selectRemoteKey, sendToHost, useHost, useHostState } from "./remoteHosts";
import "../agents/agent-history.css";

const POLL_MS = 15_000;
const EMPTY: HistoryEntries = { claude: [], codex: [], vibe: [], opencode: [], cline: [] };
const isAgentCli = (cli: string | undefined): cli is AgentCli => !!cli && (AGENT_CLIS as readonly string[]).includes(cli);
const statusOf = (s: string | undefined): "busy" | "waiting" | "idle" | undefined => (s === "busy" || s === "waiting" ? s : s === "exited" ? undefined : "idle");

/** What the History tab is shown for: the agent tab in front on the other PC. */
export interface RemoteAgentTab {
  cwd: string;
  cli: AgentCli;
  profile?: string;
  sessionId?: string;
  /** How a saved session picked here opens: the same kind of tab as the one in front. */
  view: "chat" | "terminal";
}

/** The sessions of the project the other PC's tab in front works in: saved ones read by that PC plus those open in its tabs. */
export function RemoteHistoryPanel({ hostId, agent, visible }: { hostId: string; agent: RemoteAgentTab; visible: boolean }) {
  const { t, language } = useI18n();
  const { show } = useContextMenu();
  const host = useHost(hostId);
  const { chats, tabs } = useHostState(hostId);
  const { cwd } = agent;
  const canResume = !!host?.caps.includes("resume");
  const online = host?.status === "online";
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ cwd: string; roots: string[]; entries: HistoryEntries } | null>(null);
  const [failed, setFailed] = useState(false);
  const [, tick] = useState(0);
  const seq = useRef(0);

  const load = useCallback(() => {
    const id = ++seq.current;
    hostRequest(hostId, "history", (requestId) => ({ t: "history", requestId, cwd }))
      .then((m) => {
        const r = m.result;
        if (!r || id !== seq.current) return;
        setFailed(false);
        setData({
          cwd,
          roots: r.roots.length > 0 ? r.roots : [cwd],
          entries: {
            claude: r.claude as HistoryEntries["claude"],
            codex: r.codex as HistoryEntries["codex"],
            vibe: r.vibe as HistoryEntries["vibe"],
            opencode: r.opencode as HistoryEntries["opencode"],
            cline: (r.cline ?? []) as HistoryEntries["cline"],
          },
        });
      })
      // The last list stays on screen; the error only shows when there is none.
      .catch(() => id === seq.current && setFailed(true));
  }, [hostId, cwd]);

  useEffect(() => {
    if (!visible || !online) return;
    load();
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      load();
      tick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      seq.current++;
    };
  }, [visible, online, load]);

  // Another folder or PC: nothing of the previous list stays.
  const mine = data && data.cwd === cwd ? data : null;

  const rows = useMemo(() => {
    const open: OpenSession[] = [];
    for (const c of chats) {
      if (!isAgentCli(c.agent)) continue;
      open.push({ cli: c.agent, sessionId: c.sessionId ?? "", title: c.label, cwd: c.cwd, wslDistro: null, profile: c.profile ?? null, tabId: chatKey(c.chatId), status: statusOf(c.status), at: null });
    }
    for (const x of tabs) {
      if (!isAgentCli(x.cli)) continue;
      open.push({ cli: x.cli, sessionId: x.sessionId ?? "", title: x.label, cwd: x.cwd, wslDistro: null, profile: x.profile ?? null, tabId: ptyKey(x.ptyId), status: statusOf(x.status), at: null });
    }
    return buildHistoryRows({ entries: mine?.entries ?? EMPTY, roots: mine?.roots ?? [cwd], open });
  }, [mine, cwd, chats, tabs]);

  const titleOf = (row: HistoryRow) => row.title || `${CLI_INFO[row.cli].label} · ${row.sessionId.slice(0, 8)}`;
  const shown = filterRows(rows, query, titleOf);
  const groups = groupByDay(shown, (day) =>
    day === "open" ? t("history.open") : day === "today" ? t("history.today") : day === "yesterday" ? t("history.yesterday") : new Date(day).toLocaleDateString(language, { day: "numeric", month: "long" }),
  );
  const timeOf = (row: HistoryRow) => (row.at <= 0 ? "" : Date.now() - row.at < 60_000 ? t("history.now") : relativeCommitTime(row.at / 1000));

  const openRow = (row: HistoryRow) => {
    // Open there: its tab comes to the front.
    if (row.tabId) return selectRemoteKey(hostId, row.tabId);
    if (!canResume || !row.sessionId) return;
    expectNewTab(hostId, agent.view === "chat" ? chatLike(row.cli, row.cwd) : terminalLike(row.cwd, row.cli));
    void sendToHost(hostId, { t: "resume", cwd: row.cwd, sessionId: row.sessionId, cli: row.cli, ...(row.wslDistro ? { wslDistro: row.wslDistro } : {}), ...(row.profile ? { profile: row.profile } : {}), view: agent.view });
  };

  const newSession = (cli: AgentCli) => {
    expectNewTab(hostId, chatLike(cli, cwd));
    void sendToHost(hostId, { t: "newchat", cli, cwd, ...(agent.profile != null ? { profile: agent.profile } : {}) });
  };
  const pickAgent = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const items: ContextMenuItem[] = AGENT_CLIS.map((cli) => ({ label: CLI_INFO[cli].label, icon: agentCliIcon(cli), onSelect: () => newSession(cli) }));
    show(rect.left, rect.top - 4 - items.length * 30, items);
  };

  return (
    <div className="agent-history">
      <label className="agent-history-search">
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
          <circle cx="7" cy="7" r="4.2" />
          <path d="M10.2 10.2l3.3 3.3" />
        </svg>
        <input type="text" value={query} placeholder={t("history.search")} aria-label={t("history.search")} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="agent-history-listwrap">
        {!mine && online && !failed && <div className="agent-history-topbar" role="progressbar" aria-busy="true" />}
        <div className="agent-history-list">
          {groups.length === 0 && (mine || failed || !online) && (
            <div className="agent-history-empty">{failed && !mine ? t("remoteHosts.history.error") : query.trim() ? t("history.noMatch") : t("history.empty")}</div>
          )}
          {groups.map((group) => (
            <section key={group.label}>
              <div className="agent-history-group">{group.label}</div>
              {group.rows.map((row) => {
                const time = timeOf(row);
                const current = !!row.sessionId && row.sessionId === agent.sessionId;
                return (
                  <button
                    key={row.key}
                    type="button"
                    className={"agent-history-row" + (current ? " is-current" : "")}
                    aria-current={current ? "true" : undefined}
                    title={`${titleOf(row)}\n${row.cwd}`}
                    disabled={!row.tabId && !canResume}
                    onClick={() => openRow(row)}
                  >
                    <span className="agent-history-icon">{agentCliIcon(row.cli)}</span>
                    <span className="agent-history-body">
                      <span className="agent-history-title">{titleOf(row)}</span>
                      <span className="agent-history-meta">
                        {time}
                        {row.status && row.status !== "idle" && (
                          <span className={`agent-history-status agent-history-status--${row.status}`}>{`${time ? " · " : ""}${row.status === "busy" ? t("agents.status.busy") : t("agents.status.waiting")}`}</span>
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
      </div>
      <div className="agent-history-footer">
        <div className="agent-history-split">
          <button type="button" className="agent-history-new" disabled={!online} onClick={() => newSession(agent.cli)}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M8 3v10M3 8h10" />
            </svg>
            {t("history.new")}
          </button>
          <button type="button" className="agent-history-caret" aria-haspopup="menu" aria-label={t("history.newPick")} title={t("history.newPick")} disabled={!online} onClick={pickAgent}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
              <path d="M4 6h8l-4 5z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
