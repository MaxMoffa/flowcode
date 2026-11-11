// Pure row-building of the History list (no tauri imports): shared by the desktop panel and the phone's wide layout.
import { isRootPath, separatorOf, comparablePath, isWindowsHostPath } from "../lib/path";
import { toWslPath, wslDistroOfPath } from "../terminal/wslPathPure";
import type { AgentCli } from "../../shared/agentRegistry";
import type { ClaudeSessionEntry, CodexSessionEntry, OpencodeSessionEntry, VibeSessionEntry } from "./entryTypes";

/** Whether an agent works in the project folder or somewhere below it. An
 * agent inside WSL reports a Linux path, so the project folder is brought to
 * that form first; a folder on another machine's file system never matches.
 * A tab sitting on a root ("C:\", "/") is not a project. */
export function inProject(
  agentCwd: string | null | undefined,
  agentWslDistro: string | null | undefined,
  projectCwd: string,
  projectWslDistro: string | undefined,
): boolean {
  if (!agentCwd) return false;
  let project = projectCwd;
  if (agentWslDistro) {
    const projectDistro = wslDistroOfPath(projectCwd) ?? projectWslDistro;
    if (projectDistro && projectDistro.toLowerCase() !== agentWslDistro.toLowerCase()) return false;
    if (!project.startsWith("/")) {
      const converted = toWslPath(agentWslDistro, project);
      if (converted === null) return false;
      project = converted;
    }
  } else if (project.startsWith("/") && isWindowsHostPath(agentCwd)) {
    return false;
  }
  const a = comparablePath(agentCwd);
  const b = comparablePath(project);
  if (isRootPath(b)) return false;
  return a === b || a.startsWith(b + separatorOf(b));
}

export interface HistoryRow {
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

/** The saved sessions listed by the desktop (`list_*_sessions`). */
export interface HistoryEntries {
  claude: ClaudeSessionEntry[];
  codex: CodexSessionEntry[];
  vibe: VibeSessionEntry[];
  opencode: OpencodeSessionEntry[];
}

/** A session open in a tab: marks its saved row, or is listed on its own when not saved yet. */
export interface OpenSession {
  cli: AgentCli;
  /** "" while the agent has not reported one. */
  sessionId: string;
  title: string | null;
  cwd: string;
  wslDistro: string | null;
  profile: string | null;
  tabId: string;
  status?: "busy" | "waiting" | "idle";
  /** When it started or last wrote; `null` = now. */
  at: number | null;
}

export interface BuildRowsInput {
  entries: HistoryEntries;
  roots: string[];
  /** The project's WSL distro, when it runs inside WSL. */
  wslDistro?: string;
  open?: OpenSession[];
  /** Row keys (`cli:sessionId`) left out, e.g. delegated children. */
  exclude?: ReadonlySet<string>;
  now?: number;
}

/** The sessions of the project (any of `roots`) - saved ones plus those open in a tab - newest first, one row per session. */
export function buildHistoryRows({ entries, roots, wslDistro, open = [], exclude, now = Date.now() }: BuildRowsInput): HistoryRow[] {
  const inRoots = (cwd: string | null | undefined, distro: string | null | undefined) =>
    roots.some((root) => inProject(cwd, distro, root, wslDistro));
  const byKey = new Map<string, HistoryRow>();
  const add = (row: Omit<HistoryRow, "key">) => byKey.set(`${row.cli}:${row.sessionId}`, { ...row, key: `${row.cli}:${row.sessionId}` });
  for (const s of entries.claude) {
    if (!inRoots(s.cwd, null)) continue;
    add({ cli: "claude", sessionId: s.sessionId, title: s.title, cwd: s.cwd, at: s.updatedAt ?? s.startedAt ?? 0, profile: s.profile, wslDistro: null });
  }
  for (const [cli, list] of [["codex", entries.codex], ["vibe", entries.vibe], ["opencode", entries.opencode]] as const) {
    for (const s of list) {
      if (!inRoots(s.cwd, s.wslDistro)) continue;
      add({ cli, sessionId: s.sessionId, title: s.name, cwd: s.cwd, at: s.startedAt ?? 0, profile: s.profile, wslDistro: s.wslDistro });
    }
  }
  const live: HistoryRow[] = [];
  for (const o of open) {
    if (!inRoots(o.cwd, o.wslDistro)) continue;
    const key = `${o.cli}:${o.sessionId}`;
    const saved = o.sessionId ? byKey.get(key) : undefined;
    if (saved) {
      saved.tabId = o.tabId;
      saved.status = o.status;
    } else {
      live.push({ cli: o.cli, sessionId: o.sessionId, title: o.title, cwd: o.cwd, at: o.at ?? now, profile: o.profile, wslDistro: o.wslDistro, tabId: o.tabId, status: o.status, key: o.sessionId ? key : `tab:${o.tabId}` });
    }
  }
  // The same session can appear twice (two live tabs, or a live and a saved row): one row per key.
  const unique = new Map<string, HistoryRow>();
  for (const row of [...byKey.values(), ...live]) {
    if (exclude?.has(row.key)) continue;
    const prev = unique.get(row.key);
    if (!prev || (row.tabId !== undefined && prev.tabId === undefined) || (row.tabId !== undefined === (prev.tabId !== undefined) && row.at > prev.at)) {
      unique.set(row.key, row);
    }
  }
  return [...unique.values()].sort((a, b) => b.at - a.at);
}

/** The rows whose title contains `query` (case-insensitive); all of them for an empty query. */
export function filterRows<T extends HistoryRow>(rows: T[], query: string, titleOf: (row: T) => string): T[] {
  const needle = query.trim().toLowerCase();
  return needle ? rows.filter((row) => titleOf(row).toLowerCase().includes(needle)) : rows;
}

const dayStart = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Rows (already newest first) split into consecutive day groups; `label` receives "today", "yesterday" or the date. */
export function groupByDay<T extends HistoryRow>(
  rows: T[],
  label: (day: "today" | "yesterday" | number) => string,
  now: number = Date.now(),
): { label: string; rows: T[] }[] {
  const today = dayStart(now);
  const yesterday = dayStart(today - 1);
  const groups: { label: string; rows: T[] }[] = [];
  for (const row of rows) {
    const day = dayStart(row.at);
    const text = label(day >= today ? "today" : day === yesterday ? "yesterday" : row.at);
    const last = groups[groups.length - 1];
    if (last?.label === text) last.rows.push(row);
    else groups.push({ label: text, rows: [row] });
  }
  return groups;
}
