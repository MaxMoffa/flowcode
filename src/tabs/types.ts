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
