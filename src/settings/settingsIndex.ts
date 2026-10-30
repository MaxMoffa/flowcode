import type { MessageKey } from "../i18n";
import type { SettingsSection } from "./SettingsSectionContext";
import { SHORTCUT_ACTIONS } from "../shortcuts/shortcuts";

export const SECTION_TITLE_KEYS: Record<SettingsSection, MessageKey> = {
  appearance: "settings.section.appearance",
  terminal: "settings.section.terminal",
  startup: "settings.section.startup",
  explorer: "settings.section.explorer",
  agents: "settings.section.agents",
  browser: "settings.section.browser",
  remote: "settings.section.remote",
  shortcuts: "settings.section.shortcuts",
  funzionalita: "settings.section.features",
  profiles: "settings.section.profiles",
  info: "settings.section.info",
};

export const SECTION_DESCRIPTION_KEYS: Record<SettingsSection, MessageKey> = {
  appearance: "settings.section.appearance.desc",
  terminal: "settings.section.terminal.desc",
  startup: "settings.section.startup.desc",
  explorer: "settings.section.explorer.desc",
  agents: "settings.section.agents.desc",
  browser: "settings.section.browser.desc",
  remote: "settings.section.remote.desc",
  shortcuts: "settings.section.shortcuts.desc",
  funzionalita: "settings.section.features.desc",
  profiles: "settings.section.profiles.desc",
  info: "settings.section.info.desc",
};

