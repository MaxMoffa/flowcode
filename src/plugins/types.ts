/** The plugin standard: a plugin is a small declarative manifest, not
 * arbitrary code. `action` is a fixed vocabulary the app already knows how
 * to run - anyone can write a new plugin (a JSON file dropped in the app's
 * plugins folder) by picking one of these, without the app ever executing
 * code it didn't ship with. Full docs: PLUGINS.md at the repo root. */
import type { MessageKey } from "../i18n";

export type PluginAction =
  | "newTerminal"
  | "clearTerminal"
  | "toggleSidebar"
  | "toggleAgentsSidebar"
  | "runCommand"
  | "notify"
  | "dialog"
  | "commandOutput";

/** What a dialog-plugin's button does when clicked - the same fixed
 * vocabulary, minus "dialog" itself (dialogs don't nest). */
export interface PluginButtonDef {
  label: string;
  action: Exclude<PluginAction, "dialog">;
  command?: string;
  message?: string;
}

export interface PluginManifest {
  id: string;
  label: string;
  description?: string;
  action: PluginAction;
  /** runCommand: typed into the active terminal exactly as if the user had
   * typed it themselves. commandOutput: run headlessly (no terminal opened,
   * no stdin) and its combined stdout/stderr shown in a popup. */
  command?: string;
  /** notify: the toast text. dialog: the body text (title defaults to `label`). */
  message?: string;
  /** dialog only - defaults to `label` if omitted. */
  title?: string;
  /** dialog only - one button per action, shown alongside an automatic
   * "Close" button. */
  buttons?: PluginButtonDef[];
  /** SVG path `d` data for a single path, drawn in a fixed icon frame. */
  icon?: string;
}

export interface PluginDef extends PluginManifest {
  /** Ships with the app - can be enabled/disabled but never deleted. */
  builtin?: boolean;
}

/** Translation key of each action's description - also the list of valid
 * actions (`action in PLUGIN_ACTION_LABELS`). */
export const PLUGIN_ACTION_LABELS: Record<PluginAction, MessageKey> = {
  newTerminal: "pluginAction.newTerminal",
  clearTerminal: "pluginAction.clearTerminal",
  toggleSidebar: "pluginAction.toggleSidebar",
  toggleAgentsSidebar: "pluginAction.toggleAgentsSidebar",
  runCommand: "pluginAction.runCommand",
  notify: "pluginAction.notify",
  dialog: "pluginAction.dialog",
  commandOutput: "pluginAction.commandOutput",
};
