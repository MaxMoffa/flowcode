import type { PluginDef, PluginManifest } from "./types";
import { t } from "../i18n";

/** Ids pinned to the quick-action bar on a brand-new install, and what
 * "Reset terminal" (Settings → About) restores it to. Kept
 * here, next to the plugin ids it references, instead of in App.tsx or
 * SettingsPage.tsx so both can import the same value without one having to
 * import the other. */
export const DEFAULT_QUICK_ACTIONS = ["clearTerminal"];

/** Ship with the app - always present, can be enabled/disabled (pinned to
 * the shortcuts bar or not) but never deleted from the "Features" table.
 * A function, not a constant: labels follow the current UI language. */
export function builtinPlugins(): PluginDef[] {
  return [
    { id: "newTab", label: t("plugin.newTab"), action: "newTerminal", builtin: true },
    { id: "clearTerminal", label: t("plugin.clearTerminal"), action: "clearTerminal", builtin: true },
    { id: "toggleSidebar", label: t("plugin.toggleSidebar"), action: "toggleSidebar", builtin: true },
    {
      id: "toggleAgentsSidebar",
      label: t("plugin.toggleAgentsSidebar"),
      description: t("plugin.toggleAgentsSidebar.description"),
      action: "toggleAgentsSidebar",
      builtin: true,
    },
  ];
}

/** Not builtin: installed once, on first run, as ordinary custom plugin
 * files (same as if the user had imported them) so they show up already
 * usable but stay editable/removable like anything else in Funzionalità.
 * Clicking launches the CLI directly (plain `runCommand`); the account
 * status shown on hover, with a fill ring when a number is available, is
 * separate special-cased logic keyed by these exact ids - see
 * plugins/usage.ts for why no numeric usage/limit percentage is shown
 * today (neither CLI exposes one outside an interactive session).
 * Descriptions are written in the UI language current at install time -
 * from then on they're the user's own files. */
export function examplePlugins(): PluginManifest[] {
  return [
    {
      id: "codex-cli",
      label: "Codex CLI",
      description: t("plugin.cli.description", { name: "Codex CLI" }),
      action: "runCommand",
      command: "codex",
      icon: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 6l-4 12",
    },
    {
      id: "claude-code",
      label: "Claude Code",
      description: t("plugin.cli.description", { name: "Claude Code" }),
      action: "runCommand",
      command: "claude",
      icon: "M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9",
    },
  ];
}
