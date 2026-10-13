import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "../themes/ThemeContext";
import { PALETTES, findPalette, resolvePalette } from "../themes/palettes";
import { LANGUAGES, useI18n } from "../i18n";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { setNotificationEnabled, useNotificationSettings, type NotificationKind } from "../notifications/notificationSettings";
import { setAutoResumeEnabled, setAutoResumeMessage, useAutoResumeSettings } from "../agents/autoResumeSettings";
import { isRemoteLeader, useRemoteLeader } from "./leader";
import { isValidSetting, type SettingContext } from "./settingDefs";

/** Settings changes are coalesced: dragging a slider on the phone or the
 * desktop fires many in a row. */
const PUBLISH_DELAY_MS = 250;
const SETTING_CONTEXT: SettingContext = {
  languages: LANGUAGES.map((l) => l.code),
  hasPalette: (id) => findPalette(id) !== undefined,
};

/** Mirrors the settings the phone shows (see docs/remote-protocol.md) to the
 * remote-access backend and applies the changes the phone sends back. Only the
 * leader window publishes (see leader.ts). Renders nothing. */
export function RemoteSettingsBridge() {
  const { theme, mode, setMode, paletteId, setPaletteId, terminalPaletteId, setTerminalPaletteId, contrast, setContrast, glassOpacity, setGlassOpacity } =
    useTheme();
  const { language, preference, setPreference } = useI18n();
  const terminal = useTerminalSettings();
  const notify = useNotificationSettings();
  const autoResume = useAutoResumeSettings();
  const leader = useRemoteLeader();

  // Palettes only depend on the theme, not on what a tab's zoom does.
  const palettes = useMemo(() => {
    const palette = findPalette(paletteId) ?? PALETTES[0];
    const termPalette = findPalette(terminalPaletteId) ?? palette;
    return {
      colors: { bg: palette[theme].bg, ...resolvePalette(palette[theme], theme, contrast) },
      terminalColors: { bg: termPalette[theme].bg, ...resolvePalette(termPalette[theme], theme, contrast) },
      list: PALETTES.map((p) => ({ id: p.id, name: p.name, bg: p[theme].bg, accent: p[theme].accent, accent2: p[theme].accent2 })),
    };
  }, [theme, paletteId, terminalPaletteId, contrast]);

  // Primitives only: the context objects change identity on unrelated updates
  // (a tab's zoom), which must not republish.
  const { fontSize, bannerEnabled, confirmLinkOpen, restoreSession, newTabPage } = terminal;
  const { done, input, exited, limitReset } = notify;
  const { enabled: autoResumeEnabled, message: autoResumeMessage } = autoResume;
  const settings = useMemo(
    () => ({
      theme: mode,
      resolvedTheme: theme,
      palette: paletteId,
      terminalPalette: terminalPaletteId,
      contrast,
      glassOpacity,
      language: preference,
      resolvedLanguage: language,
      languages: LANGUAGES.map((l) => ({ id: l.code, name: l.name })),
      colors: palettes.colors,
      terminalColors: palettes.terminalColors,
      palettes: palettes.list,
      terminalFontSize: fontSize,
      bannerEnabled,
      confirmLinkOpen,
      restoreSession,
      newTabPage,
      notify: { done, input, exited, limitReset },
      autoResume: { enabled: autoResumeEnabled, message: autoResumeMessage },
    }),
    [
      theme, mode, paletteId, terminalPaletteId, contrast, glassOpacity, language, preference, palettes,
      fontSize, bannerEnabled, confirmLinkOpen, restoreSession, newTabPage,
      done, input, exited, limitReset, autoResumeEnabled, autoResumeMessage,
    ],
  );

  useEffect(() => {
    if (!leader) return;
    const timer = setTimeout(() => {
      if (isRemoteLeader()) invoke("remote_publish_settings", { settings }).catch(() => {});
    }, PUBLISH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [settings, leader]);

  // The listener is registered once; it always calls the latest setters.
  const apply = useRef<(key: string, value: unknown) => void>(() => {});
  apply.current = (key, value) => {
    // Unknown keys and bad values (including an unknown palette id) are dropped.
    if (!isValidSetting(key, value, SETTING_CONTEXT)) return;
    if (key.startsWith("notify.")) {
      setNotificationEnabled(key.slice("notify.".length) as NotificationKind, value as boolean);
      return;
    }
    switch (key) {
      case "theme":
        setMode(value as "auto" | "light" | "dark");
        break;
      case "palette":
        setPaletteId(value as string);
        break;
      case "terminalPalette":
        setTerminalPaletteId(value as string | null);
        break;
      case "contrast":
        setContrast(value as number);
        break;
      case "glassOpacity":
        setGlassOpacity(value as number);
        break;
      case "language":
        setPreference(value as typeof preference);
        break;
      case "terminalFontSize":
        terminal.setFontSize(value as number);
        break;
      case "bannerEnabled":
        terminal.setBannerEnabled(value as boolean);
        break;
      case "confirmLinkOpen":
        terminal.setConfirmLinkOpen(value as boolean);
        break;
      case "restoreSession":
        terminal.setRestoreSession(value as boolean);
        break;
      case "newTabPage":
        terminal.setNewTabPage(value as boolean);
        break;
      case "autoResume.enabled":
        setAutoResumeEnabled(value as boolean);
        break;
      case "autoResume.message":
        setAutoResumeMessage(value as string);
        break;
    }
  };

  useEffect(() => {
    const unlisten = listen<{ key: string; value: unknown }>("remote://set-setting", (e) => {
      apply.current(e.payload.key, e.payload.value);
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return null;
}
