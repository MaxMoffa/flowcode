import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPdfTarget, type AgentOpen } from "../../shared/agentOpen";
import { checkPath } from "../lib/fileLinks";
import { toWindowsPath } from "../terminal/wslPath";
import { getBrowserSettings, type Target } from "./browserSettings";
import { isLocalUrl, normalizeLocalUrl, openFileInPreview, openUrlInPreview } from "./browserStore";
import type { ConfirmOptions } from "../dialog/ConfirmDialogContext";
import { t } from "../i18n";
import { isExecutablePath } from "../lib/filePaths";

export { commandCwd, createAgentOpenTracker, openCommandTarget, toolCommand } from "../../shared/agentOpen";

/** An agent opened `target`: shows it where the Browser settings say for that
 * kind. The caller waits for the call to complete (denied or failed ones never
 * get here). After a shell opener the system has already opened it - this can't
 * stop that, only add the panel when the settings say "in app". Flowcode's own
 * tool (`direct`) opened nothing yet. External destinations require the app's
 * confirmation even when an adapter skips its own permission request. */
export async function routeAgentOpen({ target, cwd, direct }: AgentOpen, distro: string | null, confirm?: (options: ConfirmOptions) => Promise<boolean>): Promise<void> {
  const settings = getBrowserSettings();
  // Flowcode's own tool opens a PDF in the built-in viewer whatever the setting says.
  const inPanel = (setting: Target) => setting === "app" || (direct && (setting === "ask" || isPdfTarget(target)));
  if (/^https?:\/\//i.test(target)) {
    const local = isLocalUrl(target);
    const setting = local ? settings.local : settings.external;
    // Some adapters never ask for MCP permission. The app still asks before network access.
    if (direct && !local && !(await confirm?.({ title: t("link.open"), message: target, confirmLabel: t(setting === "system" ? "link.open" : "link.openInPreview") }))) return;
    if (inPanel(setting)) openUrlInPreview(local ? normalizeLocalUrl(target) : target);
    else if (direct) openUrl(target).catch(() => {});
    return;
  }
  if (!direct && settings.artifacts !== "app") return;
  const path = distro && target.startsWith("/") ? toWindowsPath(distro, target) : target;
  const found = await checkPath(path, cwd);
  if (found?.kind !== "file") return;
  if (inPanel(settings.artifacts) || isExecutablePath(found.path)) openFileInPreview(found.path);
  else void invoke("open_with_default_app", { path: found.path }).catch(() => {});
}