export const SECTION_SHORT_KEYS: Record<SettingsSection, MessageKey> = {
  appearance: "settings.section.appearance.short",
  terminal: "settings.section.terminal.short",
  startup: "settings.section.startup.short",
  explorer: "settings.section.explorer.short",
  agents: "settings.section.agents.short",
  browser: "settings.section.browser.short",
  remote: "settings.section.remote.short",
  shortcuts: "settings.section.shortcuts.short",
  funzionalita: "settings.section.features.short",
  profiles: "settings.section.profiles.short",
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
  { id: "newTabLayout", section: "terminal", label: "settings.newTabLayout.label", desc: "settings.newTabLayout.desc", keywords: "nuova tab new tab layout vetro glass terminale terminal sfondo background immagine image grana grain personalizza customize pagina page" },
  { id: "chatWebImages", section: "terminal", label: "settings.chatWebImages.label", desc: "settings.chatWebImages.desc", keywords: "immagini immagine web internet chat agente agent images image remote url privacy ip rete network tracciamento tracking" },
  { id: "linkPreviews", section: "terminal", label: "settings.linkPreviews.label", desc: "settings.linkPreviews.desc", keywords: "anteprima anteprime preview previews link url chat agente agent privacy rete network" },
  { id: "startDir", section: "startup", label: "settings.startDir.label", desc: "settings.startDir.desc", keywords: "cartella folder directory home percorso path" },
  { id: "shellStartDir", section: "startup", label: "settings.shellStartDir.label", desc: "settings.shellStartDir.desc", keywords: "cartella folder directory shell wsl percorso path" },
  { id: "restore", section: "startup", label: "settings.restore.label", desc: "settings.restore.desc", keywords: "ripristina restore sessione session schede tabs riavvio" },
  { id: "restoreContent", section: "startup", label: "settings.restoreContent.label", desc: "settings.restoreContent.desc", keywords: "ripristina restore contenuto content testo text chat conversazione cronologia history pulito clean" },
  { id: "sidebarMode", section: "explorer", label: "settings.explorer.label", desc: "settings.explorer.fieldDesc", keywords: "sidebar pannello panel fissato flottante docked floating" },
  { id: "explorerOpen", section: "explorer", label: "settings.explorerOpen.label", desc: "settings.explorerOpen.desc", keywords: "click doppio singolo double single cartelle folders" },
  { id: "agentView", section: "agents", label: "settings.agentView.label", desc: "settings.agentView.desc", keywords: "vista view agente agent chat predefinita default plugin terminale terminal" },
  { id: "dictationModel", section: "agents", label: "settings.dictation.model.label", desc: "settings.dictation.model.desc", keywords: "dettatura dictation voce voice microfono microphone whisper modello model scarica download elimina delete offline" },
  { id: "dictationLanguage", section: "agents", label: "settings.dictation.language.label", desc: "settings.dictation.language.desc", keywords: "dettatura dictation voce voice microfono microphone whisper lingua language italiano english automatica" },
  { id: "dictationSpaceTap", section: "agents", label: "settings.dictation.spaceTap.label", desc: "settings.dictation.spaceTap.desc", keywords: "dettatura dictation voce voice microfono microphone spazio space barra tocco tap scorciatoia shortcut" },
  { id: "dictationSpaceHold", section: "agents", label: "settings.dictation.spaceHold.label", desc: "settings.dictation.spaceHold.desc", keywords: "dettatura dictation voce voice microfono microphone spazio space barra tieni premuto hold push to talk scorciatoia shortcut" },
  { id: "dictationAutoSend", section: "agents", label: "settings.dictation.autoSend.label", desc: "settings.dictation.autoSend.desc", keywords: "dettatura dictation voce voice microfono microphone invia subito send automatico automatic auto invio enter messaggio message" },
  { id: "notify-done", section: "agents", label: "settings.notifications.done.label", desc: "settings.notifications.done.desc", keywords: "notifiche notifications agente agent claude codex vibe mistral avvisi" },
  { id: "notify-input", section: "agents", label: "settings.notifications.input.label", desc: "settings.notifications.input.desc", keywords: "notifiche notifications agente agent claude codex vibe mistral avvisi permesso permission" },
  { id: "notify-limitReset", section: "agents", label: "settings.notifications.limitReset.label", desc: "settings.notifications.limitReset.desc", keywords: "notifiche notifications limite limit reset sessione session utilizzo usage claude codex 5 ore hours" },
  { id: "notify-exited", section: "agents", label: "settings.notifications.exited.label", desc: "settings.notifications.exited.desc", keywords: "notifiche notifications agente agent claude codex vibe mistral avvisi chiuso closed" },
  { id: "autoResume", section: "agents", label: "settings.autoResume.label", desc: "settings.autoResume.description", keywords: "ripresa automatica auto resume riprendi continua limite limit reset sessione session claude codex" },
  { id: "autoResumeMessage", section: "agents", label: "settings.autoResume.message", keywords: "ripresa automatica auto resume messaggio message testo text continua continue" },
  { id: "browserLocal", section: "browser", label: "settings.browser.local.label", desc: "settings.browser.local.desc", keywords: "browser anteprima preview link url localhost server iframe server locali local servers sviluppo dev porta port 127.0.0.1" },
  { id: "browserArtifacts", section: "browser", label: "settings.browser.artifacts.label", desc: "settings.browser.artifacts.desc", keywords: "browser anteprima preview link url localhost server iframe artefatti artifacts html svg pdf immagini images file agente agent chat" },
  { id: "browserExternal", section: "browser", label: "settings.browser.external.label", desc: "settings.browser.external.desc", keywords: "browser anteprima preview link url localhost server iframe siti esterni external sites web incorporare embed conferma confirm sistema system" },
  { id: "browserAutoOpen", section: "browser", label: "settings.browser.autoOpen.label", desc: "settings.browser.autoOpen.desc", keywords: "browser anteprima preview link url localhost server iframe apri automatico auto open avvio start server terminale terminal pannello panel" },
  { id: "browserAutoReload", section: "browser", label: "settings.browser.autoReload.label", desc: "settings.browser.autoReload.desc", keywords: "browser anteprima preview link url localhost server iframe ricarica reload automatica auto aggiorna refresh artefatti artifacts modifica file" },
  { id: "browserScripts", section: "browser", label: "settings.browser.scripts.label", desc: "settings.browser.scripts.desc", keywords: "browser anteprima preview link url localhost server iframe script javascript artefatti artifacts sandbox isolati sicurezza security" },
  { id: "remoteAccess", section: "remote",label: "settings.remote.label", desc: "settings.remote.desc", keywords: "accesso remoto remote access telefono phone mobile cellulare qr collega pair dispositivi devices revoca revoke" },
  { id: "remoteApp", section: "remote",label: "settings.remote.appLabel", desc: "settings.remote.appDesc", keywords: "app android apk scarica download installa install telefono phone mobile cellulare qr" },
  { id: "remoteDevices", section: "remote",label: "settings.remote.devices", keywords: "accesso remoto remote access telefono phone dispositivi devices collega pair qr revoca revoke" },
  { id: "remoteHosts", section: "remote", label: "remoteHosts.label", desc: "remoteHosts.desc", keywords: "altri pc other computers collega connect pair remoto remote host selettore selector disconnetti disconnect rimuovi remove" },
  { id: "features", section: "funzionalita", label: "settings.section.features", desc: "settings.section.features.desc", keywords: "plugin funzionalità features barra rapida quick bar shortcuts scorciatoie importa crea" },
  { id: "profiles", section: "profiles", label: "settings.section.profiles", desc: "settings.section.profiles.desc", keywords: "profili profiles account login accedi accesso multi utente claude codex vibe mistral cartella config" },
  { id: "version", section: "info", label: "settings.group.version", desc: "settings.version.copyDesc", keywords: "versione version copia copy" },
  { id: "updates", section: "info", label: "settings.updates.label", desc: "settings.updates.desc", keywords: "aggiornamenti updates aggiorna upgrade" },
  { id: "configDir", section: "info", label: "settings.configDir.label", desc: "settings.configDir.desc", keywords: "configurazione config cartella folder json manutenzione" },
  { id: "gpu", section: "info", label: "settings.gpu.label", desc: "settings.gpu.desc", keywords: "gpu accelerazione hardware acceleration scheda video graphics glitch grafica rendering driver" },
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
