import { checkPath } from "../lib/fileLinks";
import { toWindowsPath } from "../terminal/wslPath";
import { getBrowserSettings } from "./browserSettings";
import { isLocalUrl, isPreviewableFile, normalizeLocalUrl, openFileInPreview, openUrlInPreview } from "./browserStore";

// A shell command that hands something to the OS opener: `start`, `open`, `xdg-open`, `explorer`, `Start-Process`...
// The opener must be a command of its own (start of line, after `;` `&` `|` `(`, or opening a `-Command "..."` / `-c '...'` script), not a word inside a quoted argument like `git commit -m "open x.html"`.
const OPENER_RE = /(?:^|[;&|(\n]|-(?:Command|c|lc)\s+["'])\s*(?:cmd(?:\.exe)?\s+\/c\s+)?(?:sudo\s+)?(?:start|open|xdg-open|wslview|explorer(?:\.exe)?|Start-Process|Invoke-Item|ii)\s+([^;&|\r\n]+)/gi;
const TOKEN_RE = /"([^"]*)"|'([^']*)'|(\S+)/g;
const CD_RE = /^\s*cd\s+(?:\/d\s+)?(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))\s*(?:&&|;)/;

/** The directory the command runs in: the chat's `cwd`, moved by a leading `cd dir &&`. */
export function commandCwd(command: string, cwd: string): string {
  const m = command.match(CD_RE);
  const dir = m && (m[1] ?? m[2] ?? m[3]);
  if (!dir || dir === "~" || dir.startsWith("~/") || dir.startsWith("$")) return cwd;
  if (dir.startsWith("/") || /^[a-z]:[\\/]/i.test(dir)) return dir;
  return `${cwd.replace(/[\\/]+$/, "")}/${dir}`;
}

/** The file or web page a shell command asks the OS to open, or null. Only what
 * the Browser panel can show counts: an http(s) URL or a previewable file. */
export function openCommandTarget(command: string): string | null {
  for (const m of command.matchAll(OPENER_RE)) {
    for (const tok of m[1].matchAll(TOKEN_RE)) {
      const value = tok[1] ?? tok[2] ?? tok[3] ?? "";
      if (!value || value.startsWith("-") || /^\/[a-z]$/i.test(value)) continue;
      if (/^https?:\/\//i.test(value) || isPreviewableFile(value)) return value;
    }
  }
  return null;
}

/** The command of a Bash-like tool call update, if it has one yet (the first update often carries no input). */
export function toolCommand(update: Record<string, unknown>): string | null {
  const input = update.rawInput as { command?: unknown } | null | undefined;
  return input && typeof input === "object" && typeof input.command === "string" ? input.command : null;
}

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
