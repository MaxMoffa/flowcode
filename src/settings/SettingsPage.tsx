import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTheme, type ThemeMode } from "../themes/ThemeContext";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { useSettingsSection } from "./SettingsSectionContext";
import { useConfirmDialog } from "../dialog/ConfirmDialogContext";
import { FunzionalitaPage } from "./FunzionalitaPage";
import { DEFAULT_QUICK_ACTIONS } from "../plugins/registry";
import { SHOW_HIDDEN_KEY } from "../sidebar/FileTree";
import type { PluginDef, PluginManifest } from "../plugins/types";
import type { SidebarMode } from "./modes";
import { listShellOptions, shellOptionLabel, type ShellOption } from "../terminal/shellOptions";
import { writeBool } from "../lib/storage";
import { NOTIFICATION_KINDS, setNotificationEnabled, useNotificationSettings } from "../notifications/notificationSettings";
import { ShellStartDirs } from "./ShellStartDirs";
import { useUpdater, type UpdateStatus } from "../update/UpdateContext";
import pkg from "../../package.json";
import { LANGUAGES, t, useI18n, type LanguagePreference, type MessageKey } from "../i18n";
import { SECTION_DESCRIPTION_KEYS, SECTION_TITLE_KEYS } from "./settingsIndex";
import { Segmented, SettingRow, SettingsGroup, Switch, settingDomId } from "./SettingsControls";
import "./settings-page.css";

/** Third-party libraries the app is built on, with what each is used for.
 * Kept in sync by hand with package.json / Cargo.toml - versions are not
 * repeated here since dependency ranges (`^`) already make a pinned number
 * misleading. */
const CREDITS: { name: string; use: MessageKey }[] = [
  { name: "React", use: "credits.react" },
  { name: "Vite", use: "credits.vite" },
  { name: "TypeScript", use: "credits.typescript" },
  { name: "Tauri", use: "credits.tauri" },
  { name: "CodeMirror", use: "credits.codemirror" },
  { name: "xterm.js", use: "credits.xterm" },
  { name: "portable-pty", use: "credits.portablePty" },
  { name: "sysinfo", use: "credits.sysinfo" },
  { name: "uuid", use: "credits.uuid" },
];

interface SettingsPageProps {
  quickActionIds: string[];
  onToggleQuickAction: (id: string) => void;
  sidebarMode: SidebarMode;
  onSetSidebarMode: (mode: SidebarMode) => void;
  plugins: PluginDef[];
  onAddPlugin: (manifest: PluginManifest) => void;
  onDeletePlugin: (id: string) => void;
  favoritesButtonVisible: boolean;
  onSetFavoritesButtonVisible: (visible: boolean) => void;
}

function updateStatusText(status: UpdateStatus): string {
  switch (status.kind) {
    case "upToDate":
      return t("settings.update.upToDate");
    case "available":
      return t("settings.update.available", { version: status.info.version });
    case "installing":
      return t("settings.update.installing", { version: status.info.version });
    case "error":
      return t("settings.update.error", { error: status.message });
    default:
      return "";
  }
}

