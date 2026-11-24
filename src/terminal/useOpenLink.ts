import { createContext, useCallback, useContext } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isLocalUrl, normalizeLocalUrl, openUrlInPreview } from "../browser/browserStore";
import { useBrowserSettings } from "../browser/browserSettings";
import { useContextMenu } from "../context-menu/ContextMenuContext";
import { MenuIcons } from "../context-menu/menuIcons";
import { t } from "../i18n";

/** Where the links of a view come from another PC: its own addresses (a dev server on its localhost) are mapped to ones that work here (a tunnel). `null` = this PC's. */
export const LinkRewriteContext = createContext<((url: string) => Promise<string>) | null>(null);

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
  const rewrite = useContext(LinkRewriteContext);
  return useCallback(
    (event, uri) => {
      if (!/^https?:\/\//i.test(uri)) return;
      const local = isLocalUrl(uri);
      const openSystem = () => withRewrite(uri, rewrite, (u) => void openUrl(u).catch(() => {}));
      const openApp = () => withRewrite(uri, rewrite, (u) => openUrlInPreview(local ? normalizeLocalUrl(u) : u));
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
      showMenu(event.clientX, event.clientY, linkMenuItems(uri, rewrite));
    },
    [settings.local, settings.external, showMenu, rewrite],
  );
}

/** Runs `open` with `uri`, mapped first when the link comes from another PC (a failed mapping opens nothing: the page there is not this PC's). */
function withRewrite(uri: string, rewrite: ((url: string) => Promise<string>) | null, open: (url: string) => void) {
  if (!rewrite || !isLocalUrl(uri)) open(uri);
  else void rewrite(uri).then(open, () => {});
}

/** The link menu: open in the app, open in the system browser, copy. */
function linkMenuItems(uri: string, rewrite: ((url: string) => Promise<string>) | null = null) {
  const local = isLocalUrl(uri);
  const shown = uri.length > 60 ? `${uri.slice(0, 57)}…` : uri;
  return [
    { label: shown, icon: MenuIcons.globe, disabled: true },
    { label: "link-separator", separator: true },
    { label: t("link.openInPreview"), icon: MenuIcons.globe, onSelect: () => withRewrite(uri, rewrite, (u) => openUrlInPreview(local ? normalizeLocalUrl(u) : u)) },
    { label: t("link.open"), icon: MenuIcons.openExternal, onSelect: () => withRewrite(uri, rewrite, (u) => void openUrl(u).catch(() => {})) },
    { label: t("link.copy"), icon: MenuIcons.link, onSelect: () => void navigator.clipboard.writeText(uri).catch(() => {}) },
  ];
}

/** The link menu at a right click, whatever the Browser settings say for a left click. */
export function useLinkMenu(): (event: { clientX: number; clientY: number }, uri: string) => void {
  const { show: showMenu } = useContextMenu();
  const rewrite = useContext(LinkRewriteContext);
  return useCallback(
    (event, uri) => {
      if (!/^https?:\/\//i.test(uri)) return;
      showMenu(event.clientX, event.clientY, linkMenuItems(uri, rewrite));
    },
    [showMenu, rewrite],
  );
}
