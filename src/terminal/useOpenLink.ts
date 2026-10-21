import { useCallback } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useContextMenu } from "../context-menu/ContextMenuContext";
import { MenuIcons } from "../context-menu/menuIcons";
import { t } from "../i18n";
import { useTerminalSettings } from "./TerminalSettingsContext";

/** Opens a web link the way a click on a terminal link does: in the browser
 * straight away, or - while "ask first" is on - from a small menu at the
 * click. Anything but http(s) is ignored: OSC 8 hyperlinks can carry any
 * scheme (file:, custom app protocols...), which a click shouldn't hand to
 * the OS. */
export function useOpenLink(): (event: { clientX: number; clientY: number }, uri: string) => void {
  const { confirmLinkOpen, setConfirmLinkOpen } = useTerminalSettings();
  const { show: showMenu } = useContextMenu();
  return useCallback(
    (event, uri) => {
      if (!/^https?:\/\//i.test(uri)) return;
      const open = () => {
        openUrl(uri).catch(() => {});
      };
      if (!confirmLinkOpen) {
        open();
        return;
      }
      const shown = uri.length > 60 ? `${uri.slice(0, 57)}…` : uri;
      showMenu(event.clientX, event.clientY, [
        { label: shown, icon: MenuIcons.globe, disabled: true },
        { label: "link-separator", separator: true },
        { label: t("link.open"), icon: MenuIcons.openExternal, onSelect: open },
        {
          label: t("link.openAlways"),
          icon: MenuIcons.checkCircle,
          onSelect: () => {
            setConfirmLinkOpen(false);
            open();
          },
        },
        { label: t("link.copy"), icon: MenuIcons.link, onSelect: () => navigator.clipboard.writeText(uri).catch(() => {}) },
      ]);
    },
    [confirmLinkOpen, setConfirmLinkOpen, showMenu],
  );
}
