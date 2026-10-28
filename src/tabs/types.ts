import type { AgentCli } from "../agents/cliInfo";
import type { ChatStatus } from "../chat/chatTypes";

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
  /** The user muted this tab's agent notifications (tab context menu). */
  notifyMuted?: boolean;
  /** Still showing the new tab page (see src/newtab) - no shell has been
   * started yet; it starts once the user picks a command, a shell, a recent
   * terminal or a favorite. `cwd` is already the default shell's start
   * folder, for the explorer and the page's prompt. */
  newTab?: boolean;
  /** A `newTab` whose page is a dialog over the current view (the "glass"
   * layout) rather than a tab: not in the strip, the session or the phone's
   * list, and never the active tab. It becomes a normal tab on launch and is
   * removed on dismiss. At most one exists. Not saved. */
  dialog?: boolean;
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
  /** The account profile (see src/profiles) this tab's shell was started
   * under - fixed at spawn, since the env vars it sets (CLAUDE_CONFIG_DIR,
   * CODEX_HOME, VIBE_HOME) can't change on a running process. `undefined` =
   * the default profile. */
  profileId?: string;
}

/** An agent hosted as a conversation view (see src/chat) rather than inside a
 * terminal. Host-only: there is no shell under it. */
export interface ChatTab {
  kind: "chat";
  id: string;
  agent: AgentCli;
  /** The folder the agent works in. */
  cwd: string;
  label: string;
  /** The account profile (see src/profiles) the agent runs under - fixed at
   * start, like a terminal's. */
  profileId?: string;
  /** The agent's session, reported once it exists; saved so a restart
   * resumes the conversation. */
  sessionId?: string;
  /** The agent view the chat is shown with (see src/agentViews); absent = the
   * default. */
  viewId?: string;
  status?: ChatStatus;
  /** `false` while a chat that started fresh has had no prompt sent: its session
   * isn't on disk, so a switch to the terminal starts a new one instead of
   * resuming. Absent (restored, resumed) = there is a conversation. Not saved. */
  talked?: boolean;
  /** The terminal tab whose agent this chat takes over; closed once the session has loaded, kept if it fails. Not saved. */
  handoffFrom?: string;
  /** The folder the sidebar explorer browses while this chat is in front;
   * absent = `cwd`. Not saved. */
  explorerPath?: string;
}

export interface EditorTab {
  kind: "editor";
  id: string;
  path: string;
  label: string;
}

/** A file's git diff, opened from the Git tab of the sidebar. Not saved in the
 * session: it is a view of the repository's current state, nothing to restore. */
interface DiffTab {
  kind: "diff";
  id: string;
  /** The repository working tree root. */
  root: string;
  /** Repo-relative, forward slashes. */
  path: string;
  /** Staged: HEAD vs. the index. Otherwise: the index vs. the file on disk. */
  staged: boolean;
  label: string;
}

interface SettingsTab {
  kind: "settings";
  id: string;
  label: string;
}

interface ChangelogTab {
  kind: "changelog";
  id: string;
  label: string;
}

/** Opened by itself on the first launch after an update: what changed in
 * `version`, the one just installed. */
interface WhatsNewTab {
  kind: "whatsNew";
  id: string;
  label: string;
  version: string;
}

export type AppTab = TermTab | ChatTab | EditorTab | DiffTab | SettingsTab | ChangelogTab | WhatsNewTab;
