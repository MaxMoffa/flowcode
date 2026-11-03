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

/** One saved Claude Code conversation, read off its transcript on disk - see
 * `list_claude_sessions` in src-tauri. Unlike `ClaudeAgentEntry` it covers
 * sessions that are no longer running; newest first. */
export interface ClaudeSessionEntry {
  cwd: string;
  sessionId: string;
  /** The conversation's title, when it has one. */
  title: string | null;
  startedAt: number | null;
  /** When it last wrote. */
  updatedAt: number | null;
  /** The account profile it belongs to - `null` for the default one. */
  profile: string | null;
}
