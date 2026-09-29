import type { MessageKey } from "../i18n";
import type { SettingsSection } from "./SettingsSectionContext";
import { SHORTCUT_ACTIONS } from "../shortcuts/shortcuts";

export const SECTION_TITLE_KEYS: Record<SettingsSection, MessageKey> = {
  appearance: "settings.section.appearance",
  terminal: "settings.section.terminal",
  startup: "settings.section.startup",
  explorer: "settings.section.explorer",
  notifications: "settings.section.notifications",
  shortcuts: "settings.section.shortcuts",
  funzionalita: "settings.section.features",
  info: "settings.section.info",
};

export const SECTION_DESCRIPTION_KEYS: Record<SettingsSection, MessageKey> = {
  appearance: "settings.section.appearance.desc",
  terminal: "settings.section.terminal.desc",
  startup: "settings.section.startup.desc",
  explorer: "settings.section.explorer.desc",
  notifications: "settings.section.notifications.desc",
  shortcuts: "settings.section.shortcuts.desc",
  funzionalita: "settings.section.features.desc",
  info: "settings.section.info.desc",
};

export const SECTION_SHORT_KEYS: Record<SettingsSection, MessageKey> = {
  appearance: "settings.section.appearance.short",
  terminal: "settings.section.terminal.short",
  startup: "settings.section.startup.short",
  explorer: "settings.section.explorer.short",
  notifications: "settings.section.notifications.short",
  shortcuts: "settings.section.shortcuts.short",
  funzionalita: "settings.section.features.short",
  info: "settings.section.info.short",
};

export const SECTIONS = Object.keys(SECTION_TITLE_KEYS) as SettingsSection[];

export interface SettingEntry {
  /** Matches the `id` of the row rendered by SettingsPage. */
  id: string;
  section: SettingsSection;
  label: MessageKey;
  desc?: MessageKey;
  /** Extra search terms (both languages) that aren't in the label/description. */
  keywords?: string;
}

/** Every searchable setting. Must stay in step with the rows SettingsPage
 * renders - a row missing here just can't be found by search. */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  { id: "language", section: "appearance", label: "settings.language.label", desc: "settings.language.fieldDesc", keywords: "lingua language idioma italiano english traduzione" },
  { id: "theme", section: "appearance", label: "settings.theme.label", desc: "settings.theme.fieldDesc", keywords: "tema theme chiaro scuro light dark colori aspetto" },
  { id: "palette", section: "appearance", label: "settings.palette.label", desc: "settings.palette.desc", keywords: "palette colori colors tema theme accento accent aspetto black white nero bianco ocean ember lavender rose mint graphite nord solarized gruvbox dracula" },
  { id: "terminalPalette", section: "appearance", label: "settings.terminalPalette.label", desc: "settings.terminalPalette.desc", keywords: "terminale terminal separare separate colori colors palette tema theme sfondo background ansi" },
  { id: "contrast", section: "appearance", label: "settings.contrast.label", desc: "settings.contrast.desc", keywords: "contrasto contrast leggibilità readability testo text accessibilità accessibility" },
  { id: "transparency", section: "appearance", label: "settings.transparency.label", desc: "settings.transparency.fieldDesc", keywords: "trasparenza opacità vetro blur glass opacity" },
  { id: "favorites", section: "appearance", label: "settings.header.favorites", desc: "settings.header.favorites.desc", keywords: "header intestazione barra preferiti favorites stella" },
  { id: "zoom", section: "terminal", label: "settings.zoom.label", desc: "settings.zoom.desc", keywords: "zoom font carattere dimensione testo size" },
  { id: "shell", section: "terminal", label: "settings.shell.label", desc: "settings.shell.desc", keywords: "shell powershell cmd bash wsl zsh" },
  { id: "banner", section: "terminal", label: "settings.banner.label", desc: "settings.banner.desc", keywords: "banner logo benvenuto welcome" },
  { id: "newTabPage", section: "terminal", label: "settings.newTabPage.label", desc: "settings.newTabPage.desc", keywords: "nuova tab new tab scheda pagina page preferiti favorites recenti recent comando command riga line iniziale home" },
  { id: "links", section: "terminal", label: "settings.links.label", desc: "settings.links.desc", keywords: "link url collegamenti browser conferma confirm" },
  { id: "startDir", section: "startup", label: "settings.startDir.label", desc: "settings.startDir.desc", keywords: "cartella folder directory home percorso path" },
  { id: "shellStartDir", section: "startup", label: "settings.shellStartDir.label", desc: "settings.shellStartDir.desc", keywords: "cartella folder directory shell wsl percorso path" },
  { id: "restore", section: "startup", label: "settings.restore.label", desc: "settings.restore.desc", keywords: "ripristina restore sessione session schede tabs riavvio" },
  { id: "sidebarMode", section: "explorer", label: "settings.explorer.label", desc: "settings.explorer.fieldDesc", keywords: "sidebar pannello panel fissato flottante docked floating" },
  { id: "explorerOpen", section: "explorer", label: "settings.explorerOpen.label", desc: "settings.explorerOpen.desc", keywords: "click doppio singolo double single cartelle folders" },
  { id: "notify-done", section: "notifications", label: "settings.notifications.done.label", desc: "settings.notifications.done.desc", keywords: "notifiche notifications agente agent claude codex avvisi" },
  { id: "notify-input", section: "notifications", label: "settings.notifications.input.label", desc: "settings.notifications.input.desc", keywords: "notifiche notifications agente agent claude codex avvisi permesso permission" },
  { id: "notify-exited", section: "notifications", label: "settings.notifications.exited.label", desc: "settings.notifications.exited.desc", keywords: "notifiche notifications agente agent claude codex avvisi chiuso closed" },
  { id: "features", section: "funzionalita", label: "settings.section.features", desc: "settings.section.features.desc", keywords: "plugin funzionalità features barra rapida quick bar shortcuts scorciatoie importa crea" },
  { id: "version", section: "info", label: "settings.group.version", desc: "settings.version.copyDesc", keywords: "versione version copia copy" },
  { id: "updates", section: "info", label: "settings.updates.label", desc: "settings.updates.desc", keywords: "aggiornamenti updates aggiorna upgrade" },
  { id: "configDir", section: "info", label: "settings.configDir.label", desc: "settings.configDir.desc", keywords: "configurazione config cartella folder json manutenzione" },
  { id: "reset", section: "info", label: "settings.reset.label", desc: "settings.reset.desc", keywords: "ripristina reset default predefinite manutenzione" },
  { id: "credits", section: "info", label: "settings.group.credits", desc: "settings.credits.desc", keywords: "crediti credits librerie libraries open source licenze" },
  { id: "shortcutsGuide", section: "shortcuts", label: "shortcuts.guide.label", desc: "shortcuts.guide.settingsDesc", keywords: "scorciatoie shortcuts tastiera keyboard guida guide aiuto help combinazioni hotkey" },
  { id: "shortcutsResetAll", section: "shortcuts", label: "shortcuts.resetAll.label", desc: "shortcuts.resetAll.desc", keywords: "scorciatoie shortcuts ripristina reset predefinite default" },
  ...SHORTCUT_ACTIONS.map((action): SettingEntry => ({
    id: `shortcut-${action}`,
    section: "shortcuts",
    label: `shortcuts.action.${action}`,
    keywords: "scorciatoie shortcuts tastiera keyboard combinazione hotkey tab terminale terminal",
  })),
];
