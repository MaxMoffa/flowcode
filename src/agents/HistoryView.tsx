import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { agentCliIcon } from "../plugins/icons";
import { useI18n } from "../i18n";
import { relativeCommitTime } from "../lib/time";
import { seenRowKeys } from "./historyStore";
import { filterRows, groupByDay, type HistoryRow } from "./historyRows";
import { AGENT_CLIS, CLI_INFO, cliName, type AgentCli } from "./cliInfo";
import { ProfileSelect } from "../profiles/ProfileSelect";
import { useOutsideClose } from "../hooks/useOutsideClose";
import type { DelegateChild } from "./delegateHistory";
import { historyDot, TONE_LABEL, delegateTone } from "./delegateView";
import type { HistoryItem } from "./historyDelete";
import { useContextMenu, type ContextMenuItem } from "../context-menu/ContextMenuContext";
import { MenuIcons } from "../context-menu/menuIcons";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { HistoryToast, MORE_ICON, RowMore, useUndoDelete } from "./historyDeleteUi";
import "./agent-history.css";

/** Nothing arrived for this long: ghost rows appear (a faster answer shows no flash). */
const GHOST_DELAY_MS = 150;
const GHOST_ROWS = 8;

const isAgentCli = (cli: string): cli is AgentCli => (AGENT_CLIS as readonly string[]).includes(cli);

/** A saved chat on its way out: what the backend needs, its hidden-row key, and whether it had delegated chats. */
export interface DeleteEntry {
  item: HistoryItem;
  key: string;
  orchestrator?: boolean;
}

/** The store of rows hidden from the list after a delete (local, or one PC's). */
export interface HiddenRowsStore {
  use: () => ReadonlySet<string>;
  get: () => ReadonlySet<string>;
  hide: (keys: string[]) => void;
  unhide: (keys: string[]) => void;
}

export interface HistoryViewProps {
  /** Saved + open sessions, before the hidden rows are taken out. */
  rows: HistoryRow[];
  /** The first load is still on its way: progress bar, ghost rows, counts, rise animation. */
  pending: boolean;
  /** Shown instead of the empty text when the list is empty and not pending. */
  error?: string;
  projectCwd: string;
  currentSessionId?: string;
  hidden: HiddenRowsStore;
  /** The hidden-row key of a chat. */
  keyOf: (cli: string, sessionId: string) => string;
  openRow: (row: HistoryRow) => void;
  /** `false` disables the row (default: all open). */
  canOpen?: (row: HistoryRow) => boolean;
  /** Deletes for good; resolves with the session ids that failed. Absent: no delete, no row menus. */
  deleteItems?: (items: HistoryItem[]) => Promise<Set<string>>;
  /** Delete entries are disabled (e.g. the PC is offline). */
  deleteDisabled?: boolean;
  /** After a delete finished: what went through and what failed (those are back in the list). */
  onDeleted?: (done: DeleteEntry[], failed: DeleteEntry[]) => void;
  /** Absent: no "Show in file manager". */
  reveal?: (item: HistoryItem) => Promise<unknown>;
  /** Absent: no delegated chats under the rows. */
  delegates?: {
    kidsOf: (row: HistoryRow) => DelegateChild[];
    childLive: (child: DelegateChild) => boolean;
    openChild: (row: HistoryRow, child: DelegateChild) => void;
  };
  branchOf?: (cwd: string) => string | null;
  newSession: {
    currentCli: AgentCli;
    clis: readonly AgentCli[];
    /** The profile "New session" runs under; `currentProfileId` is the one ticked in the list. */
    profileId: string | undefined;
    currentProfileId: string | undefined;
    /** Shows the profile select in the menu. */
    profilePicker: boolean;
    onProfileChange?: (profileId: string | undefined) => void;
    onNew: (cli: AgentCli, profileId: string | undefined) => void;
    disabled?: boolean;
  };
}

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

