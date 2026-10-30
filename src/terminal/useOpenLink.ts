import { useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isLocalUrl, normalizeLocalUrl, openUrlInPreview } from "../browser/browserStore";
import { useBrowserSettings } from "../browser/browserSettings";
import { useContextMenu } from "../context-menu/ContextMenuContext";
import { MenuIcons } from "../context-menu/menuIcons";
import { t } from "../i18n";

/** Opens a web link the way a click on a terminal link does: in the in-app
 * browser, in the system one, or from a small menu at the click - as the
 * Browser settings say for that kind of link (local server or external site).
 * Ctrl+Shift+click always goes to the system browser. Anything but http(s) is
 * ignored: OSC 8 hyperlinks can carry any scheme (file:, custom app
 * protocols...), which a click shouldn't hand to the OS. */
export function useOpenLink(): (
  event: { clientX: number; clientY: number; ctrlKey?: boolean; shiftKey?: boolean },
  uri: string,
) => void {
  const settings = useBrowserSettings();
  const { show: showMenu } = useContextMenu();
  return useCallback(
    (event, uri) => {
      if (!/^https?:\/\//i.test(uri)) return;
      const local = isLocalUrl(uri);
      const openSystem = () => {
        openUrl(uri).catch(() => {});
      };
      const openApp = () => openUrlInPreview(local ? normalizeLocalUrl(uri) : uri);
      if (event.ctrlKey && event.shiftKey) {
        openSystem();
        return;
      }
      const target = local ? settings.local : settings.external;
      if (target === "app") {
        openApp();
        return;
      }
      if (target === "system") {
        openSystem();
        return;
      }
      const shown = uri.length > 60 ? `${uri.slice(0, 57)}…` : uri;
      showMenu(event.clientX, event.clientY, [
        { label: shown, icon: MenuIcons.globe, disabled: true },
        { label: "link-separator", separator: true },
        { label: t("link.openInPreview"), icon: MenuIcons.globe, onSelect: openApp },
        { label: t("link.open"), icon: MenuIcons.openExternal, onSelect: openSystem },
        { label: t("link.copy"), icon: MenuIcons.link, onSelect: () => navigator.clipboard.writeText(uri).catch(() => {}) },
      ]);
    },
    [settings.local, settings.external, showMenu],
  );
}
