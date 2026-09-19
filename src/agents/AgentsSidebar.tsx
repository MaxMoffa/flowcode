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

interface AgentsSidebarProps {
  tabs: TermTab[];
  activeTabId: string;
  /** The backend pty session id behind a given tab, once its shell has
   * spawned - see TerminalHandle.getPtyId in terminal/Terminal.tsx. */
  getPtyId: (tabId: string) => string | null;
  onOpenTab: (tabId: string) => void;
}

/** Right-side panel, same size/structure as the left file explorer, listing
 * every terminal tab that currently has a recognized AI coding agent (Claude
 * Code, Codex CLI) running in it - see src-tauri/src/agents.rs for how a tab
 * is matched to a running agent (its shell's own process tree, not anything
 * the agent CLI itself reports - there's no API for that). Double-clicking a
 * row switches to that tab. */
export function AgentsSidebar({ tabs, activeTabId, getPtyId, onOpenTab }: AgentsSidebarProps) {
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
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

  const rows = (sessions ?? [])
    .map((session) => ({ session, tab: tabs.find((t) => getPtyId(t.id) === session.pty_id) }))
    .filter((row): row is { session: AgentSession; tab: TermTab } => row.tab !== undefined);

  return (
    <div className="agents-sidebar">
      <div className="agents-sidebar-header">Agenti attivi</div>
      <div className="agents-sidebar-list">
        {sessions === null && <div className="agents-sidebar-empty">Verifica in corso…</div>}
        {sessions !== null && rows.length === 0 && (
          <div className="agents-sidebar-empty">Nessun agente in esecuzione nei terminali aperti.</div>
        )}
        {rows.map(({ session, tab }) => (
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
          </div>
        ))}
      </div>
    </div>
  );
}
