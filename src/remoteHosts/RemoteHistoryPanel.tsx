import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { agentCliIcon } from "../plugins/icons";
import { useI18n } from "../i18n";
import { relativeCommitTime } from "../lib/time";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { AGENT_CLIS, CLI_INFO, type AgentCli } from "../agents/cliInfo";
import { buildHistoryRows, filterRows, groupByDay, type HistoryEntries, type HistoryRow, type OpenSession } from "../agents/historyRows";
import { chatKey, ptyKey } from "../../shared/remoteEntries";
import { MenuIcons } from "../context-menu/menuIcons";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { HistoryToast, MORE_ICON, RowMore, useUndoDelete } from "../agents/historyDeleteUi";
import type { HistoryItem } from "../agents/historyDelete";
import { getRemoteHiddenRows, hideRemoteRows, remoteHiddenKey, remoteHistoryDelete, unhideRemoteRows, useRemoteHiddenRows } from "./remoteHistoryDelete";
import { hostRequest } from "./hostRequest";
import { chatLike, expectNewTab, terminalLike, selectRemoteKey, sendToHost, useHost, useHostState } from "./remoteHosts";
import "../agents/agent-history.css";

const POLL_MS = 15_000;
const EMPTY: HistoryEntries = { claude: [], codex: [], vibe: [], opencode: [], cline: [] };
const isAgentCli = (cli: string | undefined): cli is AgentCli => !!cli && (AGENT_CLIS as readonly string[]).includes(cli);
const statusOf = (s: string | undefined): "busy" | "waiting" | "idle" | undefined => (s === "busy" || s === "waiting" ? s : s === "exited" ? undefined : "idle");

/** A saved chat on its way out: what the host needs and its per-host hidden-row key. */
interface DeleteEntry {
  item: HistoryItem;
  key: string;
}

/** Deletes on the PC for good; failures (also chats it has open) come back into the list. */
async function deleteEntries(hostId: string, entries: DeleteEntry[], onFailed: (count: number) => void) {
  if (entries.length === 0) return;
  let failedIds: Set<string>;
  try {
    const res = await remoteHistoryDelete(hostId, entries.map((e) => e.item));
    failedIds = new Set(res.failed.map((f) => f.sessionId));
  } catch {
    failedIds = new Set(entries.map((e) => e.item.sessionId));
  }
  const failed = entries.filter((e) => failedIds.has(e.item.sessionId));
  unhideRemoteRows(failed.map((e) => e.key));
  if (failed.length > 0) onFailed(failed.length);
}

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
  const confirm = useConfirmDialog();
  const host = useHost(hostId);
  const { chats, tabs } = useHostState(hostId);
  const { cwd } = agent;
  const canResume = !!host?.caps.includes("resume");
  const canDelete = !!host?.caps.includes("historyDelete");
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

  const hidden = useRemoteHiddenRows();
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
    const all = buildHistoryRows({ entries: mine?.entries ?? EMPTY, roots: mine?.roots ?? [cwd], open });
    return all.filter((r) => !!r.tabId || !hidden.has(remoteHiddenKey(hostId, `${r.cli}:${r.sessionId}`)));
  }, [mine, cwd, chats, tabs, hidden, hostId]);

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

  // ---- deleting (on the other PC; chats open in one of its tabs are never deleted) ----
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
  const entryOf = (row: HistoryRow): DeleteEntry => ({ item: { cli: row.cli, sessionId: row.sessionId, profile: row.profile, wslDistro: row.wslDistro }, key: remoteHiddenKey(hostId, `${row.cli}:${row.sessionId}`) });
  const hostRef = useRef(hostId);
  hostRef.current = hostId;
  const { toast, batch, reportFailed, flush, queue, undo } = useUndoDelete<DeleteEntry>({
    hide: hideRemoteRows,
    unhide: unhideRemoteRows,
    commit: (entries, onFailed) => deleteEntries(hostRef.current, entries, onFailed),
  });
  const copyId = (id: string) => void navigator.clipboard.writeText(id).catch(() => {});
  const rowMenu = (row: HistoryRow): ContextMenuItem[] => [
    { label: t(row.tabId ? "history.menu.goToTab" : "history.menu.resume"), icon: MenuIcons.openExternal, disabled: !row.tabId && !canResume, onSelect: () => openRow(row) },
    { label: t("history.menu.copyId"), icon: MenuIcons.duplicate, disabled: !row.sessionId, onSelect: () => copyId(row.sessionId) },
    { label: "history-menu-separator", separator: true },
    !row.tabId && row.sessionId
      ? { label: t("history.menu.delete"), icon: MenuIcons.trash, danger: true, disabled: !online, onSelect: () => queue([entryOf(row)]) }
      : { label: t("history.menu.deleteOpen"), icon: MenuIcons.trash, danger: true, disabled: true },
  ];
  const openAt = (key: string, items: ContextMenuItem[], at: { x: number; y: number } | DOMRect) => {
    setMenuKey(key);
    if (at instanceof DOMRect) show(at.right - 200, at.bottom + 4, items);
    else show(at.x, at.y, items);
  };
  /** Every saved chat of the list (not the open ones). */
  const clearEntries = shown.filter((row) => !row.tabId && row.sessionId).map(entryOf);
  const clearProject = async () => {
    const entries = clearEntries;
    if (entries.length === 0) return;
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e.item.cli, (counts.get(e.item.cli) ?? 0) + 1);
    const breakdown = [...counts].map(([cli, n]) => `${isAgentCli(cli) ? CLI_INFO[cli].label : cli} ${n}`).join(", ");
    const project = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || cwd;
    const ok = await confirm({
      title: t("history.clear.title", { project }),
      message: t("history.clear.message", { count: entries.length, breakdown }),
      confirmLabel: t("history.clear.confirm", { count: entries.length }),
      danger: true,
    });
    if (!ok) return;
    // The pending single deletes go first, then these - no undo.
    if (batch.current.length > 0) flush();
    const fresh = entries.filter((e) => !getRemoteHiddenRows().has(e.key));
    hideRemoteRows(fresh.map((e) => e.key));
    void deleteEntries(hostId, fresh, reportFailed);
  };
  const toolsMenu = (rect: DOMRect) =>
    openAt("tools", [{ label: t("history.clear.menu"), icon: MenuIcons.trash, danger: true, disabled: !online || clearEntries.length === 0, onSelect: () => void clearProject() }], rect);

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
      <div className="agent-history-searchrow">
        <label className="agent-history-search">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
            <circle cx="7" cy="7" r="4.2" />
            <path d="M10.2 10.2l3.3 3.3" />
          </svg>
          <input type="text" value={query} placeholder={t("history.search")} aria-label={t("history.search")} onChange={(e) => setQuery(e.target.value)} />
        </label>
        {canDelete && (
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
        )}
      </div>
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
                    className={"agent-history-row" + (current ? " is-current" : "") + (menuKey === row.key ? " is-menu-open" : "")}
                    aria-current={current ? "true" : undefined}
                    title={`${titleOf(row)}\n${row.cwd}`}
                    disabled={!row.tabId && !canResume}
                    onClick={() => openRow(row)}
                    onContextMenu={
                      canDelete
                        ? (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            openAt(row.key, rowMenu(row), { x: e.clientX, y: e.clientY });
                          }
                        : undefined
                    }
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
                    {canDelete && <RowMore label={t("history.menu.more")} onOpen={(rect) => openAt(row.key, rowMenu(row), rect)} />}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        {toast && <HistoryToast toast={toast} count={batch.current.length} onUndo={undo} />}
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