export function SettingsPage({
  quickActionIds,
  onToggleQuickAction,
  sidebarMode,
  onSetSidebarMode,
  plugins,
  onAddPlugin,
  onDeletePlugin,
  favoritesButtonVisible,
  onSetFavoritesButtonVisible,
}: SettingsPageProps) {
  const { t, preference: languagePreference, setPreference: setLanguagePreference } = useI18n();
  const { mode, setMode, glassOpacity, setGlassOpacity } = useTheme();
  const {
    fontSize,
    zoomIn,
    zoomOut,
    resetZoom,
    bannerEnabled,
    setBannerEnabled,
    shellId,
    setShellId,
    startPath,
    setStartPath,
    resetShellStartPaths,
    restoreSession,
    setRestoreSession,
    confirmLinkOpen,
    setConfirmLinkOpen,
    explorerDoubleClick,
    setExplorerDoubleClick,
  } = useTerminalSettings();
  const { section, focusId, clearFocus } = useSettingsSection();
  const notificationSettings = useNotificationSettings();
  // One scroll container serves every section, so without this a section
  // opens at whatever depth the previous one was scrolled to - except when
  // arriving from a search result, which scrolls to its own row instead.
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusId) pageRef.current?.scrollTo({ top: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section]);
  useEffect(() => {
    if (!focusId) return;
    const el = document.getElementById(settingDomId(focusId));
    clearFocus();
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("is-flash");
    window.setTimeout(() => el.classList.remove("is-flash"), 1800);
  }, [focusId, clearFocus]);
  const confirm = useConfirmDialog();
  const { status: updateStatus, check: checkForUpdates, openDialog: openUpdateDialog } = useUpdater();
  const [versionCopied, setVersionCopied] = useState(false);
  const versionCopiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Which of the two "Cartella di avvio" choices is selected - kept as its
  // own bit of state rather than derived from `startPath !== ""`, because
  // that derivation is exactly what made the "Personalizzata" button look
  // broken: with a fresh/empty draft, `startPath` stayed "" even after
  // picking it, so the button never visually activated and the input box
  // (which was only rendered when a draft already existed) never appeared.
  const [customPathMode, setCustomPathMode] = useState(startPath !== "");
  const [startPathDraft, setStartPathDraft] = useState(startPath);
  const [startPathValid, setStartPathValid] = useState<boolean | null>(null);
  const startPathCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-validates on every keystroke (debounced) - `null` while unchecked, so
  // the commit effect below never mistakes "haven't verified yet" for
  // "verified valid".
  useEffect(() => {
    setStartPathValid(null);
    if (!startPathDraft) return;
    if (startPathCheckTimer.current) clearTimeout(startPathCheckTimer.current);
    startPathCheckTimer.current = setTimeout(() => {
      invoke<boolean>("is_directory", { path: startPathDraft })
        .then((ok) => setStartPathValid(ok))
        .catch(() => setStartPathValid(false));
    }, 300);
    return () => {
      if (startPathCheckTimer.current) clearTimeout(startPathCheckTimer.current);
    };
  }, [startPathDraft]);

  // Commits the draft to the real setting only once it's confirmed to exist -
  // an invalid/half-typed draft is shown in the field (with the error hint
  // below) but never becomes `startPath`, so App.tsx can trust it outright.
  // Switching back to "Home utente" clears it immediately either way.
  useEffect(() => {
    if (!customPathMode) {
      if (startPath !== "") setStartPath("");
      return;
    }
    if (startPathValid === true && startPathDraft && startPathDraft !== startPath) {
      setStartPath(startPathDraft);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customPathMode, startPathDraft, startPathValid]);
  // Which shells make sense to offer is OS-specific (see pty.rs's
  // `list_shell_options`) - fetched once rather than hardcoded here, so this
  // list can never drift from what `pty_spawn` will actually accept.
  const [shellOptions, setShellOptions] = useState<ShellOption[]>([]);

  useEffect(() => {
    listShellOptions().then(setShellOptions);
  }, []);

  async function handleCopyVersionInfo() {
    const text = `${pkg.name} v${pkg.version} - ${pkg.description}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setVersionCopied(true);
    if (versionCopiedTimer.current) clearTimeout(versionCopiedTimer.current);
    versionCopiedTimer.current = setTimeout(() => setVersionCopied(false), 1200);
  }

  async function handleOpenConfigDir() {
    try {
      const dir = await invoke<string>("config_dir");
      await invoke("open_with_default_app", { path: dir });
    } catch (e) {
      window.alert(t("settings.configDir.error", { error: String(e) }));
    }
  }

  /** Resets everything that makes up "how the terminal looks and behaves
   * today" back to what a fresh install would have: theme, text zoom,
   * sidebar mode, quick-action pins and the hidden-files toggle. Deliberately
   * leaves custom plugins, the plugins directory and keyboard-shortcut
   * overrides untouched - deleting a plugin the user wrote is real, silent
   * data loss, and there's no UI yet to customize shortcuts in the first
   * place, so "resetting" them would silently change a file with no visible
   * effect until the app restarts. */
  async function handleResetTerminal() {
    const ok = await confirm({
      title: t("settings.reset.button"),
      message: t("settings.reset.confirm"),
      confirmLabel: t("settings.reset.confirmLabel"),
      danger: true,
    });
    if (!ok) return;

    setMode("auto");
    resetZoom();
    setBannerEnabled(true);
    onSetFavoritesButtonVisible(true);
    setShellId("system");
    setCustomPathMode(false);
    setStartPathDraft("");
    resetShellStartPaths();
    setRestoreSession(true);
    setConfirmLinkOpen(true);
    setExplorerDoubleClick(true);
    onSetSidebarMode("auto");

    const toRemove = quickActionIds.filter((id) => !DEFAULT_QUICK_ACTIONS.includes(id));
    const toAdd = DEFAULT_QUICK_ACTIONS.filter((id) => !quickActionIds.includes(id));
    for (const id of [...toRemove, ...toAdd]) onToggleQuickAction(id);

    writeBool(SHOW_HIDDEN_KEY, false);
  }


  const onOff: [string, string] = [t("settings.on"), t("settings.off")];
  const languageOptions = (["system", ...LANGUAGES.map((l) => l.code)] as LanguagePreference[]).map((code) => ({
    value: code,
    label: code === "system" ? t("settings.language.system") : (LANGUAGES.find((l) => l.code === code)?.name ?? code),
  }));
  const updateText = updateStatusText(updateStatus);

  return (
    <div className="settings-page" ref={pageRef}>
      <div className="settings-page-inner">
        <h1 className="settings-title">{t(SECTION_TITLE_KEYS[section])}</h1>
        <p className="settings-page-desc">{t(SECTION_DESCRIPTION_KEYS[section])}</p>

        {section === "appearance" && (
          <>
            <SettingsGroup title={t("settings.group.interface")}>
              <SettingRow id="language" label={t("settings.language.label")} desc={t("settings.language.fieldDesc")}>
                <Segmented
                  ariaLabel={t("settings.language.label")}
                  value={languagePreference}
                  options={languageOptions}
                  onChange={setLanguagePreference}
                />
              </SettingRow>
              <SettingRow id="theme" label={t("settings.theme.label")} desc={t("settings.theme.fieldDesc")}>
                <Segmented<ThemeMode>
                  ariaLabel={t("settings.theme.label")}
                  value={mode}
                  options={[
                    { value: "auto", label: t("theme.auto") },
                    { value: "light", label: t("theme.light") },
                    { value: "dark", label: t("theme.dark") },
                  ]}
                  onChange={setMode}
                />
              </SettingRow>
              <SettingRow id="transparency" label={t("settings.transparency.label")} desc={t("settings.transparency.fieldDesc")}>
                <div className="settings-zoom-row">
                  <input
                    type="range"
                    min={0.3}
                    max={1}
                    step={0.01}
                    value={glassOpacity}
                    onChange={(e) => setGlassOpacity(Number(e.target.value))}
                    className="settings-opacity-slider"
                    aria-label={t("settings.transparency.label")}
                  />
                  <span className="settings-zoom-value">{Math.round(glassOpacity * 100)}%</span>
                </div>
              </SettingRow>
            </SettingsGroup>

            <SettingsGroup title={t("settings.group.header")}>
              <SettingRow id="favorites" label={t("settings.header.favorites")} desc={t("settings.header.favorites.desc")}>
                <Switch
                  checked={favoritesButtonVisible}
                  onChange={onSetFavoritesButtonVisible}
                  label={t("settings.header.favorites")}
                  stateLabels={[t("common.show"), t("common.hide")]}
                />
              </SettingRow>
            </SettingsGroup>
          </>
        )}

        {section === "terminal" && (
          <>
            <SettingsGroup title={t("settings.group.textShell")}>
              <SettingRow id="zoom" label={t("settings.zoom.label")} desc={t("settings.zoom.desc")}>
                <div className="settings-zoom-row">
                  <button type="button" className="settings-zoom-btn" aria-label={t("zoom.out")} onClick={zoomOut}>
                    −
                  </button>
                  <span className="settings-zoom-value">{fontSize}px</span>
                  <button type="button" className="settings-zoom-btn" aria-label={t("zoom.in")} onClick={zoomIn}>
                    +
                  </button>
                  <button type="button" className="settings-choice" onClick={resetZoom}>
                    {t("settings.zoom.reset")}
                  </button>
                </div>
              </SettingRow>
              {shellOptions.length > 0 && (
                <SettingRow id="shell" label={t("settings.shell.label")} desc={t("settings.shell.desc")}>
                  <Segmented
                    ariaLabel={t("settings.shell.label")}
                    value={shellId}
                    options={shellOptions.map((opt) => ({ value: opt.id, label: shellOptionLabel(opt) }))}
                    onChange={setShellId}
                  />
                </SettingRow>
              )}
              <SettingRow id="banner" label={t("settings.banner.label")} desc={t("settings.banner.desc")}>
                <Switch
                  checked={bannerEnabled}
                  onChange={setBannerEnabled}
                  label={t("settings.banner.label")}
                  stateLabels={[t("common.show"), t("common.hide")]}
                />
              </SettingRow>
            </SettingsGroup>

            <SettingsGroup title={t("settings.group.behavior")}>
              <SettingRow id="links" label={t("settings.links.label")} desc={t("settings.links.desc")}>
                <Segmented
                  ariaLabel={t("settings.links.label")}
                  value={confirmLinkOpen ? "ask" : "open"}
                  options={[
                    { value: "ask", label: t("settings.links.ask") },
                    { value: "open", label: t("settings.links.open") },
                  ]}
                  onChange={(v) => setConfirmLinkOpen(v === "ask")}
                />
              </SettingRow>
            </SettingsGroup>
          </>
        )}

        {section === "startup" && (
          <>
            <SettingsGroup title={t("settings.group.startFolders")}>
              <SettingRow id="startDir" stacked label={t("settings.startDir.label")} desc={t("settings.startDir.desc")}>
                <Segmented
                  ariaLabel={t("settings.startDir.label")}
                  value={customPathMode ? "custom" : "home"}
                  options={[
                    { value: "home", label: t("settings.startDir.home") },
                    { value: "custom", label: t("settings.startDir.custom") },
                  ]}
                  onChange={(v) => setCustomPathMode(v === "custom")}
                />
                {customPathMode && (
                  <>
                    <input
                      type="text"
                      className="settings-text-input"
                      value={startPathDraft}
                      placeholder={t("settings.startDir.placeholder")}
                      onChange={(e) => setStartPathDraft(e.target.value)}
                    />
                    {startPathValid === false && (
                      <span className="settings-field-hint is-error">{t("settings.startDir.notFound")}</span>
                    )}
                    {startPathValid === true && (
                      <span className="settings-field-hint is-success">{t("settings.startDir.valid")}</span>
                    )}
                  </>
                )}
              </SettingRow>
              <ShellStartDirs options={shellOptions} />
            </SettingsGroup>

            <SettingsGroup title={t("settings.group.session")}>
              <SettingRow id="restore" label={t("settings.restore.label")} desc={t("settings.restore.desc")}>
                <Segmented
                  ariaLabel={t("settings.restore.label")}
                  value={restoreSession ? "restore" : "fresh"}
                  options={[
                    { value: "restore", label: t("settings.restore.restore") },
                    { value: "fresh", label: t("settings.restore.fresh") },
                  ]}
                  onChange={(v) => setRestoreSession(v === "restore")}
                />
              </SettingRow>
            </SettingsGroup>
          </>
        )}

        {section === "explorer" && (
          <SettingsGroup title={t("settings.group.panel")}>
            <SettingRow id="sidebarMode" label={t("settings.explorer.label")} desc={t("settings.explorer.fieldDesc")}>
              <Segmented<SidebarMode>
                ariaLabel={t("settings.explorer.label")}
                value={sidebarMode}
                options={[
                  { value: "auto", label: t("sidebarMode.auto") },
                  { value: "docked", label: t("sidebarMode.docked") },
                  { value: "floating", label: t("sidebarMode.floating") },
                ]}
                onChange={onSetSidebarMode}
              />
            </SettingRow>
            <SettingRow id="explorerOpen" label={t("settings.explorerOpen.label")} desc={t("settings.explorerOpen.desc")}>
              <Segmented
                ariaLabel={t("settings.explorerOpen.label")}
                value={explorerDoubleClick ? "double" : "single"}
                options={[
                  { value: "double", label: t("settings.explorerOpen.double") },
                  { value: "single", label: t("settings.explorerOpen.single") },
                ]}
                onChange={(v) => setExplorerDoubleClick(v === "double")}
              />
            </SettingRow>
          </SettingsGroup>
        )}

        {section === "notifications" && (
          <SettingsGroup title={t("settings.group.alerts")}>
            {NOTIFICATION_KINDS.map((kind) => (
              <SettingRow
                key={kind}
                id={`notify-${kind}`}
                label={t(`settings.notifications.${kind}.label`)}
                desc={t(`settings.notifications.${kind}.desc`)}
              >
                <Switch
                  checked={notificationSettings[kind]}
                  onChange={(on) => setNotificationEnabled(kind, on)}
                  label={t(`settings.notifications.${kind}.label`)}
                  stateLabels={onOff}
                />
              </SettingRow>
            ))}
          </SettingsGroup>
        )}

        {section === "funzionalita" && (
          <div id={settingDomId("features")}>
            <FunzionalitaPage
              plugins={plugins}
              enabledIds={quickActionIds}
              onToggleEnabled={onToggleQuickAction}
              onAdd={onAddPlugin}
              onDelete={onDeletePlugin}
            />
          </div>
        )}

        {section === "info" && (
          <>
            <SettingsGroup title={t("settings.group.version")} desc={pkg.description}>
              <SettingRow id="version" label={`${pkg.name} v${pkg.version}`} desc={t("settings.version.copyDesc")}>
                <button type="button" className="settings-choice" onClick={handleCopyVersionInfo}>
                  {versionCopied ? t("common.copied") : t("settings.version.copy")}
                </button>
              </SettingRow>
              <SettingRow
                id="updates"
                label={t("settings.updates.label")}
                desc={
                  <>
                    {t("settings.updates.desc")}
                    {updateText && <span className="settings-row-status">{updateText}</span>}
                  </>
                }
              >
                {updateStatus.kind === "available" || updateStatus.kind === "installing" ? (
                  <button type="button" className="settings-choice is-primary" onClick={openUpdateDialog}>
                    {t("settings.updates.install", { version: updateStatus.info.version })}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="settings-choice"
                    disabled={updateStatus.kind === "checking"}
                    onClick={() => void checkForUpdates(true)}
                  >
                    {updateStatus.kind === "checking" ? t("common.checking") : t("settings.updates.check")}
                  </button>
                )}
              </SettingRow>
            </SettingsGroup>

            <SettingsGroup title={t("settings.group.maintenance")}>
              <SettingRow id="configDir" label={t("settings.configDir.label")} desc={t("settings.configDir.desc")}>
                <button type="button" className="settings-choice" onClick={handleOpenConfigDir}>
                  {t("settings.configDir.open")}
                </button>
              </SettingRow>
              <SettingRow id="reset" label={t("settings.reset.label")} desc={t("settings.reset.desc")}>
                <button type="button" className="settings-choice is-danger" onClick={handleResetTerminal}>
                  {t("settings.reset.button")}
                </button>
              </SettingRow>
            </SettingsGroup>

            <SettingsGroup id="credits" title={t("settings.group.credits")} desc={t("settings.credits.desc")}>
              <ul className="settings-credits-list">
                {CREDITS.map((c) => (
                  <li key={c.name} className="settings-credits-item">
                    <span className="settings-credits-name">{c.name}</span> — {t(c.use)}
                  </li>
                ))}
              </ul>
            </SettingsGroup>
          </>
        )}
      </div>
    </div>
  );
}
