import { checkPath } from "../lib/fileLinks";
import { toWindowsPath } from "../terminal/wslPath";
import { getBrowserSettings } from "./browserSettings";
import { isLocalUrl, normalizeLocalUrl, openFileInPreview, openUrlInPreview } from "./browserStore";

export { commandCwd, openCommandTarget, toolCommand } from "../../shared/agentOpen";

/** An agent ran a command that opens `target` in the system: shows it in the
 * Browser panel too when the Browser settings say "in app" for that kind. The
 * caller waits for the command to complete (denied or failed ones never get
 * here); the system opener has already run - this can't stop it, only put the
 * page where the user asked for it. */
export async function routeAgentOpen(target: string, cwd: string, distro: string | null): Promise<void> {
  const settings = getBrowserSettings();
  if (/^https?:\/\//i.test(target)) {
    if ((isLocalUrl(target) ? settings.local : settings.external) === "app") openUrlInPreview(isLocalUrl(target) ? normalizeLocalUrl(target) : target);
    return;
  }
  if (settings.artifacts !== "app") return;
  const path = distro && target.startsWith("/") ? toWindowsPath(distro, target) : target;
  const found = await checkPath(path, cwd);
  if (found?.kind === "file") openFileInPreview(found.path);
}