/** The History list of one project, local or on another PC: search, day groups, row menus, delete with undo, "New session". */
export function HistoryView({
  rows,
  pending,
  error,
  projectCwd,
  currentSessionId,
  hidden,
  keyOf,
  openRow,
  canOpen,
  deleteItems,
  deleteDisabled,
  onDeleted,
  reveal,
  delegates,
  branchOf,
  newSession,
}: HistoryViewProps) {
  const { t, language } = useI18n();
  const { show: showMenu } = useContextMenu();
  const confirm = useConfirmDialog();
  const [query, setQuery] = useState("");
  /** Orchestrator sessions whose delegated chats are listed under them. */
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const footerRef = useRef<HTMLDivElement>(null);
  // The profile list is portaled to the body, so it counts as inside.
  useOutsideClose(menuOpen, [footerRef], () => setMenuOpen(false), { escape: true, ignore: (el) => !!el.closest("[data-profile-select-menu]") });

  // Deleted rows stay out of the list even while the backend lists still carry them.
  const { use: useHiddenRows } = hidden;
  const hiddenRows = useHiddenRows();
  const visibleRows = useMemo(() => rows.filter((row) => !hiddenRows.has(keyOf(row.cli, row.sessionId))), [rows, hiddenRows, keyOf]);

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
  const kidsOf = (row: HistoryRow) =>
    delegates && row.sessionId ? delegates.kidsOf(row).filter((c) => !hiddenRows.has(keyOf(c.agent, c.childSessionId))) : [];
  const hasDelegates = shown.some((row) => kidsOf(row).length > 0);
  const toggleKids = (sessionId: string) =>
    setUnfolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(sessionId)) next.add(sessionId);
      return next;
    });
  const rowEnabled = (row: HistoryRow) => (canOpen ? canOpen(row) : true);

  // ---- deleting ----
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

  /** Deletes for good, takes failures back into the list. `onFailed` gets how many could not be deleted. */
  const deleteEntries = async (entries: DeleteEntry[], onFailed: (count: number) => void) => {
    if (!deleteItems || entries.length === 0) return;
    let failedIds: Set<string>;
    try {
      failedIds = await deleteItems(entries.map((e) => e.item));
    } catch {
      failedIds = new Set(entries.map((e) => e.item.sessionId));
    }
    const failed = entries.filter((e) => failedIds.has(e.item.sessionId));
    const done = entries.filter((e) => !failedIds.has(e.item.sessionId));
    hidden.unhide(failed.map((e) => e.key));
    onDeleted?.(done, failed);
    if (failed.length > 0) onFailed(failed.length);
  };
  const { toast, batch, showError, reportFailed, flush: flushBatch, queue: queueDelete, undo: undoDelete } = useUndoDelete<DeleteEntry>({
    hide: hidden.hide,
    unhide: hidden.unhide,
    commit: deleteEntries,
  });

  const entryOf = (cli: string, sessionId: string, profile: string | null, wslDistro: string | null): DeleteEntry => ({ item: { cli, sessionId, profile, wslDistro }, key: keyOf(cli, sessionId) });
  /** A row with the delegated chats that go with it. */
  const entriesOfRow = (row: HistoryRow): DeleteEntry[] => {
    const kids = kidsOf(row).filter((c) => !delegates?.childLive(c));
    const own = { ...entryOf(row.cli, row.sessionId, row.profile, row.wslDistro), orchestrator: kidsOf(row).length > 0 };
    return [own, ...kids.map((c) => entryOf(c.agent, c.childSessionId, c.agent === row.cli ? row.profile : null, row.wslDistro))];
  };

  const copyId = (id: string) => void navigator.clipboard.writeText(id).catch(() => {});
  /** Menu of one saved chat: `open` is what a click on the row does. */
  const chatMenu = (open: { label: string; run: () => void; disabled?: boolean }, entry: DeleteEntry, toDelete: DeleteEntry[] | null): ContextMenuItem[] => [
    { label: open.label, icon: MenuIcons.openExternal, disabled: open.disabled, onSelect: open.run },
    ...(reveal
      ? [{ label: t("history.menu.reveal"), icon: MenuIcons.folder, disabled: !entry.item.sessionId, onSelect: () => void reveal(entry.item).catch(() => showError(t("history.reveal.failed"))) }]
      : []),
    { label: t("history.menu.copyId"), icon: MenuIcons.duplicate, disabled: !entry.item.sessionId, onSelect: () => copyId(entry.item.sessionId) },
    { label: "history-menu-separator", separator: true },
    toDelete
      ? { label: t("history.menu.delete"), icon: MenuIcons.trash, danger: true, disabled: deleteDisabled, onSelect: () => queueDelete(toDelete) }
      : { label: t("history.menu.deleteOpen"), icon: MenuIcons.trash, danger: true, disabled: true },
  ];
  const rowMenu = (row: HistoryRow) => {
    const entries = entriesOfRow(row);
    const canDelete = !row.tabId && !!row.sessionId;
    return chatMenu({ label: t(row.tabId ? "history.menu.goToTab" : "history.menu.resume"), run: () => openRow(row), disabled: !rowEnabled(row) }, entries[0], canDelete ? entries : null);
  };
  const childMenu = (row: HistoryRow, child: DelegateChild) => {
    const entry = entryOf(child.agent, child.childSessionId, child.agent === row.cli ? row.profile : null, row.wslDistro);
    const live = delegates?.childLive(child) ?? false;
    const label = t(live ? "history.menu.goToTab" : "history.menu.resume");
    return chatMenu({ label, run: () => delegates?.openChild(row, child) }, entry, live || !child.childSessionId ? null : [entry]);
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
    const fresh = entries.filter((e) => !hidden.get().has(e.key));
    hidden.hide(fresh.map((e) => e.key));
    void deleteEntries(fresh, reportFailed);
  };
  const toolsMenu = (rect: DOMRect) =>
    openAt("tools", [{ label: t("history.clear.menu"), icon: MenuIcons.trash, danger: true, disabled: deleteDisabled || clearEntries.length === 0, onSelect: () => void clearProject() }], rect);

  const timeOf = (row: HistoryRow) => {
    if (row.at <= 0) return "";
    return Date.now() - row.at < 60_000 ? t("history.now") : relativeCommitTime(row.at / 1000);
  };

  const ns = newSession;
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
        {deleteItems && (
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
      {pending && <div className="agent-history-topbar" role="progressbar" aria-busy="true" />}
      <div className={"agent-history-list" + (hasDelegates ? " has-delegates" : "")}>
        {groups.length === 0 && !pending && <div className="agent-history-empty">{error ?? (needle ? t("history.noMatch") : t("history.empty"))}</div>}
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
              const branch = branchOf?.(row.cwd) ?? null;
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
                  disabled={!rowEnabled(row)}
                  onClick={() => openRow(row)}
                  onContextMenu={deleteItems ? onRowContext(row.key, () => rowMenu(row)) : undefined}
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
                  {deleteItems && <RowMore label={t("history.menu.more")} onOpen={(rect) => openAt(row.key, rowMenu(row), rect)} />}
                </button>
                {unfoldedKids && (
                  <div className="agent-history-kids">
                    {kids.map((child) => (
                      <button
                        key={child.taskId}
                        type="button"
                        className={"agent-history-row is-child" + (menuKey === `child:${child.taskId}` ? " is-menu-open" : "")}
                        title={child.title}
                        onClick={() => delegates?.openChild(row, child)}
                        onContextMenu={deleteItems ? onRowContext(`child:${child.taskId}`, () => childMenu(row, child)) : undefined}
                      >
                        <span className="agent-history-icon">{agentCliIcon(child.agent)}</span>
                        <span className="agent-history-body">
                          <span className="agent-history-title">{child.title || cliName(child.agent)}</span>
                          <span className="agent-history-meta">{`${cliName(child.agent)} · ${t(TONE_LABEL[delegateTone(child.status)])}`}</span>
                        </span>
                        <span className={`agent-history-dot agent-history-dot--${historyDot(child.status)}`} aria-hidden="true" />
                        {deleteItems && <RowMore label={t("history.menu.more")} onOpen={(rect) => openAt(`child:${child.taskId}`, childMenu(row, child), rect)} />}
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
              {ns.profilePicker && <ProfileSelect value={ns.profileId} onChange={(next) => ns.onProfileChange?.(next)} />}
            </div>
            {ns.clis.length === 0 && <div className="agent-history-newmenu-empty">{t("history.noAgents")}</div>}
            {ns.clis.map((cli) => (
              <button
                key={cli}
                type="button"
                role="menuitem"
                className="agent-history-newmenu-item"
                onClick={() => {
                  setMenuOpen(false);
                  ns.onNew(cli, ns.profileId);
                }}
              >
                <span className="agent-history-newmenu-icon">{agentCliIcon(cli)}</span>
                <span>{CLI_INFO[cli].label}</span>
                {cli === ns.currentCli && ns.profileId === ns.currentProfileId && (
                  <svg className="agent-history-newmenu-check" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="agent-history-split">
          <button type="button" className="agent-history-new" disabled={ns.disabled} onClick={() => ns.onNew(ns.currentCli, ns.profileId)}>
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
            disabled={ns.disabled}
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
