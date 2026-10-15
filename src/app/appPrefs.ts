// Persisted-preference keys, layout breakpoints and the small pure read
// helpers the shell's usePersistentState calls build on.
import { DEFAULT_QUICK_ACTIONS } from "../plugins/registry";
import { EXPLORER_LINK_MODES, SIDEBAR_MODES } from "../settings/modes";
import { readBool, readEnum, readJson } from "../lib/storage";

export const SIDEBAR_MODE_KEY = "flowcode.sidebarMode";
export const EXPLORER_LINK_MODE_KEY = "flowcode.explorerLinkMode";
// Below this window width, "auto" mode floats the explorer instead of
// docking it, so a narrow window keeps its terminal usable.
export const SIDEBAR_AUTO_BREAKPOINT = 880;
// Below this the layout switches to its phone-like form (two-row header,
// side panels as overlays). Mirrored by the `.is-narrow` rules in App.css.
export const NARROW_BREAKPOINT = 640;

export const QUICK_ACTIONS_KEY = "flowcode.quickActions";
export const PLUGINS_SEEDED_KEY = "flowcode.pluginsSeeded";
export const PLUGINS_MIGRATED_KEY = "flowcode.pluginsActionMigrated";
/** Set once the Mistral Vibe plugin, shipped after the others, has been
 * offered to an install that had already seeded them. */
export const VIBE_PLUGIN_SEEDED_KEY = "flowcode.vibePluginSeeded";
/** Same, for the Gemini CLI plugin. */
export const GEMINI_PLUGIN_SEEDED_KEY = "flowcode.geminiPluginSeeded";

/** Plugin commands the user has OK'd: `<plugin id>:<hash of the command>`
 * entries, so editing a plugin's command asks again. */
export const PLUGIN_APPROVALS_KEY = "flowcode.pluginApprovals";
export const FAVORITES_BUTTON_VISIBLE_KEY = "flowcode.favoritesButtonVisible";
export const SIDEBAR_COLLAPSED_KEY = "flowcode.sidebarCollapsed";
export const AGENTS_SIDEBAR_OPEN_KEY = "flowcode.agentsSidebarOpen";

export const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((id) => typeof id === "string");
/** Not a security boundary, just a compact stable stamp of a command's text. */
export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16);
}
export const readQuickActions = (key: string) => readJson(key, isStringArray, DEFAULT_QUICK_ACTIONS);
export const readTrue = (key: string) => readBool(key, true);
export const readFalse = (key: string) => readBool(key, false);
export const readSidebarMode = (key: string) => readEnum(key, SIDEBAR_MODES, "auto");
export const readLinkMode = (key: string) => readEnum(key, EXPLORER_LINK_MODES, "auto");
