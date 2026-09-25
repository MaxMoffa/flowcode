import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TermTab } from "../tabs/types";
import { agentCliIcon } from "../plugins/icons";
import { basename } from "../lib/path";
import "./agents-sidebar.css";

/** Mirrors the Rust `AgentSession` struct in src-tauri/src/agents.rs field
 * for field - this app doesn't use serde's camelCase renaming anywhere
 * (see FsEntry/`is_dir` for the same convention), so these stay snake_case
 * on the wire exactly as Rust wrote them. */
interface AgentSession {
  pty_id: string;
  cli: string;
  cli_label: string;
  pid: number;
  started_at: number | null;
  /** Set for an agent running inside WSL (then `pid` is a Linux pid). */
  wsl_distro: string | null;
  /** The agent's own working directory, when known (a Linux path in WSL). */
  cwd: string | null;
  /** The window and tab showing it - any window's, not just this one's. */
  window: string | null;
  tab_id: string | null;
  tab_label: string | null;
  tab_cwd: string | null;
  /** The agent's own session - id, name (as the CLI titled it, or as the
   * user renamed it) and Claude Code's busy/idle - when it could be read. */
  session_id: string | null;
  session_name: string | null;
  status: string | null;
}

const POLL_MS = 3000;
/** Saved Codex sessions listed before "Mostra altre". */
const SAVED_SESSIONS_SHOWN = 3;

