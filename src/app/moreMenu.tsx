import { MonitorIcon, openHostMenu } from "../remoteHosts/HostSelector";
import type { ThemeMode } from "../themes/ThemeContext";
import type { ContextMenuItem } from "../context-menu/ContextMenuContext";
import { StarIcon, favoritesMenuItem } from "../favorites/FavoritesButton";
import { Icons } from "./icons";
import { ZoomRow } from "../terminal/ZoomRow";
import type { ShellCtx } from "./shellContext";

/** The header's "more options" menu. */
export function moreMenuItems(S: ShellCtx): ContextMenuItem[] {
  const {
    activeTerminal, activeTerminalId, hideMenu, isFullscreen, mode, noPairedHosts, openChangelog, openFavorite,
    openNewTab, openSettings, setMode, setPairingHost, setShortcutsDialogOpen, shellId, t, tabShell,
    toggleFullscreen,
  } = S;
  const themeModeLabels: Record<ThemeMode, string> = {
    auto: t("theme.auto"),
    light: t("theme.light"),
    dark: t("theme.dark"),
  };

  return [
    {
      label: "zoom-row",
      custom: <ZoomRow tabId={activeTerminalId} />,
    },
    { separator: true, label: "sep-zoom" },
    { label: t("menu.newTerminal"), icon: Icons.newTerminal, onSelect: () => openNewTab() },
    ...(noPairedHosts
      ? [{ label: t("remoteHosts.connectAnother"), icon: <MonitorIcon size={14} />, onSelect: () => setPairingHost(true) }]
      : [{ label: t("remoteHosts.switchPc"), icon: <MonitorIcon size={14} />, onSelect: openHostMenu }]),
    {
      label: isFullscreen ? t("menu.exitFullscreen") : t("menu.fullscreen"),
      icon: isFullscreen ? Icons.fullscreenExit : Icons.fullscreen,
      onSelect: toggleFullscreen,
    },
    {
      label: t("favorites.title"),
      icon: <StarIcon />,
      submenu: [
        favoritesMenuItem({
          activeCwd: activeTerminal && !activeTerminal.busy ? activeTerminal.cwd || undefined : undefined,
          activeShell: activeTerminal ? (tabShell(activeTerminal) ?? shellId) : undefined,
          onOpenFolder: openFavorite,
          hide: hideMenu,
        }),
      ],
    },
    { separator: true, label: "sep-actions" },
    {
      label: t("menu.theme"),
      icon: mode === "auto" ? Icons.themeAuto : mode === "light" ? Icons.sun : Icons.moon,
      submenu: (["auto", "light", "dark"] as ThemeMode[]).map((m) => ({
        label: themeModeLabels[m],
        icon: m === "auto" ? Icons.themeAuto : m === "light" ? Icons.sun : Icons.moon,
        checked: mode === m,
        onSelect: () => setMode(m),
      })),
    },
    { separator: true, label: "sep-theme" },
    { label: t("changelog.title"), icon: Icons.changelog, onSelect: openChangelog },
    { label: t("shortcuts.title"), icon: Icons.keyboard, onSelect: () => setShortcutsDialogOpen(true) },
    { label: t("settings.title"), icon: Icons.settings, onSelect: openSettings },
  ];
}
