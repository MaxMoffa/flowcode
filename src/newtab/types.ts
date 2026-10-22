import type { ComponentType } from "react";
import type { AgentCli } from "../agents/cliInfo";
import type { MessageKey } from "../i18n";
import type { PromptAnchor } from "../terminal/Terminal";

/** What the page hands back once the user picks something: the shell to
 * start (`undefined` = the configured default), where (`undefined` = that
 * shell's start folder), and a command to run - or, with `typeOnly`, to
 * leave typed on the prompt. */
export interface NewTabLaunch {
  shell?: string;
  cwd?: string;
  command?: string;
  typeOnly?: boolean;
}

/** What App.tsx gives whichever layout the new tab shows. */
export interface NewTabHostProps {
  hidden: boolean;
  /** The configured default shell id (Impostazioni > Shell predefinita). */
  defaultShell: string;
  /** The folder a default-shell terminal would start in - shown on the
   * prompt; empty while it's still being looked up. */
  startDir: string;
  /** Font size of the terminal this page turns into: the page draws its
   * banner and prompt on that terminal's cell grid. */
  termFontSize: number;
  /** Fired on launch: mount the terminal now, so its shell spins up
   * underneath while the page is still on top (see `is-overlay`) - it stays
   * until it has faded out and calls `onDone`. */
  onLaunch: (launch: NewTabLaunch) => void;
  /** Starts `cli` in place of this page, under the tab's account profile. */
  onLaunchAgent: (cli: AgentCli) => void;
  /** Where the terminal underneath will draw its first prompt, once its
   * banner (if any) is on screen. */
  anchor?: PromptAnchor;
  /** The terminal's shell has drawn its first prompt (`null`: it never
   * will - the shell failed to start). */
  promptShown?: PromptAnchor | null;
  /** The chosen shell changed (`undefined` = the configured default) - the
   * tab's folder follows to that shell's start folder. */
  onShellChange: (shell: string | undefined) => void;
  /** The tab's current account profile - the automatic pick until the user
   * chooses one (`undefined` = the default profile). */
  profileId?: string;
  /** A profile chip was picked (`null` = the default profile). */
  onProfileChange: (profileId: string | null) => void;
  onDone: () => void;
}

/** What a layout gets: the host's props, and a way to open the customize panel. */
export interface NewTabLayoutProps extends NewTabHostProps {
  onCustomize: () => void;
}

/** One way to lay out the new tab page, picked from the registry. */
export interface NewTabLayoutDef {
  id: string;
  /** Where a built-in layout's name comes from. */
  labelKey?: MessageKey;
  /** A plugin layout's name, and its translations by UI language. */
  label?: string;
  labels?: Record<string, string>;
  /** "plugin" layouts are installed by the user and can be removed again. */
  source: "builtin" | "plugin";
  component: ComponentType<NewTabLayoutProps>;
}