function formatDuration(startedAt: number | null): string {
  if (startedAt === null) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}min` : `${hours}h`;
}

/** One entry from `claude agents --json` - see src-tauri/src/agents.rs. Far
 * richer than the process-tree guess (a real session id, working directory
 * and busy/idle status) and not limited to this app's own terminals - a
 * background/headless run or a session in a completely different terminal
 * window shows up here too. Claude-specific: there's no Codex equivalent. */
interface ClaudeAgentEntry {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number | null;
  sessionId: string;
  name: string;
  status: string;
  /** The terminal app it runs in, when recognizable. */
  hostApp: string | null;
}

/** One saved Codex CLI session read directly off disk - see
 * `list_codex_sessions` in src-tauri/src/agents.rs for why this is the best
 * Codex can offer: unlike Claude there's no live registry, so this only
 * ever represents "something resumable", never "currently running
 * elsewhere" (a local Codex tab is only ever caught by `list_agent_sessions`
 * above, same as Claude). */
interface CodexSessionEntry {
  cwd: string;
  sessionId: string;
  startedAt: number | null;
  /** Saved by Codex inside this WSL distro - `cwd` is then a Linux path. */
  wslDistro: string | null;
  /** The thread's name in Codex, when it has one. */
  name: string | null;
  /** Open right now in some terminal - `startedAt` is then its last write. */
  live: boolean;
  /** "busy" / "idle", for a live one. */
  status: string | null;
  /** Running in a Flowcode tab (of this app or another instance). */
  inFlowcode: boolean;
}

interface AgentsSidebarProps {
  /** This window's label - agents in tabs of other windows are listed
   * separately, and double-clicking one brings that window forward. */
  windowLabel: string;
  tabs: TermTab[];
  activeTabId: string;
  /** The backend pty session id behind a given tab, once its shell has
   * spawned - see TerminalHandle.getPtyId in terminal/Terminal.tsx. */
  getPtyId: (tabId: string) => string | null;
  onOpenTab: (tabId: string) => void;
  /** Opens a fresh terminal tab in `cwd` and resumes that session
   * (`claude --resume <sessionId>` / `codex resume <sessionId>`) - used for
   * a background/saved session with no local tab of its own to switch to. */
  onOpenSession: (cwd: string, sessionId: string, cli: "claude" | "codex", wslDistro?: string) => void;
  onClose: () => void;
}

/** Right-side panel, same size/structure as the left file explorer, listing
 * every terminal tab that currently has a recognized AI coding agent (Claude
 * Code, Codex CLI) running in it - see src-tauri/src/agents.rs for how a tab
 * is matched to a running agent (its shell's own process tree, not anything
 * the agent CLI itself reports - there's no API for that). Double-clicking a
 * row switches to that tab. */
const STATUS_LABELS: Record<string, string> = {
  busy: "al lavoro",
  idle: "in attesa",
};

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
  activeTabId,
  getPtyId,
  onOpenTab,
  onOpenSession,
  onClose,
}: AgentsSidebarProps) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [claudeAgents, setClaudeAgents] = useState<ClaudeAgentEntry[]>([]);
  const [codexSessions, setCodexSessions] = useState<CodexSessionEntry[]>([]);
  // Bumped every second only to re-render the running-duration text - the
  // session list itself still only refetches every POLL_MS.
  const [, setTick] = useState(0);
  const [showAllSaved, setShowAllSaved] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  // The current poll's loader, for the header's refresh button.
  const loadRef = useRef<(fresh: boolean) => Promise<unknown>>(() => Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    // `fresh`: also re-read what's normally cached between polls (the WSL
    // saved-sessions folder) - asked for by the refresh button.
    function load(fresh = false) {
      return Promise.allSettled([
        invoke<AgentSession[]>("list_agent_sessions")
          .then((result) => {
            if (!cancelled) setSessions(result);
          })
          .catch(() => {
            if (!cancelled) setSessions([]);
          }),
        // Not installed / not on PATH / old version without this subcommand
        // all resolve to the same empty list on the Rust side already - a
        // rejection here is only a genuinely unexpected failure, so just keep
        // whatever was last known instead of flashing the list empty.
        invoke<ClaudeAgentEntry[]>("list_claude_agents")
          .then((result) => {
            if (!cancelled) setClaudeAgents(result);
          })
          .catch(() => {}),
        invoke<CodexSessionEntry[]>("list_codex_sessions", { fresh })
          .then((result) => {
            if (!cancelled) setCodexSessions(result);
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

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") setTick((t) => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const localRows = (sessions ?? [])
    .map((session) => ({ session, tab: tabs.find((t) => getPtyId(t.id) === session.pty_id) }))
    .filter((row): row is { session: AgentSession; tab: TermTab } => row.tab !== undefined);
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
  const runningCodexCwds = new Set(
    allRunning.filter((s) => s.cli === "codex").flatMap((s) => [s.cwd, s.tab_cwd].filter((c): c is string => !!c)),
  );
  const runningSessionIds = new Set(allRunning.map((s) => s.session_id).filter((id): id is string => !!id));
  // Codex threads open right now in a terminal this app doesn't show (another
  // Flowcode, another terminal app) - running, not merely saved.
  const liveCodexElsewhere = codexSessions.filter((s) => s.live && !runningSessionIds.has(s.sessionId));
  const backgroundCodexSessions = codexSessions.filter((s) => !s.live && !runningCodexCwds.has(s.cwd));

  // Saved sessions are only a way back into an old chat: the latest few are
  // shown, the rest one click away, so they never crowd out what's running.
  const shownCodexSessions = showAllSaved ? backgroundCodexSessions : backgroundCodexSessions.slice(0, SAVED_SESSIONS_SHOWN);

  const loading = sessions === null;
  const isEmpty =
    !loading &&
    localRows.length === 0 &&
    otherWindowRows.length === 0 &&
    backgroundClaudeAgents.length === 0 &&
    liveCodexElsewhere.length === 0 &&
    backgroundCodexSessions.length === 0;

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
        ? { kind: status === "busy" ? "busy" : "idle", label: STATUS_LABELS[status] ?? status }
        : { kind: "running", label: "in esecuzione" },
    };
  }

  const stopButton = (ptyId: string) => (
    <button
      type="button"
      className="agents-sidebar-stop"
      title="Interrompi (invia Esc a questo agente)"
      onClick={(e) => {
        e.stopPropagation();
        interruptPty(ptyId);
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <StopIcon />
    </button>
  );

  return (
    <div className="agents-sidebar">
      <div className="agents-sidebar-header">
        <button type="button" className="agents-sidebar-close" title="Chiudi pannello" aria-label="Chiudi pannello" onClick={onClose}>
          <CloseIcon />
        </button>
        <span className="agents-sidebar-title">Agenti attivi</span>
        <button
          type="button"
          className={"agents-sidebar-close agents-sidebar-refresh" + (refreshing ? " is-refreshing" : "")}
          title="Aggiorna"
          aria-label="Aggiorna"
          disabled={refreshing}
          onClick={() => {
            setRefreshing(true);
            void loadRef.current(true).finally(() => setRefreshing(false));
          }}
        >
          <RefreshIcon />
        </button>
      </div>
      <div className="agents-sidebar-list">
        {loading && <div className="agents-sidebar-empty">Verifica in corso…</div>}
        {isEmpty && <div className="agents-sidebar-empty">Nessun agente in esecuzione.</div>}
        {localRows.map(({ session, tab }) => {
          const { name, cwd, chip } = describeRunning(session, tab.cwd);
          return (
            <AgentRow
              key={session.pty_id}
              cli={session.cli}
              name={name}
              cwd={cwd}
              terminal={tab.label}
              meta={runningMeta(session)}
              chip={chip}
              active={tab.id === activeTabId}
              hint="doppio click per aprire la scheda"
              onOpen={() => onOpenTab(tab.id)}
              action={stopButton(session.pty_id)}
            />
          );
        })}
        {otherWindowRows.length > 0 && <div className="agents-sidebar-section-label">Altre finestre</div>}
        {otherWindowRows.map((session) => {
          const { name, cwd, chip } = describeRunning(session, session.tab_cwd);
          return (
            <AgentRow
              key={session.pty_id}
              cli={session.cli}
              name={name}
              cwd={cwd}
              terminal={session.tab_label ?? ""}
              otherWindow
              meta={runningMeta(session)}
              chip={chip}
              hint="in un'altra finestra · doppio click per andarci"
              onOpen={() => focusOtherWindow(session)}
              action={stopButton(session.pty_id)}
            />
          );
        })}
        {(backgroundClaudeAgents.length > 0 || liveCodexElsewhere.length > 0) && (
          <div className="agents-sidebar-section-label">In background</div>
        )}
        {liveCodexElsewhere.map((s) => (
          <AgentRow
            key={s.sessionId}
            background
            cli="codex"
            name={s.name || basename(s.cwd)}
            cwd={s.cwd}
            terminal={s.inFlowcode ? "altra istanza di Flowcode" : "altro terminale"}
            meta={`Codex CLI${s.wslDistro ? " · WSL" : ""}`}
            chip={{ kind: s.status === "busy" ? "busy" : "idle", label: STATUS_LABELS[s.status ?? "idle"] }}
            hint="in esecuzione in un altro terminale"
            // Already open there - resuming it here too would put two
            // terminals on one thread.
            onOpen={() => {}}
          />
        ))}
        {backgroundClaudeAgents.map((agent) => (
          <AgentRow
            key={agent.sessionId}
            background
            cli="claude"
            name={agent.name || basename(agent.cwd)}
            cwd={agent.cwd}
            terminal={agent.hostApp ?? "altro terminale"}
            meta={`Claude Code${agent.startedAt !== null ? ` · ${formatDuration(agent.startedAt)}` : ""}`}
            chip={{ kind: agent.status === "busy" ? "busy" : "idle", label: STATUS_LABELS[agent.status] ?? agent.status }}
            hint="fuori da Flowcode · doppio click per riprendere la chat"
            onOpen={() => onOpenSession(agent.cwd, agent.sessionId, "claude")}
          />
        ))}
        {backgroundCodexSessions.length > 0 && <div className="agents-sidebar-section-label">Sessioni salvate</div>}
        {shownCodexSessions.map((s) => (
          <AgentRow
            key={s.sessionId}
            background
            cli="codex"
            name={s.name || basename(s.cwd)}
            cwd={s.cwd}
            meta={`Codex CLI${s.wslDistro ? ` · WSL` : ""}${s.startedAt !== null ? ` · ${formatDuration(s.startedAt)} fa` : ""}`}
            chip={{ kind: "saved", label: "salvata" }}
            hint="doppio click per riprendere la chat"
            onOpen={() => onOpenSession(s.cwd, s.sessionId, "codex", s.wslDistro ?? undefined)}
          />
        ))}
        {backgroundCodexSessions.length > SAVED_SESSIONS_SHOWN && (
          <button type="button" className="agents-sidebar-more" onClick={() => setShowAllSaved((v) => !v)}>
            {showAllSaved ? "Mostra meno" : `Mostra altre ${backgroundCodexSessions.length - SAVED_SESSIONS_SHOWN}`}
          </button>
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
  /** CLI, WSL, how long - the small print after the terminal. */
  meta: string;
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
function AgentRow({ cli, name, cwd, terminal, otherWindow, meta, chip, active, background, hint, onOpen, action }: AgentRowProps) {
  return (
    <div
      className={
        "agents-sidebar-row" + (active ? " is-active" : "") + (background ? " agents-sidebar-row--background" : "")
      }
      onDoubleClick={onOpen}
      title={`${name}\n${cwd}\n${hint}`}
    >
      <span className="agents-sidebar-icon">{agentCliIcon(cli)}</span>
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
              title={otherWindow ? "Scheda di un'altra finestra" : "Scheda in cui è aperto"}
            >
              {otherWindow ? <WindowIcon /> : <TerminalIcon />}
              <span className="agents-sidebar-terminal-label">{terminal}</span>
            </span>
          )}
          <span className="agents-sidebar-meta-text">{meta}</span>
        </span>
      </div>
      <StatusChip kind={chip.kind} label={chip.label} />
      {action}
    </div>
  );
}

/** "Codex CLI · WSL · 5 min" - the CLI, where it runs, and for how long. */
function runningMeta(session: AgentSession): string {
  return (
    session.cli_label +
    (session.wsl_distro ? " · WSL" : "") +
    (session.started_at !== null ? ` · ${formatDuration(session.started_at)}` : "")
  );
}

function StatusChip({ kind, label }: { kind: string; label: string }) {
  return <span className={`agents-sidebar-chip agents-sidebar-chip--${kind}`}>{label}</span>;
}

function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <polyline points="7 9.5 10.5 12.5 7 15.5" />
    </svg>
  );
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

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
