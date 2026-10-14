/** One entry from `claude agents --json` - see src-tauri/src/agents.rs. Far
 * richer than the process-tree guess (a real session id, working directory
 * and busy/idle status) and not limited to this app's own terminals - a
 * background/headless run or a session in a completely different terminal
 * window shows up here too. Claude-specific: there's no Codex equivalent. */
export interface ClaudeAgentEntry {
  pid: number;
  cwd: string;
  kind: string;
  startedAt: number | null;
  sessionId: string;
  name: string;
  status: string;
  /** The terminal app it runs in, when recognizable. */
  hostApp: string | null;
  /** The account profile it belongs to - `null` for the default one. */
  profile: string | null;
}

/** One saved Codex CLI session read directly off disk - see
 * `list_codex_sessions` in src-tauri/src/agents.rs for why this is the best
 * Codex can offer: unlike Claude there's no live registry, so this only
 * ever represents "something resumable", never "currently running
 * elsewhere" (a local Codex tab is only ever caught by `list_agent_sessions`
 * above, same as Claude). */
export interface CodexSessionEntry {
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
  /** The account profile it belongs to - `null` for the default one. */
  profile: string | null;
}

/** One saved Mistral Vibe session, read off its `meta.json` - see
 * `list_vibe_sessions` in src-tauri/src/vibe.rs. Like Codex, Vibe keeps no
 * registry of what's running, so these are only ever "something to resume". */
export interface VibeSessionEntry {
  cwd: string;
  sessionId: string;
  /** When it last wrote. */
  startedAt: number | null;
  /** Saved by Vibe inside this WSL distro - `cwd` is then a Linux path. */
  wslDistro: string | null;
  /** The title Vibe gave it, when it has one. */
  name: string | null;
  /** The account profile it belongs to - `null` for the default one. */
  profile: string | null;
}

/** A row of the "saved" list - either CLI's, newest first. */
export type SavedSession = { cli: "codex" | "vibe"; cwd: string; sessionId: string; startedAt: number | null; wslDistro: string | null; name: string | null; profile: string | null };
