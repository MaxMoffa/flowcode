export interface TerminalHandle {
  clear: () => void;
  /** Copies the current selection to the clipboard (no-op without one). */
  copySelection: () => void;
  /** Pastes the clipboard as if typed (bracketed-paste aware). */
  paste: () => void;
  runCommand: (cmd: string) => void;
  /** Same as `runCommand`, but hides the injected command and its echo
   * entirely once the launched program redraws the prompt/title - the
   * terminal's on-screen content doesn't show the typed line at all. Meant
   * for shortcuts that launch a full-screen CLI (Claude Code, Codex), not
   * for arbitrary user-defined `runCommand` plugins where the typed command
   * is expected to stay visible. */
  runCommandSilently: (cmd: string) => void;
  /** Types a `cd` (built for the shell at the prompt - see shellDialect.ts's
   * `cdCommand`), but hides it and its echo entirely - the terminal's
   * on-screen content doesn't change at all. `build` gets the number of rows
   * the typed line will occupy, so a shell that can (`erases`) makes the
   * command wipe those rows itself, right where the shell drew them. */
  navigateSilently: (build: (eraseRows: number) => string | null, erases: boolean) => void;
  /** The backend pty session id for this tab's shell, once spawned - lets
   * the Agents sidebar match a `list_agent_sessions` result back to the tab
   * that owns it. `null` before the pty has finished spawning. */
  getPtyId: () => string | null;
  /** Plain text of the last `lines` non-empty rows on screen (the bottom of
   * the active buffer's viewport upwards) - what a full-screen CLI is
   * showing right now, e.g. its "usage limit reached" notice. */
  screenTail: (lines: number) => string;
  /** Types `data` into this tab's pty exactly like a keystroke would, so an
   * Enter in it counts as a submit (see ptyClient's `lastSubmitAt`). */
  sendInput: (data: string) => void;
  /** This tab's normal-screen text (with colors) for session restore - the
   * last `SESSION_SCROLLBACK_LINES` lines, never a full-screen program's
   * alternate screen (that frame means nothing once the program is gone). */
  serialize: () => string;
  /** Whether anything was ever sent to this tab's shell on the user's
   * behalf - typed/pasted input, a command run in it, an explorer `cd`.
   * A tab that's still `false` at exit is a virgin one (opened, never
   * touched), which session restore doesn't bring back. */
  wasUsed: () => boolean;
  /** Hands this tab's running session over for a move to another window:
   * stops its output reaching this terminal (the program keeps running),
   * then snapshots the screen exactly as shown - scrollback, a full-screen
   * program's alternate screen and the terminal modes it set. Once released,
   * unmounting this view no longer kills the session. `null` when there's no
   * session yet to move. */
  release: () => Promise<TerminalTransfer | null>;
  /** The screen exactly as shown (scrollback, alternate screen, modes) for a
   * remote client, without detaching anything, plus the `seq` of the last
   * output written here so the client can skip what the snapshot covers. */
  snapshotForRemote: () => Promise<{ data: string; seq: number } | null>;
  /** A phone is showing this terminal and has sized the pty for its screen
   * (see remote.rs): the grid is pinned to `size` and the usual fit is
   * skipped. `null` hands control back - the terminal refits and resizes the
   * pty to its own size again. Synchronous, so the snapshot request that
   * follows is taken at the pinned size. */
  setSizeOverride: (size: { cols: number; rows: number } | null) => void;
}

/** A running terminal session on its way to another window - see
 * `TerminalHandle.release` and the `attach` prop. */
export interface TerminalTransfer {
  ptyId: string;
  snapshot: string;
}

/** Where a terminal's prompt row is on screen (viewport pixels). */
export interface PromptAnchor {
  left: number;
  top: number;
  cellHeight: number;
}
