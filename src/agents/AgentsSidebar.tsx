import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TermTab } from "../tabs/types";
import { agentCliIcon } from "../plugins/icons";
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
}

const POLL_MS = 3000;

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
}

interface AgentsSidebarProps {
  tabs: TermTab[];
  activeTabId: string;
  /** The backend pty session id behind a given tab, once its shell has
   * spawned - see TerminalHandle.getPtyId in terminal/Terminal.tsx. */
  getPtyId: (tabId: string) => string | null;
  onOpenTab: (tabId: string) => void;
  /** Opens a fresh terminal tab in `cwd` and resumes that session
   * (`claude --resume <sessionId>` / `codex resume <sessionId>`) - used for
   * a background/saved session with no local tab of its own to switch to. */
  onOpenSession: (cwd: string, sessionId: string, cli: "claude" | "codex") => void;
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

export function AgentsSidebar({ tabs, activeTabId, getPtyId, onOpenTab, onOpenSession, onClose }: AgentsSidebarProps) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [claudeAgents, setClaudeAgents] = useState<ClaudeAgentEntry[]>([]);
  const [codexSessions, setCodexSessions] = useState<CodexSessionEntry[]>([]);
  // Bumped every second only to re-render the running-duration text - the
  // session list itself still only refetches every POLL_MS.
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    function load() {
      invoke<AgentSession[]>("list_agent_sessions")
        .then((result) => {
          if (!cancelled) setSessions(result);
        })
        .catch(() => {
          if (!cancelled) setSessions([]);
        });
      // Not installed / not on PATH / old version without this subcommand
      // all resolve to the same empty list on the Rust side already - a
      // rejection here is only a genuinely unexpected failure, so just keep
      // whatever was last known instead of flashing the list empty.
      invoke<ClaudeAgentEntry[]>("list_claude_agents")
        .then((result) => {
          if (!cancelled) setClaudeAgents(result);
        })
        .catch(() => {});
      invoke<CodexSessionEntry[]>("list_codex_sessions")
        .then((result) => {
          if (!cancelled) setCodexSessions(result);
        })
        .catch(() => {});
    }
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const localRows = (sessions ?? [])
    .map((session) => ({ session, tab: tabs.find((t) => getPtyId(t.id) === session.pty_id) }))
    .filter((row): row is { session: AgentSession; tab: TermTab } => row.tab !== undefined);

  // A Claude session already shown above (it's running in one of this app's
  // own tabs) is matched by pid and folded into that row's status instead of
  // being listed a second time - only genuinely background sessions (no
  // local tab claims that pid) get their own row.
  const localPids = new Set(localRows.filter((r) => r.session.cli === "claude").map((r) => r.session.pid));
  const backgroundClaudeAgents = claudeAgents.filter((a) => !localPids.has(a.pid));

  // Same idea for Codex, one level cruder: with no pid to match on (see
  // CodexSessionEntry above), a saved session is folded out whenever a local
  // Codex tab is already open on that exact cwd, rather than shown as a
  // second, redundant "resume" entry for the thing already running.
  const localCodexCwds = new Set(localRows.filter((r) => r.session.cli === "codex").map((r) => r.tab.cwd));
  const backgroundCodexSessions = codexSessions.filter((s) => !localCodexCwds.has(s.cwd));

  const loading = sessions === null;
  const isEmpty =
    !loading && localRows.length === 0 && backgroundClaudeAgents.length === 0 && backgroundCodexSessions.length === 0;

  return (
    <div className="agents-sidebar">
      <div className="agents-sidebar-header">
        <button type="button" className="agents-sidebar-close" title="Chiudi pannello" aria-label="Chiudi pannello" onClick={onClose}>
          <CloseIcon />
        </button>
        Agenti attivi
      </div>
      <div className="agents-sidebar-list">
        {loading && <div className="agents-sidebar-empty">Verifica in corso…</div>}
        {isEmpty && <div className="agents-sidebar-empty">Nessun agente in esecuzione.</div>}
        {localRows.map(({ session, tab }) => {
          const claudeInfo = session.cli === "claude" ? claudeAgents.find((a) => a.pid === session.pid) : undefined;
          const chip = claudeInfo
            ? { kind: claudeInfo.status === "busy" ? "busy" : "idle", label: STATUS_LABELS[claudeInfo.status] ?? claudeInfo.status }
            : { kind: "running", label: "in esecuzione" };
          return (
            <div
              key={session.pty_id}
              className={"agents-sidebar-row" + (tab.id === activeTabId ? " is-active" : "")}
              onDoubleClick={() => onOpenTab(tab.id)}
              title={`PID ${session.pid} · doppio click per aprire`}
            >
              <span className="agents-sidebar-icon">{agentCliIcon(session.cli)}</span>
              <div className="agents-sidebar-row-body">
                <span className="agents-sidebar-tab-label">{tab.label}</span>
                <span className="agents-sidebar-meta">
                  {session.cli_label}
                  {session.started_at !== null && ` · ${formatDuration(session.started_at)}`}
                </span>
              </div>
              <StatusChip kind={chip.kind} label={chip.label} />
              <button
                type="button"
                className="agents-sidebar-stop"
                title="Interrompi (invia Esc a questo agente)"
                onClick={(e) => {
                  e.stopPropagation();
                  interruptPty(session.pty_id);
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                <StopIcon />
              </button>
            </div>
          );
        })}
        {(backgroundClaudeAgents.length > 0 || backgroundCodexSessions.length > 0) && (
          <div className="agents-sidebar-section-label">In background</div>
        )}
        {backgroundClaudeAgents.map((agent) => (
          <div
            key={agent.sessionId}
            className="agents-sidebar-row agents-sidebar-row--background"
            onDoubleClick={() => onOpenSession(agent.cwd, agent.sessionId, "claude")}
            title={`PID ${agent.pid} · ${agent.cwd} · doppio click per riprendere la chat`}
          >
            <span className="agents-sidebar-icon">{agentCliIcon("claude")}</span>
            <div className="agents-sidebar-row-body">
              <span className="agents-sidebar-tab-label">{agent.cwd.split(/[\\/]/).pop() || agent.cwd}</span>
              <span className="agents-sidebar-meta">
                Claude Code
                {agent.startedAt !== null && ` · ${formatDuration(agent.startedAt)}`}
              </span>
            </div>
            <StatusChip kind={agent.status === "busy" ? "busy" : "idle"} label={STATUS_LABELS[agent.status] ?? agent.status} />
          </div>
        ))}
        {backgroundCodexSessions.map((s) => (
          <div
            key={s.sessionId}
            className="agents-sidebar-row agents-sidebar-row--background"
            onDoubleClick={() => onOpenSession(s.cwd, s.sessionId, "codex")}
            title={`${s.cwd} · doppio click per riprendere la chat`}
          >
            <span className="agents-sidebar-icon">{agentCliIcon("codex")}</span>
            <div className="agents-sidebar-row-body">
              <span className="agents-sidebar-tab-label">{s.cwd.split(/[\\/]/).pop() || s.cwd}</span>
              <span className="agents-sidebar-meta">
                Codex CLI
                {s.startedAt !== null && ` · ${formatDuration(s.startedAt)}`}
              </span>
            </div>
            <StatusChip kind="saved" label="salvata" />
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusChip({ kind, label }: { kind: string; label: string }) {
  return <span className={`agents-sidebar-chip agents-sidebar-chip--${kind}`}>{label}</span>;
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
