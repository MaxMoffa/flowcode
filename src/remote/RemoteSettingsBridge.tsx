import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "../themes/ThemeContext";
import { PALETTES, findPalette, resolvePalette } from "../themes/palettes";
import { LANGUAGES, useI18n } from "../i18n";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { setNotificationEnabled, useNotificationSettings, type NotificationKind } from "../notifications/notificationSettings";
import { setAutoResumeEnabled, setAutoResumeMessage, useAutoResumeSettings } from "../agents/autoResumeSettings";

/** Settings changes are coalesced: dragging a slider on the phone or the
 * desktop fires many in a row. */
const PUBLISH_DELAY_MS = 250;
const MAX_MESSAGE_LENGTH = 500;
const THEME_MODES = ["auto", "light", "dark"];
const NOTIFY_KINDS: readonly string[] = ["done", "input", "exited", "limitReset"];

const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Mirrors the settings the phone shows (see docs/remote-protocol.md) to the
 * remote-access backend and applies the changes the phone sends back. Renders
 * nothing. */
export function RemoteSettingsBridge() {
  const { theme, mode, setMode, paletteId, setPaletteId, terminalPaletteId, setTerminalPaletteId, contrast, setContrast, glassOpacity, setGlassOpacity } =
    useTheme();
  const { language, preference, setPreference } = useI18n();
  const terminal = useTerminalSettings();
  const notify = useNotificationSettings();
  const autoResume = useAutoResumeSettings();

  const settings = useMemo(() => {
    const palette = findPalette(paletteId) ?? PALETTES[0];
    const termPalette = findPalette(terminalPaletteId) ?? palette;
    return {
      theme: mode,
      resolvedTheme: theme,
      palette: paletteId,
      terminalPalette: terminalPaletteId,
      contrast,
      glassOpacity,
      language: preference,
      resolvedLanguage: language,
      languages: LANGUAGES.map((l) => ({ id: l.code, name: l.name })),
      colors: { bg: palette[theme].bg, ...resolvePalette(palette[theme], theme, contrast) },
      terminalColors: { bg: termPalette[theme].bg, ...resolvePalette(termPalette[theme], theme, contrast) },
      palettes: PALETTES.map((p) => ({ id: p.id, name: p.name, bg: p[theme].bg, accent: p[theme].accent, accent2: p[theme].accent2 })),
      terminalFontSize: terminal.fontSize,
      bannerEnabled: terminal.bannerEnabled,
      confirmLinkOpen: terminal.confirmLinkOpen,
      restoreSession: terminal.restoreSession,
      newTabPage: terminal.newTabPage,
      notify: { done: notify.done, input: notify.input, exited: notify.exited, limitReset: notify.limitReset },
      autoResume: { enabled: autoResume.enabled, message: autoResume.message },
    };
  }, [theme, mode, paletteId, terminalPaletteId, contrast, glassOpacity, language, preference, terminal, notify, autoResume]);

  useEffect(() => {
    const timer = setTimeout(() => {
      invoke("remote_publish_settings", { settings }).catch(() => {});
    }, PUBLISH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [settings]);

  // The listener is registered once; it always calls the latest setters.
  const apply = useRef<(key: string, value: unknown) => void>(() => {});
  apply.current = (key, value) => {
    if (key.startsWith("notify.")) {
      const kind = key.slice("notify.".length);
      if (NOTIFY_KINDS.includes(kind) && isBool(value)) setNotificationEnabled(kind as NotificationKind, value);
      return;
    }
    switch (key) {
      case "theme":
        if (typeof value === "string" && THEME_MODES.includes(value)) setMode(value as "auto" | "light" | "dark");
        break;
      case "palette":
        if (typeof value === "string") setPaletteId(value);
        break;
      case "terminalPalette":
        if (value === null || typeof value === "string") setTerminalPaletteId(value);
        break;
      case "contrast":
        if (isNum(value)) setContrast(value);
        break;
      case "glassOpacity":
        if (isNum(value)) setGlassOpacity(value);
        break;
      case "language":
        if (typeof value === "string" && (value === "system" || LANGUAGES.some((l) => l.code === value))) {
          setPreference(value as typeof preference);
        }
        break;
      case "terminalFontSize":
        if (isNum(value)) terminal.setFontSize(value);
        break;
      case "bannerEnabled":
        if (isBool(value)) terminal.setBannerEnabled(value);
        break;
      case "confirmLinkOpen":
        if (isBool(value)) terminal.setConfirmLinkOpen(value);
        break;
      case "restoreSession":
        if (isBool(value)) terminal.setRestoreSession(value);
        break;
      case "newTabPage":
        if (isBool(value)) terminal.setNewTabPage(value);
        break;
      case "autoResume.enabled":
        if (isBool(value)) setAutoResumeEnabled(value);
        break;
      case "autoResume.message":
        if (typeof value === "string" && value.length <= MAX_MESSAGE_LENGTH) setAutoResumeMessage(value);
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
