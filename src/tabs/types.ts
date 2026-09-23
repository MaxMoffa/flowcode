export interface TermTab {
  kind: "terminal";
  id: string;
  /** The shell's real working directory, tracked from its prompt (OSC title). */
  cwd: string;
  /** The folder browsed in the sidebar for this tab - starts in sync with
   * `cwd` but can be navigated independently without typing into the shell. */
  explorerPath: string;
  label: string;
  customLabel?: boolean;
  /** Whether a full-screen program (an alternate-screen app: Claude Code,
   * Codex, vim, htop...) currently owns this tab's shell - see
   * `onBusyChange` in Terminal.tsx. */
  busy?: boolean;
  /** Set when this tab's shell has handed control to something whose title
   * updates can't be trusted as a real `cd` - either the user's own typed
   * command line looking like a shell-inside-the-shell (`wsl`, `ssh`,
   * `docker exec/run -it`, see App.tsx's `handleCommandLine`) or Claude
   * Code/Codex being launched (typed or via a shortcut, see
   * `checkCliAndMaybeLaunch`). `"wsl"` gets its cwd/explorerPath translated
   * through the `\\wsl.localhost\<distro>\...` UNC path so the explorer can
   * actually browse it; `"remote"` (ssh/docker, a filesystem this app has no
   * way to read) and `"agent"` (claude/codex - a filesystem this app *can*
   * read, but whose own title/console noise while it owns the screen isn't a
   * real cwd) both just freeze cwd/explorerPath in place instead of
   * following a title update into a meaningless local path, and skip
   * click-to-`cd` (typing into either one's stdin would just be garbage
   * input). Cleared the moment a title update reports a normal Windows path
   * again. */
  nestedShell?: "wsl" | "remote" | "agent";
  /** Only set for `nestedShell: "wsl"` - the distro an explicit `wsl -d
   * <name>` named, or the machine's default once resolved (see
   * `wslPath.ts`) for a bare `wsl`. */
  wslDistro?: string;
}

export interface EditorTab {
  kind: "editor";
  id: string;
  path: string;
  label: string;
}

export interface SettingsTab {
  kind: "settings";
  id: string;
  label: string;
}

export type AppTab = TermTab | EditorTab | SettingsTab;
