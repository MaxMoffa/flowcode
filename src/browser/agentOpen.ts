import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { AgentOpen } from "../../shared/agentOpen";
import { checkPath } from "../lib/fileLinks";
import { toWindowsPath } from "../terminal/wslPath";
import { getBrowserSettings, type Target } from "./browserSettings";
import { isLocalUrl, normalizeLocalUrl, openFileInPreview, openUrlInPreview } from "./browserStore";

export { commandCwd, createAgentOpenTracker, openCommandTarget, toolCommand } from "../../shared/agentOpen";

/** An agent opened `target`: shows it where the Browser settings say for that
 * kind. The caller waits for the call to complete (denied or failed ones never
 * get here). After a shell opener the system has already opened it - this can't
 * stop that, only add the panel when the settings say "in app". Flowcode's own
 * tool (`direct`) opened nothing yet, so Flowcode opens it, in the panel when
 * the setting is "ask": there is no click to anchor the question to, and the
 * panel is the contained choice for a page the agent picked. */
export async function routeAgentOpen({ target, cwd, direct }: AgentOpen, distro: string | null): Promise<void> {
  const settings = getBrowserSettings();
  const inPanel = (setting: Target) => setting === "app" || (direct && setting === "ask");
  if (/^https?:\/\//i.test(target)) {
    const local = isLocalUrl(target);
    const setting = local ? settings.local : settings.external;
    if (inPanel(setting)) openUrlInPreview(local ? normalizeLocalUrl(target) : target);
    else if (direct) openUrl(target).catch(() => {});
    return;
  }
  if (!direct && settings.artifacts !== "app") return;
  const path = distro && target.startsWith("/") ? toWindowsPath(distro, target) : target;
  const found = await checkPath(path, cwd);
  if (found?.kind !== "file") return;
  if (inPanel(settings.artifacts)) openFileInPreview(found.path);
  else void invoke("open_with_default_app", { path: found.path }).catch(() => {});
}
