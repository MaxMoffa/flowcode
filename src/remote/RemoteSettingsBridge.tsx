import { useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTheme } from "../themes/ThemeContext";
import { PALETTES, findPalette, resolvePalette } from "../themes/palettes";
import { LANGUAGES, useI18n } from "../i18n";
import { useTerminalSettings } from "../terminal/TerminalSettingsContext";
import { setNotificationEnabled, useNotificationSettings, type NotificationKind } from "../notifications/notificationSettings";
import { setAutoResumeEnabled, setAutoResumeMessage, useAutoResumeSettings } from "../agents/autoResumeSettings";
import { isRemoteLeader, useRemoteLeader } from "./leader";
import type { MirroredSettings, ProfileInfo } from "../../shared/remote-types";
import { isValidSetting, type SettingContext } from "./settingDefs";
import { parseProfileOp } from "./profileOps";
import { createProfile, deleteProfile, logoutProfile, refreshProfiles, updateProfile, useProfiles } from "../profiles/profiles";
import { defaultCliStatus } from "../agents/cliInfo";

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
  const { profiles, default_logged_in: defaultLoggedIn } = useProfiles();

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
  const settings: MirroredSettings = useMemo(
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

  // The profile list for the phone's Profili page. Login state is read off the
  // CLIs' files, so it is re-read when the window regains focus (the usual way
  // back from signing in) and for a while after the phone asked for a login.
  const profileList: ProfileInfo[] = useMemo(
    () => profiles.map((p) => ({ id: p.id, name: p.name, color: p.color, loggedIn: { claude: p.logged_in.claude, codex: p.logged_in.codex, vibe: p.logged_in.vibe } })),
    [profiles],
  );
  const defaultLogin = useMemo(
    () => (defaultLoggedIn ? { claude: defaultLoggedIn.claude, codex: defaultLoggedIn.codex, vibe: defaultLoggedIn.vibe } : null),
    [defaultLoggedIn],
  );
  useEffect(() => {
    if (!leader) return;
    if (isRemoteLeader()) invoke("remote_publish_profiles", { profiles: profileList, defaultLoggedIn: defaultLogin }).catch(() => {});
  }, [profileList, defaultLogin, leader]);

  useEffect(() => {
    if (!leader) return;
    const onFocus = () => void refreshProfiles();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [leader]);

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

  // Profile changes from the phone. The backend sends them to the leader window only; the check
  // here covers a role change in flight. Sign-in (`remote://profile-login`) is handled by App; sign-out has no confirm here, the phone asks.
  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().listen<unknown>("remote://profile", (e) => {
      if (!isRemoteLeader()) return;
      const op = parseProfileOp(e.payload);
      if (!op) return;
      const done =
        op.op === "create"
          ? createProfile(op.name, op.color, op.copySettings)
          : op.op === "update"
            ? updateProfile(op.id, op.name, op.color)
            : op.op === "delete"
              ? deleteProfile(op.id, op.deleteFiles)
              : op.op === "logout"
                ? logoutProfile(op.id, op.cli).then(() => {
                    // The shortcuts' cached sign-in check is the default profile's.
                    if (op.id === null) void defaultCliStatus(op.cli, true);
                  })
                : Promise.resolve();
      // A rejected name / color (duplicate, empty) leaves the list as it was.
      void done.catch(() => refreshProfiles());
    });
    return () => {
      unlisten.then((fn) => fn()).catch(() => {});
    };
  }, []);

  return null;
}
