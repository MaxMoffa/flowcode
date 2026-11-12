import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AGENT_CLIS, type AgentCli } from "../../shared/agentRegistry";
import { buildHistoryRows, filterRows, groupByDay, type HistoryEntries, type HistoryRow, type OpenSession } from "../../src/agents/historyRows";
import { historyRequest, resumeSession } from "./gitRemote";
import { t, speechLocale } from "./i18n";
import { AgentLogo, PlusIcon, RefreshIcon } from "./icons";
import { send, showToast, useRemoteSelector } from "./remote";
import "./wide-history.css";

const POLL_MS = 15_000;
const CLI_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", vibe: "Vibe", gemini: "Gemini", opencode: "OpenCode" };
const isAgentCli = (cli: string | undefined): cli is AgentCli => !!cli && (AGENT_CLIS as readonly string[]).includes(cli);
const statusOf = (s: string | undefined): "busy" | "waiting" | "idle" | undefined => (s === "busy" || s === "waiting" ? s : s === "exited" ? undefined : "idle");

/** Short "5m" / "3h" / "2d" age of a time in ms; "now" under a minute. */
function ageOf(at: number): string {
  if (at <= 0) return "";
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return t("whHistNow");
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const EMPTY: HistoryEntries = { claude: [], codex: [], vibe: [], opencode: [] };

/** The phone's History tab of the wide sidebar: the sessions of the project at `cwd`, saved ones from the desktop plus those open in a chat or terminal tab. */
export function WideHistory({ cwd, cli, profile, currentSessionId, view, visible, onOpenChat, onOpenPty }: {
  cwd: string | null;
  cli: string;
  profile?: string | null;
  currentSessionId?: string | null;
  /** The kind of tab the list is shown for: a saved session picked here opens the same way. */
  view?: "chat" | "terminal";
  visible: boolean;
  onOpenChat: (chatId: string) => void;
  onOpenPty: (ptyId: string) => void;
}) {
  const chats = useRemoteSelector((r) => r.chats);
  const tabs = useRemoteSelector((r) => r.tabs);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<{ cwd: string; roots: string[]; entries: HistoryEntries } | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [, tick] = useState(0);
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!cwd) return;
    const id = ++seq.current;
    setLoading(true);
    historyRequest(cwd)
      .then((r) => {
        if (id !== seq.current) return;
        setError(false);
        setData({
          cwd,
          roots: r.roots.length > 0 ? r.roots : [cwd],
          entries: {
            claude: r.claude as HistoryEntries["claude"],
            codex: r.codex as HistoryEntries["codex"],
            vibe: r.vibe as HistoryEntries["vibe"],
            opencode: r.opencode as HistoryEntries["opencode"],
          },
        });
      })
      // The last result stays on screen; the error only shows when there is none.
      .catch(() => id === seq.current && setError(true))
      .finally(() => id === seq.current && setLoading(false));
  }, [cwd]);

  useEffect(() => {
    if (!visible || !cwd) return;
    load();
    const timer = setInterval(() => {
      load();
      tick((n) => n + 1);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      seq.current++;
    };
  }, [visible, cwd, load]);

  // Another folder: nothing of the previous one stays.
  const mine = data && data.cwd === cwd ? data : null;

  const rows = useMemo(() => {
    if (!cwd) return [];
    const roots = mine?.roots ?? [cwd];
    const open: OpenSession[] = [];
    for (const c of chats ?? []) {
      if (!isAgentCli(c.agent)) continue;
      open.push({ cli: c.agent, sessionId: c.sessionId ?? "", title: c.label, cwd: c.cwd, wslDistro: null, profile: c.profile ?? null, tabId: `c:${c.chatId}`, status: statusOf(c.status), at: null });
    }
    // A terminal agent has no session id here: it is listed as its own row.
    for (const x of tabs ?? []) {
      if (!isAgentCli(x.cli)) continue;
      open.push({ cli: x.cli, sessionId: "", title: x.label, cwd: x.cwd, wslDistro: null, profile: x.profile ?? null, tabId: `p:${x.ptyId}`, status: statusOf(x.status), at: null });
    }
    return buildHistoryRows({ entries: mine?.entries ?? EMPTY, roots, open });
  }, [mine, cwd, chats, tabs]);

  const titleOf = (row: HistoryRow) => row.title || `${CLI_LABEL[row.cli] ?? row.cli} · ${row.sessionId.slice(0, 8)}`;
  const shown = filterRows(rows, query, titleOf);
  const groups = groupByDay(shown, (day) =>
    day === "open" ? t("whHistOpenGroup") : day === "today" ? t("whHistToday") : day === "yesterday" ? t("whHistYesterday") : new Date(day).toLocaleDateString(speechLocale(), { day: "numeric", month: "long" }),
  );

  const openRow = (row: HistoryRow) => {
    if (row.tabId?.startsWith("c:")) return onOpenChat(row.tabId.slice(2));
    if (row.tabId?.startsWith("p:")) return onOpenPty(row.tabId.slice(2));
    resumeSession({ cwd: row.cwd, sessionId: row.sessionId, cli: row.cli, wslDistro: row.wslDistro, profile: row.profile, view });
    showToast(t("whHistResuming"));
  };
  const newSession = () => {
    if (!cwd) return;
    send({ t: "newchat", cli, cwd, ...(profile != null ? { profile } : {}) });
  };

  const empty = !cwd ? t("whHistNoFolder") : error && !mine ? t("whHistError") : query.trim() ? t("whHistNoMatch") : t("whHistEmpty");

  return (
    <div className="whh">
      <div className="whh-bar">
        <label className="whh-search">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2l3.3 3.3" />
          </svg>
          <input type="text" value={query} placeholder={t("whHistSearch")} aria-label={t("whHistSearch")} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button type="button" className={"whh-refresh" + (loading ? " is-loading" : "")} aria-label={t("whHistRefresh")} title={t("whHistRefresh")} disabled={!cwd} onClick={load}>
          <RefreshIcon />
        </button>
      </div>
      <div className="whh-list">
        {groups.length === 0 && <div className={"whh-empty" + (error && !mine ? " is-error" : "")}>{empty}</div>}
        {groups.map((group) => (
          <section key={group.label}>
            <div className="whh-group">{group.label}</div>
            {group.rows.map((row) => {
              const current = !!row.sessionId && row.sessionId === currentSessionId;
              const age = ageOf(row.at);
              const live = row.status && row.status !== "idle" ? (row.status === "busy" ? t("whHistBusy") : t("whHistWaiting")) : "";
              return (
                <button key={row.key} type="button" className={"whh-row" + (current ? " is-current" : "")} aria-current={current ? "true" : undefined} title={`${titleOf(row)}\n${row.cwd}`} onClick={() => openRow(row)}>
                  <span className="whh-icon"><AgentLogo cli={row.cli} size={18} /></span>
                  <span className="whh-body">
                    <span className="whh-title">{titleOf(row)}</span>
                    <span className="whh-meta">
                      {age}
                      {row.tabId && <>{age ? " · " : ""}{t("whHistOpen")}</>}
                      {live && <span className={`whh-status whh-status--${row.status}`}>{` · ${live}`}</span>}
                    </span>
                  </span>
                  {row.tabId && <span className={`whh-dot whh-dot--${row.status ?? "idle"}`} aria-hidden="true" />}
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <div className="whh-footer">
        <button type="button" className="whh-new" disabled={!cwd} onClick={newSession}>
          <PlusIcon />
          {t("whHistNew")}
        </button>
      </div>
    </div>
  );
}
