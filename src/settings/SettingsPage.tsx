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
import { useUpdater, type UpdateStatus } from "../update/UpdateContext";
import pkg from "../../package.json";
import { LANGUAGES, t, useI18n, type LanguagePreference, type MessageKey } from "../i18n";
import { SECTION_TITLE_KEYS } from "./SettingsNav";
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

const SECTION_DESCRIPTION_KEYS: Record<keyof typeof SECTION_TITLE_KEYS, MessageKey> = {
  generale: "settings.section.general.desc",
  terminale: "settings.section.terminal.desc",
  funzionalita: "settings.section.features.desc",
  info: "settings.section.info.desc",
};

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
    restoreSession,
    setRestoreSession,
    confirmLinkOpen,
    setConfirmLinkOpen,
  } = useTerminalSettings();
  const { section } = useSettingsSection();
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
    setRestoreSession(true);
    setConfirmLinkOpen(true);
    onSetSidebarMode("auto");

    const toRemove = quickActionIds.filter((id) => !DEFAULT_QUICK_ACTIONS.includes(id));
    const toAdd = DEFAULT_QUICK_ACTIONS.filter((id) => !quickActionIds.includes(id));
    for (const id of [...toRemove, ...toAdd]) onToggleQuickAction(id);

    writeBool(SHOW_HIDDEN_KEY, false);
  }

  return (
    <div className="settings-page">
      <div className="settings-page-inner">
        <h1 className="settings-title">{t(SECTION_TITLE_KEYS[section])}</h1>
        <p className="settings-page-desc">{t(SECTION_DESCRIPTION_KEYS[section])}</p>

        {section === "generale" && (
          <>
            <section className="settings-block">
              <h3>{t("settings.language.title")}</h3>
              <p className="settings-block-desc">{t("settings.language.desc")}</p>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.language.label")}</span>
                <p className="settings-field-desc">{t("settings.language.fieldDesc")}</p>
                <div className="settings-choice-row">
                  {(["system", ...LANGUAGES.map((l) => l.code)] as LanguagePreference[]).map((code) => (
                    <button
                      key={code}
                      type="button"
                      className={"settings-choice" + (languagePreference === code ? " is-active" : "")}
                      onClick={() => setLanguagePreference(code)}
                    >
                      {code === "system" ? t("settings.language.system") : LANGUAGES.find((l) => l.code === code)?.name}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>{t("settings.theme.title")}</h3>
              <p className="settings-block-desc">{t("settings.theme.desc")}</p>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.theme.label")}</span>
                <p className="settings-field-desc">{t("settings.theme.fieldDesc")}</p>
                <div className="settings-choice-row">
                  {(["auto", "light", "dark"] as ThemeMode[]).map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={"settings-choice" + (mode === m ? " is-active" : "")}
                      onClick={() => setMode(m)}
                    >
                      {m === "auto" ? t("theme.auto") : m === "light" ? t("theme.light") : t("theme.dark")}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>{t("settings.transparency.title")}</h3>
              <p className="settings-block-desc">{t("settings.transparency.desc")}</p>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.transparency.label")}</span>
                <p className="settings-field-desc">{t("settings.transparency.fieldDesc")}</p>
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
              </div>
            </section>

            <section className="settings-block">
              <h3>{t("settings.header.title")}</h3>
              <p className="settings-block-desc">{t("settings.header.desc")}</p>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.header.favorites")}</span>
                <p className="settings-field-desc">{t("settings.header.favorites.desc")}</p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (favoritesButtonVisible ? " is-active" : "")}
                    onClick={() => onSetFavoritesButtonVisible(true)}
                  >
                    {t("common.show")}
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (!favoritesButtonVisible ? " is-active" : "")}
                    onClick={() => onSetFavoritesButtonVisible(false)}
                  >
                    {t("common.hide")}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>{t("settings.explorer.title")}</h3>
              <p className="settings-block-desc">{t("settings.explorer.desc")}</p>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.explorer.label")}</span>
                <p className="settings-field-desc">{t("settings.explorer.fieldDesc")}</p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (sidebarMode === "auto" ? " is-active" : "")}
                    onClick={() => onSetSidebarMode("auto")}
                  >
                    {t("sidebarMode.auto")}
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (sidebarMode === "docked" ? " is-active" : "")}
                    onClick={() => onSetSidebarMode("docked")}
                  >
                    {t("sidebarMode.docked")}
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (sidebarMode === "floating" ? " is-active" : "")}
                    onClick={() => onSetSidebarMode("floating")}
                  >
                    {t("sidebarMode.floating")}
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {section === "terminale" && (
          <>
            <section className="settings-block">
              <h3>{t("settings.textShell.title")}</h3>
              <p className="settings-block-desc">{t("settings.textShell.desc")}</p>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.zoom.label")}</span>
                <p className="settings-field-desc">{t("settings.zoom.desc")}</p>
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
              </div>
              {shellOptions.length > 0 && (
                <div className="settings-field">
                  <span className="settings-field-label">{t("settings.shell.label")}</span>
                  <p className="settings-field-desc">{t("settings.shell.desc")}</p>
                  <div className="settings-choice-row">
                    {shellOptions.map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={"settings-choice" + (shellId === opt.id ? " is-active" : "")}
                        onClick={() => setShellId(opt.id)}
                      >
                        {shellOptionLabel(opt)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.banner.label")}</span>
                <p className="settings-field-desc">{t("settings.banner.desc")}</p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (bannerEnabled ? " is-active" : "")}
                    onClick={() => setBannerEnabled(true)}
                  >
                    {t("common.show")}
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (!bannerEnabled ? " is-active" : "")}
                    onClick={() => setBannerEnabled(false)}
                  >
                    {t("common.hide")}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>{t("settings.startup.title")}</h3>
              <p className="settings-block-desc">{t("settings.startup.desc")}</p>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.startDir.label")}</span>
                <p className="settings-field-desc">{t("settings.startDir.desc")}</p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (!customPathMode ? " is-active" : "")}
                    onClick={() => setCustomPathMode(false)}
                  >
                    {t("settings.startDir.home")}
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (customPathMode ? " is-active" : "")}
                    onClick={() => setCustomPathMode(true)}
                  >
                    {t("settings.startDir.custom")}
                  </button>
                </div>
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
              </div>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.restore.label")}</span>
                <p className="settings-field-desc">{t("settings.restore.desc")}</p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (restoreSession ? " is-active" : "")}
                    onClick={() => setRestoreSession(true)}
                  >
                    {t("settings.restore.restore")}
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (!restoreSession ? " is-active" : "")}
                    onClick={() => setRestoreSession(false)}
                  >
                    {t("settings.restore.fresh")}
                  </button>
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.links.label")}</span>
                <p className="settings-field-desc">{t("settings.links.desc")}</p>
                <div className="settings-choice-row">
                  <button
                    type="button"
                    className={"settings-choice" + (confirmLinkOpen ? " is-active" : "")}
                    onClick={() => setConfirmLinkOpen(true)}
                  >
                    {t("settings.links.ask")}
                  </button>
                  <button
                    type="button"
                    className={"settings-choice" + (!confirmLinkOpen ? " is-active" : "")}
                    onClick={() => setConfirmLinkOpen(false)}
                  >
                    {t("settings.links.open")}
                  </button>
                </div>
              </div>
            </section>
          </>
        )}

        {section === "funzionalita" && (
          <FunzionalitaPage
            plugins={plugins}
            enabledIds={quickActionIds}
            onToggleEnabled={onToggleQuickAction}
            onAdd={onAddPlugin}
            onDelete={onDeletePlugin}
          />
        )}

        {section === "info" && (
          <>
            <section className="settings-block">
              <h3>{t("settings.version.title")}</h3>
              <p className="settings-block-desc">{pkg.description}</p>
              <div className="settings-field">
                <span className="settings-field-label">
                  {pkg.name} v{pkg.version}
                </span>
                <p className="settings-field-desc">{t("settings.version.copyDesc")}</p>
                <div className="settings-choice-row">
                  <button type="button" className="settings-choice" onClick={handleCopyVersionInfo}>
                    {versionCopied ? t("common.copied") : t("settings.version.copy")}
                  </button>
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.updates.label")}</span>
                <p className="settings-field-desc">
                  {t("settings.updates.desc")} {updateStatusText(updateStatus)}
                </p>
                <div className="settings-choice-row">
                  {updateStatus.kind === "available" || updateStatus.kind === "installing" ? (
                    <button type="button" className="settings-choice" onClick={openUpdateDialog}>
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
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>{t("settings.maintenance.title")}</h3>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.configDir.label")}</span>
                <p className="settings-field-desc">{t("settings.configDir.desc")}</p>
                <div className="settings-choice-row">
                  <button type="button" className="settings-choice" onClick={handleOpenConfigDir}>
                    {t("settings.configDir.open")}
                  </button>
                </div>
              </div>
              <div className="settings-field">
                <span className="settings-field-label">{t("settings.reset.label")}</span>
                <p className="settings-field-desc">{t("settings.reset.desc")}</p>
                <div className="settings-choice-row">
                  <button type="button" className="settings-choice" onClick={handleResetTerminal}>
                    {t("settings.reset.button")}
                  </button>
                </div>
              </div>
            </section>

            <section className="settings-block">
              <h3>{t("settings.credits.title")}</h3>
              <p className="settings-block-desc">{t("settings.credits.desc")}</p>
              <ul className="settings-credits-list">
                {CREDITS.map((c) => (
                  <li key={c.name} className="settings-credits-item">
                    <span className="settings-credits-name">{c.name}</span> — {t(c.use)}
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
