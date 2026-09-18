import type { PluginDef, PluginManifest } from "./types";

/** Ship with the app - always present, can be enabled/disabled (pinned to
 * the shortcuts bar or not) but never deleted from the "Funzionalità" table. */
export const BUILTIN_PLUGINS: PluginDef[] = [
  { id: "newTab", label: "Nuovo terminale", action: "newTerminal", builtin: true },
  { id: "clearTerminal", label: "Pulisci terminale", action: "clearTerminal", builtin: true },
  { id: "toggleSidebar", label: "Mostra/nascondi pannello laterale", action: "toggleSidebar", builtin: true },
];

/** Not builtin: installed once, on first run, as ordinary custom plugin
 * files (same as if the user had imported them) so they show up already
 * usable but stay editable/removable like anything else in Funzionalità.
 * Clicking launches the CLI directly (plain `runCommand`); the account
 * status shown on hover, with a fill ring when a number is available, is
 * separate special-cased logic keyed by these exact ids - see
 * plugins/usage.ts for why no numeric usage/limit percentage is shown
 * today (neither CLI exposes one outside an interactive session). */
export const EXAMPLE_PLUGINS: PluginManifest[] = [
  {
    id: "codex-cli",
    label: "Codex CLI",
    description: "Avvia una sessione di Codex CLI. Passa il mouse sull'icona nella barra per lo stato dell'account.",
    action: "runCommand",
    command: "codex",
    icon: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 6l-4 12",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Avvia una sessione di Claude Code. Passa il mouse sull'icona nella barra per lo stato dell'account.",
    action: "runCommand",
    command: "claude",
    icon: "M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9",
  },
];
